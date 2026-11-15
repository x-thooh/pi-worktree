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
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import type {
  AgentSettledEvent,
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent"

export interface WorktreeState {
  branch: string // the created branch, e.g. "pi/20261111-161745-x1y2"
  path: string // absolute worktree directory
  base: string // base ref used at creation, e.g. "origin/main"
  target: string // local merge target, e.g. "main"
  pathSource: string // where the directory template came from (diagnostics)
  createdAt: number
}

/** Resolved extension configuration (layered: built-in < user < project < env). */
interface WtWorktreeConfig {
  /** Path template, or null for the built-in default. */
  worktreePath: string | null
  /** Run <repo>/.config/wt.toml project hooks during creation (default true). */
  hooks: boolean
  /** Ask before running `wt merge` once the agent settles (default true). */
  mergePrompt: boolean
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
const DEFAULT_PATH_TEMPLATE = "{{ repo_path }}/.worktrees/{{ branch | sanitize }}"
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
async function resolveBase(pi: ExtensionAPI, cwd: string): Promise<{ base: string; target: string } | null> {
  const up = await git(pi, cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
  if (up.code === 0 && up.stdout.trim()) {
    const base = up.stdout.trim()
    return { base, target: shortOf(base) }
  }

  const remote = await firstRemote(pi, cwd)
  if (remote) {
    const def = await defaultBranch(pi, cwd, remote)
    return { base: `${remote}/${def}`, target: def }
  }

  const head = await git(pi, cwd, ["rev-parse", "--abbrev-ref", "HEAD"])
  const cur = head.stdout.trim()
  if (cur && cur !== "HEAD") return { base: cur, target: cur }
  return null
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
  pi: ExtensionAPI,
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
  const rendered = renderTemplate(template, {
    repo_path: projectRoot,
    primary_worktree_path: projectRoot,
    repo: projectRoot.split("/").pop() ?? "repo",
    branch,
    branch_sanitized: sanitize(branch),
  })
  return isAbsolute(rendered) ? rendered : resolve(cwd, rendered)
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

async function readState(pi: ExtensionAPI, cwd: string, sessionId: string): Promise<WorktreeState | null> {
  const common = await gitCommonDir(pi, cwd)
  if (!common) return null
  try {
    const st = JSON.parse(readFileSync(stateFile(common, sessionId), "utf8")) as WorktreeState
    if (st && typeof st.path === "string" && typeof st.branch === "string") return st
    return null
  } catch {
    return null
  }
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

/** Other sessions' live worktrees in this repo, for the leftover warning. */
async function otherSessionWorktrees(pi: ExtensionAPI, cwd: string, sessionId: string): Promise<string[]> {
  const common = await gitCommonDir(pi, cwd)
  if (!common) return []
  const dir = stateDir(common)
  try {
    const own = `${sanitize(sessionId)}.json`
    const out: string[] = []
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".json") || file === own) continue
      const st = safeJson<WorktreeState>(readFileSync(join(dir, file), "utf8"))
      if (st?.branch && worktreeExists(st)) out.push(st.branch)
    }
    return out
  } catch {
    return []
  }
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

/** Count what a merge would carry; null when the counts cannot be determined. */
export async function pendingWork(pi: ExtensionAPI, st: WorktreeState): Promise<PendingWork | null> {
  if (!worktreeExists(st)) return null

  let commits = 0
  const ahead = await git(pi, st.path, ["rev-list", "--count", `${st.base}..HEAD`])
  if (ahead.code === 0) commits = Number.parseInt(ahead.stdout.trim(), 10) || 0
  else {
    // base may be gone (deleted remote branch); fall back to the merge base.
    const mb = await git(pi, st.path, ["merge-base", "HEAD", st.target])
    if (mb.code === 0 && mb.stdout.trim()) {
      const c = await git(pi, st.path, ["rev-list", "--count", `${mb.stdout.trim()}..HEAD`])
      if (c.code === 0) commits = Number.parseInt(c.stdout.trim(), 10) || 0
    }
  }

  const status = await git(pi, st.path, ["status", "--porcelain"])
  const files = status.code === 0 ? status.stdout.split("\n").filter((l) => l.trim()).length : 0

  return { commits, files }
}

export function hasWork(w: PendingWork | null): boolean {
  return !!w && (w.commits > 0 || w.files > 0)
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
    if (layer.createTimeoutMs !== undefined) cfg.createTimeoutMs = layer.createTimeoutMs
  }

  const envHooks = process.env.PI_WT_WORKTREE_HOOKS?.trim().toLowerCase()
  if (envHooks) cfg.hooks = !["0", "false", "no", "off"].includes(envHooks)
  const envPrompt = process.env.PI_WT_WORKTREE_MERGE_PROMPT?.trim().toLowerCase()
  if (envPrompt) cfg.mergePrompt = !["0", "false", "no", "off"].includes(envPrompt)
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

  // Warn about leftover worktrees instead of silently stacking them.
  const prev = await readState(pi, cwd, session.sessionId)
  if (prev && worktreeExists(prev)) {
    notify(ctx, `pi-worktree: previous worktree "${prev.branch}" still exists — manage with wt list / wt remove`, "info")
  }
  const others = await otherSessionWorktrees(pi, cwd, session.sessionId)
  if (others.length > 0) {
    notify(ctx, `pi-worktree: ${others.length} other pi worktree(s) in this repo: ${others.join(", ")}`, "info")
  }

  const branch = makeBranchName()
  const { template, source } = await resolvePathTemplate(pi, projectRoot, config)
  const path = worktreePathFor(template, projectRoot, cwd, branch)

  // Project hooks are part of creation: without them the new worktree has no
  // local config and no warm Go/module caches, so the agent starts cold.
  const hooks = config.hooks ? await projectHooks(pi, projectRoot) : []
  const hookNote = describeHooks(hooks)
  notify(
    ctx,
    `pi-worktree: creating "${branch}" (base ${base.base}) at ${path}${hookNote ? ` — running ${hookNote}` : ""}`,
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
    pathSource: source,
    createdAt: Date.now(),
  }
  setState(st)
  await writeState(pi, cwd, session.sessionId, st)
  notify(ctx, `pi-worktree: ready — ${branch} @ ${createdPath} (base ${base.base}, path from ${source})`, "info")
}

/** System-prompt section text that directs the agent into the worktree. */
function buildSection(st: WorktreeState): string {
  return [
    "The pi-worktree extension created an isolated git worktree for this session. Make ALL changes inside it:",
    `- Worktree: ${st.path}`,
    `- Branch: ${st.branch} (branched from ${st.base})`,
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
    notify(ctx, `pi-worktree: worktree "${st.branch}" is already gone — clearing state`, "warning")
    setState(null)
    await removeState(pi, ctx.cwd, session.sessionId)
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

/** Ask the user whether to merge, then merge if confirmed. */
async function askMerge(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  session: SessionRef,
  st: WorktreeState,
  setState: (st: WorktreeState | null) => void,
  setMerging: (v: boolean) => void,
): Promise<void> {
  if (!ctx.hasUI) return // cannot prompt in print/json mode; leave the worktree for the user

  const work = await pendingWork(pi, st)
  const detail = work ? describeWork(work) : "unknown changes"
  const ok = await ctx.ui.confirm(
    "wt merge?",
    `Merge "${st.branch}" into ${st.target}? (${detail}) This squashes + rebases + fast-forwards the branch, then removes the worktree.`,
  )
  if (ok) {
    await doMerge(pi, ctx, session, st, setState, setMerging)
  } else {
    notify(ctx, `pi-worktree: kept worktree "${st.branch}". Run /wt-merge later to merge.`, "info")
  }
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
  let mergePrompted = false // ask at most once per worktree; /wt-merge stays available
  let merging = false // re-entrancy guard
  const session: SessionRef = { sessionId: "default" }

  const setState = (st: WorktreeState | null) => {
    state = st
    if (st) mergePrompted = false
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
      state = st && worktreeExists(st) ? st : null
      mergePrompted = false
    } catch (err) {
      console.error("[pi-worktree] session_start error:", err)
    }
  })

  pi.on("before_agent_start", (event: BeforeAgentStartEvent) => {
    if (!state) return
    event.systemPromptOptions.sections[SECTION_NAME] = buildSection(state)
  })

  pi.on("agent_settled", async (event: AgentSettledEvent, ctx: ExtensionContext) => {
    try {
      if (event.aborted) return // an aborted run is not "task complete"
      if (!state || mergePrompted || merging) return
      if (!worktreeExists(state)) {
        setState(null)
        await removeState(pi, ctx.cwd, session.sessionId)
        return
      }

      // Nothing was produced: a merge would be a no-op, so do not interrupt.
      const work = await pendingWork(pi, state)
      if (!hasWork(work)) {
        mergePrompted = true
        notify(ctx, `pi-worktree: no changes in "${state.branch}" — nothing to merge`, "info")
        return
      }
      if (!ctx.hasUI) return
      mergePrompted = true
      await askMerge(pi, ctx, session, state, setState, setMerging)
    } catch (err) {
      console.error("[pi-worktree] agent_settled error:", err)
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
      mergePrompted = true
      await askMerge(pi, ctx, session, state, setState, setMerging)
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
      notify(
        ctx,
        `pi-worktree: branch ${state.branch} @ ${state.path} (base ${state.base} → ${state.target}, path from ${state.pathSource}, ${work ? describeWork(work) : "unknown changes"})`,
        "info",
      )
    },
  })
}
