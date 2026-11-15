// pi-worktree — Pi extension: do the work in an isolated git worktree, merge when done.
//
// Depends on: wt (worktrunk) >= 0.81 in PATH. https://worktrunk.dev
//
// Workflow:
//   1. On startup, if Pi's cwd is a git checkout that is NOT already inside a
//      linked worktree, create one branched from the current branch's upstream
//      (falling back to the remote default branch, then the current branch).
//      The directory comes from the worktree path template (see README); the
//      default is <primary worktree>/.worktrees/<sanitized branch>.
//   2. Project hooks from <repo>/.config/wt.toml run during creation, exactly as
//      they do for a manual `wt switch` — copying local config, trusting mise,
//      warming the Go module cache, and so on.
//   3. When the agent settles, ask once whether to `wt merge` the branch back —
//      but only when the worktree actually carries work (commits or uncommitted
//      files). /wt-merge triggers the merge manually, /wt-status shows state.
//
// Design notes:
//   - State is persisted per Pi session under <git-common-dir>/pi-worktree/, so
//     /reload (which tears down and rebuilds extension modules) re-attaches to
//     the same worktree instead of creating a duplicate, and two Pi sessions in
//     one repo never clobber each other's record.
//   - Creation runs only on reason === "startup"; reload/new/resume/fork re-attach.
//   - Every error path fails open: an extension bug must never block the session.

import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir, hostname } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import type {
  AgentSettledEvent,
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionShutdownEvent,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent"

export interface WorktreeState {
  branch: string // the created branch, e.g. "pi/20261111-161745-x1y2"
  path: string // absolute worktree directory
  base: string // base ref used at creation, e.g. "origin/main"
  target: string // local merge target, e.g. "main"
  pathSource: string // where the directory template came from (diagnostics)
  /** True when the base is a remote-tracking ref (origin/main), false for a local branch. */
  baseIsRemote?: boolean
  /**
   * Untracked paths that already existed once the worktree was set up — project
   * hook output (copied local config, warm caches, marker files). They are not
   * the agent's work, so they must not trigger the merge prompt.
   */
  baseline?: string[]
  createdAt: number
  /** PID of the session that created the worktree; absent in records written before 0.3.0. */
  pid?: number
  /** Host the session ran on. Liveness is only probeable on the same host. */
  host?: string
  /** Last time the owning session touched this record, for the stale cutoff. */
  lastSeen?: number
}

/** Resolved extension configuration (layered: built-in < user < project < env). */
interface WtWorktreeConfig {
  /** Path template, or null for the built-in default. */
  worktreePath: string | null
  /** Run <repo>/.config/wt.toml project hooks during creation (default true). */
  hooks: boolean
  /** Ask before running `wt merge` once the agent settles (default true). */
  mergePrompt: boolean
  /** Remove worktrees whose owning session is gone and that hold no work (default true). */
  reap: boolean
  /** Budget for worktree creation; project hooks can be slow (default 15 min). */
  createTimeoutMs: number
}

interface ProjectHook {
  type: string
  name: string
  needsApproval: boolean
}

const SECTION_NAME = "wt_worktree"
const STATE_DIR_NAME = "pi-worktree"
// WHY: the default keeps worktrees out of the primary checkout. A sibling `.wt`
// directory leaves `git status`, IDE indexing and repo-wide scans untouched, and
// makes cleanup a single `rm -rf`, instead of a special case the repo has to
// exclude everywhere.
const DEFAULT_PATH_TEMPLATE = "{{ repo_parent }}/.wt/{{ repo }}-{{ branch | sanitize }}"
const DEFAULT_CREATE_TIMEOUT_MS = 900_000
// Section names are validated against /^[a-z][a-z0-9_-]*$/ by the system-prompt builder.

/** Run git in a fixed directory and return the raw exec result. */
function git(pi: ExtensionAPI, cwd: string, args: string[]) {
  return pi.exec("git", args, { cwd, timeout: 15_000 })
}

/** Parse a JSON string without throwing. */
function safeJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

/** First line of a command's stderr/stdout, trimmed, for compact error messages. */
function firstLine(text: string | undefined): string {
  return (text ?? "").trim().split("\n")[0]?.trim() ?? ""
}

/** Fire-and-forget notification; never throws, no-op when there is no UI. */
function notify(ctx: ExtensionContext, msg: string, level: "info" | "warning" | "error" = "info") {
  try {
    if (ctx.hasUI) ctx.ui.notify(msg, level)
  } catch {
    // fail open
  }
}

/** File-system and branch-name safe form of a branch name ("pi/20260101-ab" -> "pi-20260101-ab"). */
export function sanitize(name: string): string {
  return name
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
}

/** Render the {{ var }} / {{ var | sanitize }} template syntax used by the path setting. */
export function renderTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{\s*([\w.]+)\s*(?:\|\s*(\w+)\s*)?\}\}/g, (_m, name: string, filter?: string) => {
    const raw = vars[name] ?? vars[name.replace(/\./g, "_")] ?? ""
    return filter === "sanitize" ? sanitize(raw) : raw
  })
}

/** Read a JSON config file, tolerating absence and syntax errors. */
function readConfigFile(path: string): Partial<WtWorktreeConfig> | null {
  try {
    if (!existsSync(path)) return null
    const parsed = safeJson<Record<string, unknown>>(readFileSync(path, "utf8"))
    if (!parsed) {
      console.error(`[pi-worktree] ignoring unparsable config: ${path}`)
      return null
    }
    const out: Partial<WtWorktreeConfig> = {}
    // Accept both the flat keys and a {"wtWorktree": {...}} wrapper, so the same
    // file can also carry settings for other extensions.
    const scoped = (parsed.wtWorktree ?? parsed) as Record<string, unknown>
    if (typeof scoped.worktreePath === "string") out.worktreePath = scoped.worktreePath
    if (typeof scoped.hooks === "boolean") out.hooks = scoped.hooks
    if (typeof scoped.mergePrompt === "boolean") out.mergePrompt = scoped.mergePrompt
    if (typeof scoped.reap === "boolean") out.reap = scoped.reap
    if (typeof scoped.createTimeoutMs === "number") out.createTimeoutMs = scoped.createTimeoutMs
    return out
  } catch {
    return null
  }
}

/** True when Pi's cwd is inside a git repository. */
async function isGitRepo(pi: ExtensionAPI, cwd: string): Promise<boolean> {
  return (await git(pi, cwd, ["rev-parse", "--git-dir"])).code === 0
}

/** Absolute path to this checkout's own git dir (differs from the common dir in a linked worktree). */
async function gitDir(pi: ExtensionAPI, cwd: string): Promise<string | null> {
  const res = await git(pi, cwd, ["rev-parse", "--path-format=absolute", "--git-dir"])
  if (res.code !== 0) return null
  const dir = res.stdout.trim()
  return dir ? (isAbsolute(dir) ? dir : resolve(cwd, dir)) : null
}

/** Absolute path to the repo's shared .git directory (works from linked worktrees too). */
async function gitCommonDir(pi: ExtensionAPI, cwd: string): Promise<string | null> {
  const res = await git(pi, cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
  if (res.code !== 0) return null
  const dir = res.stdout.trim()
  return dir ? (isAbsolute(dir) ? dir : resolve(cwd, dir)) : null
}

/**
 * Root of the primary worktree — the directory holding .git, i.e. "the project".
 * Derived from the common dir so it is identical from any linked worktree.
 */
async function primaryWorktree(pi: ExtensionAPI, cwd: string): Promise<string | null> {
  const common = await gitCommonDir(pi, cwd)
  if (common) {
    const base = dirname(common)
    // A bare repo has no working tree; --show-toplevel is the better answer there.
    const check = await git(pi, base, ["rev-parse", "--is-bare-repository"])
    if (check.code !== 0 || check.stdout.trim() !== "true") return base
  }
  const top = await git(pi, cwd, ["rev-parse", "--show-toplevel"])
  if (top.code === 0 && top.stdout.trim()) return top.stdout.trim()
  return null
}

/** True when cwd is a linked worktree rather than the primary checkout. */
async function inLinkedWorktree(pi: ExtensionAPI, cwd: string): Promise<boolean> {
  const own = await gitDir(pi, cwd)
  const common = await gitCommonDir(pi, cwd)
  if (!own || !common) return false
  return resolve(own) !== resolve(common)
}

/** First configured git remote, or null. */
async function firstRemote(pi: ExtensionAPI, cwd: string): Promise<string | null> {
  const res = await git(pi, cwd, ["remote"])
  if (res.code !== 0) return null
  const name = res.stdout.trim().split("\n")[0]?.trim()
  return name || null
}

/** Local branch name of a remote-tracking ref ("origin/main" -> "main"). */
function shortOf(ref: string): string {
  const idx = ref.indexOf("/")
  return idx === -1 ? ref : ref.slice(idx + 1)
}

/**
 * Default branch for `remote`, verified to exist as `<remote>/<branch>`.
 * Uses wt's own resolution first (it reads the right symref/config), then
 * git symbolic-ref, then main/master candidates.
 */
async function defaultBranch(pi: ExtensionAPI, cwd: string, remote: string): Promise<string> {
  const exists = async (name: string) =>
    (await git(pi, cwd, ["rev-parse", "--verify", `${remote}/${name}`])).code === 0

  const list = await pi.exec("wt", ["list", "--format", "json"], { cwd, timeout: 10_000 })
  if (list.code === 0) {
    const def = safeJson<{ repo?: { default_branch?: string } }>(list.stdout)?.repo?.default_branch
    if (def) return def
  }

  const sym = await git(pi, cwd, ["symbolic-ref", `refs/remotes/${remote}/HEAD`])
  if (sym.code === 0) {
    const m = sym.stdout.trim().match(/refs\/remotes\/[^/]+\/(.+)$/)
    if (m?.[1]) return m[1]
  }

  for (const cand of ["main", "master"]) {
    if (await exists(cand)) return cand
  }
  return "main" // last resort; wt switch will surface a clear error if it's wrong
}

/**
 * Determine the base ref for the new worktree: the current branch's remote
 * upstream, else the remote default branch, else the current branch.
 * Returns null when nothing usable exists (e.g. detached HEAD with no remote).
 */
async function resolveBase(
  pi: ExtensionAPI,
  cwd: string,
): Promise<{ base: string; target: string; baseIsRemote: boolean } | null> {
  const up = await git(pi, cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
  if (up.code === 0 && up.stdout.trim()) {
    const base = up.stdout.trim()
    // @{u} is a remote-tracking ref by definition (origin/main, upstream/main).
    return { base, target: shortOf(base), baseIsRemote: true }
  }

  const remote = await firstRemote(pi, cwd)
  if (remote) {
    const def = await defaultBranch(pi, cwd, remote)
    return { base: `${remote}/${def}`, target: def, baseIsRemote: true }
  }

  // No remote at all: base and target are the same local branch.
  const head = await git(pi, cwd, ["rev-parse", "--abbrev-ref", "HEAD"])
  const cur = head.stdout.trim()
  if (cur && cur !== "HEAD") return { base: cur, target: cur, baseIsRemote: false }
  return null
}

/**
 * "remote origin/master" or "local feature/x": branch names may contain a slash,
 * so the role is decided by git, not by the shape of the name.
 */
export async function refLabel(pi: ExtensionAPI, cwd: string, ref: string, isRemote?: boolean): Promise<string> {
  if (isRemote === true) return `remote ${ref}`
  if (isRemote === false) return `local ${ref}`
  const remote = await git(pi, cwd, ["rev-parse", "--verify", "--quiet", `refs/remotes/${ref}`])
  return remote.code === 0 ? `remote ${ref}` : `local ${ref}`
}

const STATUS_KEY = "wt-worktree"

/** Footer status: local worktree branch, the base it came from, and the local merge target. */
export async function statusLine(pi: ExtensionAPI, st: WorktreeState, work?: PendingWork | null): Promise<string> {
  const base = await refLabel(pi, st.path, st.base, st.baseIsRemote)
  const parts = [`wt · local ${st.branch}`, `← ${base}`, `→ local ${st.target}`]
  if (work) parts.push(describeWork(work))
  return parts.join(" ")
}

/** Publish the status line, or clear it when there is no worktree. */
async function updateStatus(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  st: WorktreeState | null,
  work?: PendingWork | null,
): Promise<void> {
  if (!ctx.hasUI) return
  try {
    if (!st) ctx.ui.setStatus(STATUS_KEY, undefined)
    else ctx.ui.setStatus(STATUS_KEY, await statusLine(pi, st, work))
  } catch {
    // status is cosmetic; never fail the session over it
  }
}

/** Unique, readable branch name: pi/<YYYYMMDD-HHMMSS>-<rand4>. */
function makeBranchName(now = new Date()): string {
  const p = (n: number, l = 2) => String(n).padStart(l, "0")
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  const rand = Math.random().toString(36).slice(2, 6)
  return `pi/${stamp}-${rand}`
}

/** Hooks that fire while a worktree is created, so we can preview them. */
const CREATE_HOOK_TYPES = new Set(["pre-switch", "post-switch", "pre-start", "post-start"])

/** Project hooks configured in <repo>/.config/wt.toml (empty when wt cannot read them). */
async function projectHooks(pi: ExtensionAPI, cwd: string): Promise<ProjectHook[]> {
  const res = await pi.exec("wt", ["hook", "show", "--format", "json"], { cwd, timeout: 10_000 })
  if (res.code !== 0) return []
  const all = safeJson<Array<ProjectHook & { source?: string }>>(res.stdout) ?? []
  return all.filter((h) => h.source === "project" && CREATE_HOOK_TYPES.has(h.type))
}

/** One-line description of the project hooks that creation will run. */
function describeHooks(hooks: ProjectHook[]): string {
  if (hooks.length === 0) return ""
  const names = hooks.map((h) => `${h.type}:${h.name}`).join(", ")
  const approvals = hooks.filter((h) => h.needsApproval).length
  return `${hooks.length} project hook(s) from .config/wt.toml (${names})${approvals ? `, ${approvals} not yet approved` : ""}`
}

/**
 * Resolve the worktree directory template. Precedence:
 *   env PI_WT_WORKTREE_PATH > <repo>/.pi/wt-worktree.json > ~/.pi/agent/wt-worktree.json > default.
 * Returns the template plus a label describing where it came from.
 */
async function resolvePathTemplate(
  projectRoot: string,
  config: WtWorktreeConfig,
): Promise<{ template: string; source: string }> {
  const env = process.env.PI_WT_WORKTREE_PATH?.trim()
  if (env) return { template: env, source: "env PI_WT_WORKTREE_PATH" }

  const project = readConfigFile(join(projectRoot, ".pi", "wt-worktree.json"))?.worktreePath
  if (project) return { template: project, source: ".pi/wt-worktree.json" }

  const user = readConfigFile(join(homedir(), ".pi", "agent", "wt-worktree.json"))?.worktreePath
  if (user) return { template: user, source: "~/.pi/agent/wt-worktree.json" }

  if (config.worktreePath) return { template: config.worktreePath, source: "config" }
  return { template: DEFAULT_PATH_TEMPLATE, source: "default" }
}

/** Concrete worktree directory for `branch` from a path template. */
export function worktreePathFor(template: string, projectRoot: string, cwd: string, branch: string): string {
  const parent = dirname(projectRoot)
  const rendered = renderTemplate(template, {
    repo_path: projectRoot,
    primary_worktree_path: projectRoot,
    repo_parent: parent,
    primary_worktree_parent: parent,
    repo: projectRoot.split("/").pop() ?? "repo",
    branch,
    branch_sanitized: sanitize(branch),
  })
  // resolve() normalizes `..` in absolute templates and anchors relative ones.
  return resolve(cwd, rendered)
}

function stateDir(commonDir: string): string {
  return join(commonDir, STATE_DIR_NAME)
}

function stateFile(commonDir: string, sessionId: string): string {
  return join(stateDir(commonDir), `${sanitize(sessionId) || "session"}.json`)
}

/** A worktree exists if its path still contains a .git marker (file or dir). */
function worktreeExists(st: WorktreeState): boolean {
  try {
    return existsSync(join(st.path, ".git"))
  } catch {
    return false
  }
}

/** How long a record may go untouched before its session counts as gone. */
export const DEFAULT_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000

/** Liveness probe for a PID. Signal 0 checks without touching the process. */
export type PidProbe = (pid: number) => boolean

export const defaultPidProbe: PidProbe = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: the process exists, it just belongs to another user.
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

/**
 * Whether the session that owns a record is still running.
 *
 * Three answers, in order of trust: a own-host PID is authoritative, a foreign
 * host cannot be probed at all, and a record without a PID can only come from a
 * writer older than this version — never from the session asking.
 */
export function sessionAlive(
  st: Pick<WorktreeState, "pid" | "host" | "createdAt" | "lastSeen">,
  opts: { host?: string; probe?: PidProbe; now?: number; staleAfterMs?: number } = {},
): boolean {
  const now = opts.now ?? Date.now()
  const staleAfter = opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS
  // WHY: records written by 0.2.x and earlier carry no pid; every record this
  // version writes does. A pid-less record therefore belongs to nobody who is
  // running now, and treating it as dead is what lets the first startup after
  // the upgrade clear the leftovers that motivated this.
  if (typeof st.pid !== "number" || !Number.isInteger(st.pid) || st.pid <= 0) return false
  const seen = st.lastSeen ?? st.createdAt
  // A live pid that has not touched the record for a week is a reused pid.
  if (typeof seen === "number" && now - seen > staleAfter) return false
  // Another machine: cannot probe it, so assume the session is alive.
  if (st.host && st.host !== (opts.host ?? hostname())) return true
  return (opts.probe ?? defaultPidProbe)(st.pid)
}

export type ReapAction = "none" | "drop-record" | "remove-worktree" | "keep"

export interface ReapProbe {
  exists: boolean
  alive: boolean
  work: PendingWork | null
}

/**
 * What to do with one persisted record.
 *
 * Removing a worktree is only ever allowed when the owning session is gone AND
 * the worktree holds nothing: commits or uncommitted files are a merge decision
 * for a human, not garbage. `work: null` means the counts could not be read, so
 * it is treated as work rather than as nothing.
 */
export function reapDecision(p: ReapProbe): ReapAction {
  if (!p.exists) return "drop-record"
  if (p.alive) return "none"
  return hasWork(p.work) || p.work === null ? "keep" : "remove-worktree"
}

function readStateRecord(path: string): WorktreeState | null {
  try {
    const st = JSON.parse(readFileSync(path, "utf8")) as WorktreeState
    if (st && typeof st.path === "string" && typeof st.branch === "string") return st
    return null
  } catch {
    return null
  }
}

/** Every persisted record in this repo, whether or not its worktree still exists. */
export function listStates(commonDir: string): Array<{ file: string; st: WorktreeState | null }> {
  let files: string[]
  try {
    files = readdirSync(stateDir(commonDir))
  } catch {
    return []
  }
  return files
    .filter((f) => f.endsWith(".json"))
    .map((file) => ({ file, st: readStateRecord(join(stateDir(commonDir), file)) }))
}

async function readState(pi: ExtensionAPI, cwd: string, sessionId: string): Promise<WorktreeState | null> {
  const common = await gitCommonDir(pi, cwd)
  if (!common) return null
  return readStateRecord(stateFile(common, sessionId))
}

async function writeState(pi: ExtensionAPI, cwd: string, sessionId: string, st: WorktreeState): Promise<void> {
  const common = await gitCommonDir(pi, cwd)
  if (!common) return
  try {
    mkdirSync(stateDir(common), { recursive: true })
    writeFileSync(stateFile(common, sessionId), JSON.stringify(st, null, 2))
  } catch {
    // state persistence is best-effort; the worktree itself still works
  }
}

async function removeState(pi: ExtensionAPI, cwd: string, sessionId: string): Promise<void> {
  const common = await gitCommonDir(pi, cwd)
  if (!common) return
  try {
    unlinkSync(stateFile(common, sessionId))
  } catch {
    // already gone
  }
}

/** Other *live* sessions' worktrees in this repo, for the leftover warning. */
async function otherSessionWorktrees(pi: ExtensionAPI, cwd: string, sessionId: string): Promise<string[]> {
  const common = await gitCommonDir(pi, cwd)
  if (!common) return []
  const own = `${sanitize(sessionId) || "session"}.json`
  return listStates(common)
    .filter(({ file, st }) => file !== own && !!st && worktreeExists(st) && sessionAlive(st))
    .map(({ st }) => (st as WorktreeState).branch)
}

/**
 * `wt remove <branch>`, deliberately without `--force` or `--force-delete`: wt
 * itself refuses a worktree that is dirty or on an unmerged branch, which is the
 * second safety net behind reapDecision.
 */
async function removeWorktree(pi: ExtensionAPI, cwd: string, branch: string) {
  const root = (await primaryWorktree(pi, cwd)) ?? cwd
  return pi.exec("wt", ["remove", branch, "-y", "--format", "json"], { cwd: root, timeout: 120_000 })
}

export interface ReapReport {
  /** What happened (or would happen, in a dry run) per record, oldest record first. */
  entries: ReapEntry[]
  /** Branches whose worktree was removed. */
  removed: string[]
  /** Records deleted because their worktree directory no longer exists. */
  dropped: number
  /** Branches left over from dropped records that were not safe to delete. */
  orphanBranches: string[]
  /** Abandoned worktrees left alone because they hold work. */
  kept: string[]
  /** Abandoned worktrees wt refused to remove; the record stays for the next try. */
  failed: string[]
}

/** One record and its verdict, for the dry-run listing. */
export interface ReapEntry {
  branch: string
  path: string
  action: ReapAction
  work: PendingWork | null
  note: string
}

/** True when a local branch of that name exists. */
async function branchExists(pi: ExtensionAPI, cwd: string, branch: string): Promise<boolean> {
  return (await git(pi, cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0
}

/**
 * Reclaim what dead sessions left behind: forget records whose directory is gone,
 * remove abandoned worktrees that hold nothing, keep the ones that hold work.
 * With `dryRun` nothing is touched and `entries` says what would happen.
 */
export async function reapAbandoned(
  pi: ExtensionAPI,
  cwd: string,
  sessionId: string,
  opts: { dryRun?: boolean } = {},
): Promise<ReapReport> {
  const dry = opts.dryRun === true
  const report: ReapReport = { entries: [], removed: [], dropped: 0, orphanBranches: [], kept: [], failed: [] }
  const common = await gitCommonDir(pi, cwd)
  if (!common) return report
  const own = `${sanitize(sessionId) || "session"}.json`
  let pruned = false
  for (const { file, st } of listStates(common)) {
    if (file === own) continue
    const record = join(stateDir(common), file)
    if (!st || !worktreeExists(st)) {
      if (!dry) {
        try {
          unlinkSync(record)
        } catch {
          // already gone
        }
      }
      report.dropped++
      pruned = true
      // The directory is gone, the branch usually is not. `-d` only deletes a
      // branch whose commits are already reachable; an unmerged one survives and
      // is reported instead, so a vanished checkout can never lose work.
      const branchKept =
        !dry && st
          ? (await git(pi, cwd, ["branch", "-d", st.branch])).code !== 0 && (await branchExists(pi, cwd, st.branch))
          : false
      if (branchKept && st) report.orphanBranches.push(st.branch)
      report.entries.push({
        branch: st?.branch ?? file.replace(/\.json$/, ""),
        path: st?.path ?? "?",
        action: "drop-record",
        work: null,
        note: branchKept ? "directory gone, branch kept (unmerged)" : "directory gone",
      })
      continue
    }
    if (sessionAlive(st)) {
      report.entries.push({
        branch: st.branch,
        path: st.path,
        action: "none",
        work: null,
        note: "session alive",
      })
      continue
    }
    const work = await pendingWork(pi, st)
    const action = reapDecision({ exists: true, alive: false, work })
    if (action !== "remove-worktree") {
      report.kept.push(st.branch)
      report.entries.push({
        branch: st.branch,
        path: st.path,
        action: "keep",
        work,
        note: work ? describeWork(work) : "work could not be counted",
      })
      continue
    }
    if (dry) {
      report.removed.push(st.branch)
      report.entries.push({ branch: st.branch, path: st.path, action: "remove-worktree", work, note: "empty" })
      continue
    }
    const res = await removeWorktree(pi, cwd, st.branch)
    if (res.code !== 0) {
      report.failed.push(st.branch)
      report.entries.push({
        branch: st.branch,
        path: st.path,
        action: "remove-worktree",
        work,
        note: `wt remove failed: ${firstLine(res.stderr) || firstLine(res.stdout) || "unknown error"}`,
      })
      continue
    }
    try {
      unlinkSync(record)
    } catch {
      // already gone
    }
    report.removed.push(st.branch)
    report.entries.push({ branch: st.branch, path: st.path, action: "remove-worktree", work, note: "empty" })
  }
  // A vanished directory leaves its admin entry behind in .git/worktrees.
  if (pruned && !dry) await git(pi, cwd, ["worktree", "prune"])
  return report
}

/** One-line summary of a reap pass, or null when nothing happened. */
function describeReap(r: ReapReport): string | null {
  const parts: string[] = []
  if (r.dropped > 0) parts.push(`forgot ${r.dropped} record(s) whose worktree is gone`)
  if (r.removed.length > 0) parts.push(`removed ${r.removed.length} unused worktree(s) (${r.removed.join(", ")})`)
  if (r.orphanBranches.length > 0) parts.push(`kept unmerged branch(es) ${r.orphanBranches.join(", ")}`)
  return parts.length > 0 ? parts.join("; ") : null
}

/** Per-record listing for `/wt-clean`, one line each. */
export function describeReapEntries(r: ReapReport, dryRun: boolean): string[] {
  const verb: Record<ReapAction, string> = {
    none: "in use",
    "drop-record": dryRun ? "forget record" : "forgot record",
    "remove-worktree": dryRun ? "would remove" : "removed",
    keep: "kept",
  }
  return r.entries.map((e) => `${verb[e.action]}  ${e.branch}  (${e.note})`)
}

/** Look up a just-created branch's worktree path via `wt list` (fallback when switch JSON is unreadable). */
async function findWorktreePath(pi: ExtensionAPI, cwd: string, branch: string): Promise<string | null> {
  const res = await pi.exec("wt", ["list", "--format", "json"], { cwd, timeout: 10_000 })
  if (res.code !== 0) return null
  const list = safeJson<{ items?: Array<{ branch?: string; worktree?: { path?: string } }> }>(res.stdout)
  for (const item of list?.items ?? []) {
    if (item.branch === branch && item.worktree?.path) return item.worktree.path
  }
  return null
}

/** Commits and uncommitted files the worktree carries on top of its base. */
export interface PendingWork {
  commits: number
  files: number
}

/**
 * One `git status --porcelain -z` entry. With -z the format is `XY <path>\0`, and
 * a rename or copy is followed by the source path as its own record.
 */
interface StatusEntry {
  code: string
  file: string
}

/** Parse `git status --porcelain -z` output into entries. */
export function parseStatus(raw: string): StatusEntry[] {
  const out: StatusEntry[] = []
  const parts = raw.split("\0")
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i] ?? ""
    if (entry.length < 4) continue // "XY path"
    const code = entry.slice(0, 2)
    const file = entry.slice(3)
    if (code.includes("R") || code.includes("C")) i++ // the source path follows
    out.push({ code, file })
  }
  return out
}

/**
 * Untracked paths in the worktree, as `git status --porcelain -z` reports them.
 * Used to remember what the project hooks put there before the agent started.
 */
export async function untrackedPaths(pi: ExtensionAPI, path: string): Promise<string[]> {
  const res = await git(pi, path, ["status", "--porcelain", "-z", "--untracked-files=all"])
  if (res.code !== 0) return []
  return parseStatus(res.stdout)
    .filter((e) => e.code === "??")
    .map((e) => e.file)
}

/** True when `file` was already untracked before the agent started working. */
export function isBaseline(st: WorktreeState, file: string): boolean {
  return (st.baseline ?? []).some((b) => b === file || file.startsWith(b.endsWith("/") ? b : `${b}/`))
}

/** Commits on HEAD that the base ref does not have. */
async function countCommits(pi: ExtensionAPI, st: WorktreeState): Promise<number> {
  const ahead = await git(pi, st.path, ["rev-list", "--count", `${st.base}..HEAD`])
  if (ahead.code === 0) return Number.parseInt(ahead.stdout.trim(), 10) || 0

  // base may be gone (deleted remote branch); fall back to the merge base.
  const mb = await git(pi, st.path, ["merge-base", "HEAD", st.target])
  if (mb.code !== 0 || !mb.stdout.trim()) return 0
  const c = await git(pi, st.path, ["rev-list", "--count", `${mb.stdout.trim()}..HEAD`])
  return c.code === 0 ? Number.parseInt(c.stdout.trim(), 10) || 0 : 0
}

/**
 * Changed files, ignoring untracked ones that the project hooks produced.
 * Hook output (copied local config, warm caches, marker files) is untracked in
 * projects that do not gitignore it, and it is not the agent's work.
 */
async function countFiles(pi: ExtensionAPI, st: WorktreeState): Promise<number> {
  const status = await git(pi, st.path, ["status", "--porcelain", "-z", "--untracked-files=all"])
  if (status.code !== 0) return 0
  return parseStatus(status.stdout).filter((e) => !(e.code === "??" && isBaseline(st, e.file))).length
}

/** Count what a merge would carry; null when the counts cannot be determined. */
export async function pendingWork(pi: ExtensionAPI, st: WorktreeState): Promise<PendingWork | null> {
  if (!worktreeExists(st)) return null
  const [commits, files] = await Promise.all([countCommits(pi, st), countFiles(pi, st)])
  return { commits, files }
}

export function hasWork(w: PendingWork | null): boolean {
  return !!w && (w.commits > 0 || w.files > 0)
}

/** Identity of a pending-work snapshot, so the same amount is not offered twice. */
export function workSignature(w: PendingWork | null): string {
  return w ? `${w.commits}:${w.files}` : "unknown"
}

/**
 * Whether to ask about merging now. Nothing pending never asks, and an amount the
 * user already declined is not offered again — but a session holds several turns,
 * so once the pending work grows the question comes back.
 */
export function shouldOfferMerge(work: PendingWork | null, askedFor: string | null): boolean {
  return hasWork(work) && workSignature(work) !== askedFor
}

/** Human summary of pending work, e.g. "2 commits, 3 uncommitted files". */
function describeWork(w: PendingWork): string {
  const parts: string[] = []
  if (w.commits > 0) parts.push(`${w.commits} commit${w.commits === 1 ? "" : "s"}`)
  if (w.files > 0) parts.push(`${w.files} uncommitted file${w.files === 1 ? "" : "s"}`)
  return parts.join(", ") || "nothing"
}

/** Resolve config by layering user file, project file, then env overrides. */
async function loadConfig(pi: ExtensionAPI, cwd: string): Promise<WtWorktreeConfig> {
  const cfg: WtWorktreeConfig = {
    worktreePath: null,
    hooks: true,
    mergePrompt: true,
    reap: true,
    createTimeoutMs: DEFAULT_CREATE_TIMEOUT_MS,
  }
  const projectRoot = await primaryWorktree(pi, cwd)
  const layers = [
    readConfigFile(join(homedir(), ".pi", "agent", "wt-worktree.json")),
    projectRoot ? readConfigFile(join(projectRoot, ".pi", "wt-worktree.json")) : null,
  ]
  for (const layer of layers) {
    if (!layer) continue
    if (layer.worktreePath !== undefined) cfg.worktreePath = layer.worktreePath
    if (layer.hooks !== undefined) cfg.hooks = layer.hooks
    if (layer.mergePrompt !== undefined) cfg.mergePrompt = layer.mergePrompt
    if (layer.reap !== undefined) cfg.reap = layer.reap
    if (layer.createTimeoutMs !== undefined) cfg.createTimeoutMs = layer.createTimeoutMs
  }

  const envHooks = process.env.PI_WT_WORKTREE_HOOKS?.trim().toLowerCase()
  if (envHooks) cfg.hooks = !["0", "false", "no", "off"].includes(envHooks)
  const envPrompt = process.env.PI_WT_WORKTREE_MERGE_PROMPT?.trim().toLowerCase()
  if (envPrompt) cfg.mergePrompt = !["0", "false", "no", "off"].includes(envPrompt)
  const envReap = process.env.PI_WT_WORKTREE_REAP?.trim().toLowerCase()
  if (envReap) cfg.reap = !["0", "false", "no", "off"].includes(envReap)
  const envTimeout = Number.parseInt(process.env.PI_WT_WORKTREE_TIMEOUT_MS ?? "", 10)
  if (Number.isFinite(envTimeout) && envTimeout > 0) cfg.createTimeoutMs = envTimeout

  return cfg
}

interface SessionRef {
  sessionId: string
}

/** Create the worktree for a fresh startup and remember it. */
async function setup(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  session: SessionRef,
  setState: (st: WorktreeState | null) => void,
): Promise<void> {
  const cwd = ctx.cwd
  if (!(await isGitRepo(pi, cwd))) {
    setState(null)
    return
  }

  // Starting Pi inside a worktree means the isolation decision was already made.
  if (await inLinkedWorktree(pi, cwd)) {
    notify(ctx, `pi-worktree: already inside a worktree (${cwd}) — not creating another`, "info")
    setState(null)
    return
  }

  const projectRoot = await primaryWorktree(pi, cwd)
  if (!projectRoot) {
    setState(null)
    return
  }

  const config = await loadConfig(pi, cwd)
  const base = await resolveBase(pi, cwd)
  if (!base) {
    notify(ctx, "pi-worktree: could not determine a base branch (no remote and no branch?)", "warning")
    setState(null)
    return
  }

  // Reclaim what dead sessions left behind before adding another worktree.
  if (config.reap) {
    const reap = await reapAbandoned(pi, cwd, session.sessionId)
    const done = describeReap(reap)
    if (done) notify(ctx, `pi-worktree: ${done}`, "info")
    if (reap.kept.length > 0) {
      notify(
        ctx,
        `pi-worktree: ${reap.kept.length} abandoned worktree(s) still hold work: ${reap.kept.join(", ")} — "wt merge" or "wt remove" them`,
        "warning",
      )
    }
    if (reap.failed.length > 0) {
      notify(
        ctx,
        `pi-worktree: could not remove ${reap.failed.join(", ")} — uncommitted changes or a process still using it`,
        "warning",
      )
    }
  }

  // Warn about leftover worktrees instead of silently stacking them.
  const prev = await readState(pi, cwd, session.sessionId)
  if (prev && worktreeExists(prev)) {
    notify(ctx, `pi-worktree: previous worktree "${prev.branch}" still exists — manage with wt list / wt remove`, "info")
  }
  const others = await otherSessionWorktrees(pi, cwd, session.sessionId)
  if (others.length > 0) {
    notify(ctx, `pi-worktree: ${others.length} other live pi worktree(s) in this repo: ${others.join(", ")}`, "info")
  }

  const branch = makeBranchName()
  const { template, source } = await resolvePathTemplate(projectRoot, config)
  const path = worktreePathFor(template, projectRoot, cwd, branch)

  // Project hooks are part of creation: without them the new worktree has no
  // local config and no warm Go/module caches, so the agent starts cold.
  const hooks = config.hooks ? await projectHooks(pi, projectRoot) : []
  const hookNote = describeHooks(hooks)
  const baseLabel = await refLabel(pi, cwd, base.base, base.baseIsRemote)
  notify(
    ctx,
    `pi-worktree: creating local branch "${branch}" from ${baseLabel}, merge target local "${base.target}" — at ${path}` +
      (hookNote ? ` — running ${hookNote}` : ""),
    "info",
  )

  const args = [
    "switch",
    "--create",
    branch,
    "--base",
    base.base,
    "--path",
    path,
    "--no-cd",
    "-y",
    "--format",
    "json",
  ]
  if (!config.hooks) args.splice(args.indexOf("--format"), 0, "--no-hooks")

  const res = await pi.exec("wt", args, { cwd, timeout: config.createTimeoutMs })
  if (res.code !== 0) {
    notify(
      ctx,
      `pi-worktree: failed to create worktree: ${firstLine(res.stderr) || firstLine(res.stdout) || "unknown error"}`,
      "error",
    )
    setState(null)
    return
  }

  let createdPath = safeJson<{ path?: string }>(res.stdout)?.path ?? null
  if (!createdPath) createdPath = await findWorktreePath(pi, cwd, branch)
  if (!createdPath) {
    notify(ctx, `pi-worktree: created branch "${branch}" but could not resolve its worktree path`, "error")
    setState(null)
    return
  }

  const st: WorktreeState = {
    branch,
    path: createdPath,
    base: base.base,
    target: base.target,
    baseIsRemote: base.baseIsRemote,
    pathSource: source,
    baseline: await untrackedPaths(pi, createdPath),
    createdAt: Date.now(),
    pid: process.pid,
    host: hostname(),
    lastSeen: Date.now(),
  }
  setState(st)
  await writeState(pi, cwd, session.sessionId, st)
  notify(ctx, `pi-worktree: ready — local ${branch} @ ${createdPath} (path from ${source})`, "info")
  await updateStatus(ctx, pi, st)
}

/** System-prompt section text that directs the agent into the worktree. */
export function buildSection(st: WorktreeState): string {
  const baseRole = st.baseIsRemote === false ? "local branch" : "remote-tracking branch"
  return [
    "The pi-worktree extension created an isolated git worktree for this session. Make ALL changes inside it:",
    `- Worktree: ${st.path}`,
    `- Local branch: ${st.branch} (created for this session, no upstream — do not push it)`,
    `- Base: ${st.base}, a ${baseRole}; it is only the diff base, commit onto the local branch`,
    `- Merge target: ${st.target}, a local branch; the extension fast-forwards it when merging`,
    `Use absolute paths under the worktree for read/write/edit tools, and run shell commands with 'cd ${st.path} && ...'.`,
    `Do NOT run git merge, rebase, or wt merge yourself. When the task is done, the extension asks whether to merge "${st.branch}" into "${st.target}".`,
  ].join("\n")
}

/** Run `wt merge` for the worktree and report the outcome. */
async function doMerge(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  session: SessionRef,
  st: WorktreeState,
  setState: (st: WorktreeState | null) => void,
  setMerging: (v: boolean) => void,
): Promise<void> {
  if (!worktreeExists(st)) {
    notify(ctx, `pi-worktree: worktree for local "${st.branch}" is already gone — clearing state`, "warning")
    setState(null)
    await removeState(pi, ctx.cwd, session.sessionId)
    await updateStatus(ctx, pi, null)
    return
  }

  setMerging(true)
  try {
    // target is explicit so a non-default base (e.g. origin/feature-x) merges back to feature-x.
    const res = await pi.exec(
      "wt",
      ["merge", "--branch", st.branch, st.target, "-y", "--format", "json"],
      { cwd: st.path, timeout: 600_000 },
    )
    const j = safeJson<{ removed?: boolean; target?: string }>(res.stdout)
    if (res.code === 0 && j) {
      notify(
        ctx,
        `pi-worktree: merged "${st.branch}" into ${j.target ?? st.target}${j.removed ? ", worktree removed" : ""}`,
        "info",
      )
      setState(null)
      await removeState(pi, ctx.cwd, session.sessionId)
      await updateStatus(ctx, pi, null)
    } else {
      notify(
        ctx,
        `pi-worktree: wt merge failed: ${firstLine(res.stderr) || firstLine(res.stdout) || "unknown error"}`,
        "error",
      )
    }
  } catch (err) {
    notify(ctx, `pi-worktree: merge error: ${err instanceof Error ? err.message : String(err)}`, "error")
  } finally {
    setMerging(false)
  }
}

/** Ask the user whether to merge, then merge if confirmed. Returns what was offered. */
async function askMerge(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  session: SessionRef,
  st: WorktreeState,
  setState: (st: WorktreeState | null) => void,
  setMerging: (v: boolean) => void,
): Promise<PendingWork | null> {
  if (!ctx.hasUI) return null // cannot prompt in print/json mode; leave the worktree for the user

  const work = await pendingWork(pi, st)
  const detail = work ? describeWork(work) : "unknown changes"
  const baseLabel = await refLabel(pi, st.path, st.base, st.baseIsRemote)
  const ok = await ctx.ui.confirm(
    "wt merge?",
    `Merge local branch "${st.branch}" into local branch "${st.target}"? (${detail}; base ${baseLabel}) ` +
      "This squashes + rebases + fast-forwards the local target, then removes the worktree.",
  )
  if (ok) {
    await doMerge(pi, ctx, session, st, setState, setMerging)
  } else {
    notify(ctx, `pi-worktree: kept local "${st.branch}". Run /wt-merge later to merge.`, "info")
  }
  return work
}

export default async function (pi: ExtensionAPI) {
  // Probe the dependency at load time; disable cleanly when wt is missing.
  const probe = await pi.exec("wt", ["--version"], { timeout: 5_000 })
  if (probe.code !== 0) {
    let reported = false
    pi.on("session_start", (_event: SessionStartEvent, ctx: ExtensionContext) => {
      if (reported) return
      reported = true
      notify(ctx, "pi-worktree: wt (worktrunk) not found in PATH — extension disabled", "warning")
    })
    return
  }

  let state: WorktreeState | null = null
  // What the user was already offered and declined, as "commits:files". A session
  // usually holds several turns: asking once and then going silent would bury the
  // worktree forever, so a change in the pending work asks again.
  let askedFor: string | null = null
  let emptyNotified = false // announce "nothing to merge" once per idle streak
  let merging = false // re-entrancy guard
  const session: SessionRef = { sessionId: "default" }

  const setState = (st: WorktreeState | null) => {
    state = st
    askedFor = null
    emptyNotified = false
  }
  const setMerging = (v: boolean) => {
    merging = v
  }

  pi.on("session_start", async (event: SessionStartEvent, ctx: ExtensionContext) => {
    try {
      try {
        session.sessionId = ctx.sessionManager.getSessionId()
      } catch {
        // older runtimes have no session manager; the fixed id keeps a single slot
      }
      if (event.reason === "startup") {
        await setup(pi, ctx, session, setState)
        return
      }
      // reload/new/resume/fork: re-attach to the persisted worktree so the merge
      // prompt (and /wt-merge) keep working after a /reload rebuilds this module.
      const st = await readState(pi, ctx.cwd, session.sessionId)
      setState(st && worktreeExists(st) ? st : null)
      await updateStatus(ctx, pi, state)
    } catch (err) {
      console.error("[pi-worktree] session_start error:", err)
    }
  })

  pi.on("before_agent_start", async (event: BeforeAgentStartEvent, ctx: ExtensionContext) => {
    if (!state) return
    event.systemPromptOptions.sections[SECTION_NAME] = buildSection(state)
    // post-start hooks are spawned in the background by wt, so they may land
    // after the snapshot taken at creation. Widen the baseline before the agent
    // touches anything; files it creates from here on still count as work.
    try {
      const known = new Set(state.baseline ?? [])
      for (const file of await untrackedPaths(pi, state.path)) known.add(file)
      state.baseline = [...known]
      state.lastSeen = Date.now()
      await writeState(pi, ctx.cwd, session.sessionId, state)
    } catch (err) {
      console.error("[pi-worktree] baseline refresh error:", err)
    }
    await updateStatus(ctx, pi, state, await pendingWork(pi, state))
  })

  pi.on("agent_settled", async (event: AgentSettledEvent, ctx: ExtensionContext) => {
    try {
      if (event.aborted) return // an aborted run is not "task complete"
      if (!state || merging) return
      if (!worktreeExists(state)) {
        setState(null)
        await removeState(pi, ctx.cwd, session.sessionId)
        return
      }

      // Nothing was produced: a merge would be a no-op, so do not interrupt.
      const work = await pendingWork(pi, state)
      await updateStatus(ctx, pi, state, work)
      if (!hasWork(work)) {
        if (!emptyNotified) {
          emptyNotified = true
          notify(ctx, `pi-worktree: no changes on local "${state.branch}" — nothing to merge`, "info")
        }
        return
      }
      emptyNotified = false
      if (!ctx.hasUI) return
      if (!shouldOfferMerge(work, askedFor)) return // already offered exactly this much
      askedFor = workSignature(work)
      await askMerge(pi, ctx, session, state, setState, setMerging)
    } catch (err) {
      console.error("[pi-worktree] agent_settled error:", err)
    }
  })

  pi.on("session_shutdown", async (event: SessionShutdownEvent, ctx: ExtensionContext) => {
    // reload/new/resume/fork hand the session to a successor that re-attaches to
    // the same worktree, so only a real quit may reclaim anything.
    if (event.reason !== "quit" || !state || merging) return
    const st = state
    try {
      if (!worktreeExists(st)) {
        await removeState(pi, ctx.cwd, session.sessionId)
        setState(null)
        return
      }
      const config = await loadConfig(pi, ctx.cwd)
      const work = await pendingWork(pi, st)
      if (!config.reap || hasWork(work) || work === null) {
        // Keep the work and the record: the next startup reports it as abandoned.
        await writeState(pi, ctx.cwd, session.sessionId, { ...st, lastSeen: Date.now() })
        return
      }
      const res = await removeWorktree(pi, ctx.cwd, st.branch)
      if (res.code !== 0) return // record stays; the next startup retries
      await removeState(pi, ctx.cwd, session.sessionId)
      setState(null)
    } catch (err) {
      console.error("[pi-worktree] session_shutdown error:", err)
    }
  })

  pi.registerCommand("wt-merge", {
    description: "Merge the current wt worktree branch back into its base branch",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      if (merging) {
        notify(ctx, "pi-worktree: merge already in progress", "info")
        return
      }
      if (!state) {
        notify(ctx, "pi-worktree: no active worktree", "warning")
        return
      }
      askedFor = workSignature(await pendingWork(pi, state))
      await askMerge(pi, ctx, session, state, setState, setMerging)
    },
  })

  pi.registerCommand("wt-clean", {
    description: "List worktrees left behind by dead sessions; add --apply to reclaim them",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const apply = /(^|\s)(--apply|--yes|-y)(\s|$)/.test(args)
      if (merging) {
        notify(ctx, "pi-worktree: merge in progress — nothing reclaimed", "warning")
        return
      }
      const report = await reapAbandoned(pi, ctx.cwd, session.sessionId, { dryRun: !apply })
      const lines = describeReapEntries(report, !apply).filter((l) => !l.startsWith("in use"))
      if (state) lines.push(`in use  ${state.branch}  (this session, never touched)`)
      if (lines.length === 0) {
        notify(ctx, "pi-worktree: nothing to reclaim", "info")
        return
      }
      notify(
        ctx,
        [
          apply ? "pi-worktree: reclaimed" : "pi-worktree: dry run — pass --apply to act",
          ...lines,
        ].join("\n"),
        "info",
      )
    },
  })

  pi.registerCommand("wt-status", {
    description: "Show the current wt worktree state",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      if (!state) {
        notify(ctx, "pi-worktree: no active worktree", "info")
        return
      }
      const work = await pendingWork(pi, state)
      const baseLabel = await refLabel(pi, state.path, state.base, state.baseIsRemote)
      notify(
        ctx,
        [
          `local branch : ${state.branch}`,
          `worktree     : ${state.path}`,
          `base ref     : ${baseLabel} (diff base only)`,
          `merge target : local ${state.target}`,
          `pending      : ${work ? describeWork(work) : "unknown changes"}`,
          `path source  : ${state.pathSource}`,
        ].join("\n"),
        "info",
      )
    },
  })
}
