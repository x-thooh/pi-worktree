// Tests for the pure helpers and the pending-work probe. Run with `bun run test`.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import {
  buildSection,
  defaultPidProbe,
  describeReapEntries,
  hasWork,
  isBaseline,
  parseStatus,
  pendingWork,
  reapDecision,
  refLabel,
  renderTemplate,
  sanitize,
  sessionAlive,
  shouldOfferMerge,
  statusLine,
  workSignature,
  worktreePathFor,
} from "../src/extension.ts"
import type { WorktreeState } from "../src/extension.ts"

/** Minimal ExtensionAPI stub: only `exec` is used by the code under test. */
const fakePi = {
  exec: async (cmd: string, args: string[], opts: { cwd?: string } = {}) => {
    try {
      const stdout = execFileSync(cmd, args, { cwd: opts.cwd, encoding: "utf8", stdio: "pipe" })
      return { code: 0, stdout, stderr: "" }
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string }
      return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" }
    }
  },
} as unknown as ExtensionAPI

test("sanitize turns a branch into a directory name", () => {
  assert.equal(sanitize("pi/20261115-130108-ysgo"), "pi-20261115-130108-ysgo")
  assert.equal(sanitize("feature/lr/4.3.8.2"), "feature-lr-4.3.8.2")
  assert.equal(sanitize("a  b"), "a-b")
  assert.equal(sanitize("--x--"), "x")
})

test("renderTemplate expands variables and the sanitize filter", () => {
  const vars = { repo_path: "/repo", branch: "pi/1" }
  assert.equal(renderTemplate("{{ repo_path }}/.worktrees/{{ branch | sanitize }}", vars), "/repo/.worktrees/pi-1")
  assert.equal(renderTemplate("{{branch}}", vars), "pi/1")
  assert.equal(renderTemplate("{{ missing }}", vars), "")
})

test("worktreePathFor can place worktrees beside the repo and normalizes ..", () => {
  assert.equal(
    worktreePathFor("{{ repo_parent }}/.wt/{{ repo }}-{{ branch | sanitize }}", "/src/repo", "/src/repo", "pi/1"),
    "/src/.wt/repo-pi-1",
  )
  assert.equal(
    worktreePathFor("{{ repo_path }}/../.wt/{{ branch | sanitize }}", "/src/repo", "/src/repo/sub", "pi/1"),
    "/src/.wt/pi-1",
  )
})

test("worktreePathFor resolves relative templates against the cwd", () => {
  assert.equal(
    worktreePathFor("{{ repo_path }}/.worktrees/{{ branch | sanitize }}", "/repo", "/repo", "pi/1"),
    "/repo/.worktrees/pi-1",
  )
  assert.equal(worktreePathFor("../wt/{{ branch | sanitize }}", "/repo", "/repo", "pi/1"), "/wt/pi-1")
})

test("pendingWork counts commits ahead of base and uncommitted files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-worktree-test-"))
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: "pipe" })
  try {
    git("init", "-q", "-b", "main", ".")
    writeFileSync(join(dir, "a.txt"), "one\n")
    git("add", "-A")
    git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "init")
    git("checkout", "-q", "-b", "work")

    const clean = worktreeState(dir)
    assert.deepEqual(await pendingWork(fakePi, clean), { commits: 0, files: 0 })
    assert.equal(hasWork(await pendingWork(fakePi, clean)), false)

    writeFileSync(join(dir, "a.txt"), "two\n")
    assert.deepEqual(await pendingWork(fakePi, clean), { commits: 0, files: 1 })

    git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-am", "change")
    assert.deepEqual(await pendingWork(fakePi, clean), { commits: 1, files: 0 })
    assert.equal(hasWork(await pendingWork(fakePi, clean)), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("parseStatus keeps renames from eating the next entry", () => {
  // -z framing: "XY path\0", a rename adds its source path as its own record
  const raw = "?? hook.txt\0 M a.txt\0R  new.txt\0old.txt\0"
  assert.deepEqual(parseStatus(raw), [
    { code: "??", file: "hook.txt" },
    { code: " M", file: "a.txt" },
    { code: "R ", file: "new.txt" },
  ])
})

test("isBaseline covers a file and everything below a directory entry", () => {
  const st = worktreeState("/x")
  st.baseline = [".go", "mise.local.toml"]
  assert.equal(isBaseline(st, ".go"), true)
  assert.equal(isBaseline(st, ".go/pkg/mod/x"), true)
  assert.equal(isBaseline(st, ".gomod"), false)
  assert.equal(isBaseline(st, "mise.local.toml"), true)
  assert.equal(isBaseline(worktreeState("/x"), "anything"), false)
})

test("hook output present at creation does not count as work", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-worktree-baseline-"))
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: "pipe" })
  try {
    git("init", "-q", "-b", "main", ".")
    writeFileSync(join(dir, "a.txt"), "one\n")
    git("add", "-A")
    git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "init")

    // what a pre-start hook leaves behind in a project that does not gitignore it
    writeFileSync(join(dir, "pre-start.txt"), "marker\n")
    const st = worktreeState(dir)
    st.baseline = ["pre-start.txt"]
    assert.deepEqual(await pendingWork(fakePi, st), { commits: 0, files: 0 })
    assert.equal(hasWork(await pendingWork(fakePi, st)), false)

    // the agent's own new file still counts
    writeFileSync(join(dir, "hello.txt"), "hi\n")
    assert.deepEqual(await pendingWork(fakePi, st), { commits: 0, files: 1 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("refLabel names the role from git, not from the shape of the name", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-worktree-refs-"))
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: "pipe" })
  try {
    git("init", "-q", "-b", "main", ".")
    writeFileSync(join(dir, "a.txt"), "one\n")
    git("add", "-A")
    git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "init")
    git("branch", "feature/lr/4.3.8.2")
    git("update-ref", "refs/remotes/origin/main", "HEAD")

    // a local branch with slashes must not be mistaken for a remote-tracking ref
    assert.equal(await refLabel(fakePi, dir, "feature/lr/4.3.8.2"), "local feature/lr/4.3.8.2")
    assert.equal(await refLabel(fakePi, dir, "origin/main"), "remote origin/main")
    assert.equal(await refLabel(fakePi, dir, "origin/main", false), "local origin/main")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("statusLine separates the local branch, its base and the local target", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-worktree-status-"))
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: "pipe" })
  try {
    git("init", "-q", "-b", "main", ".")
    writeFileSync(join(dir, "a.txt"), "one\n")
    git("add", "-A")
    git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "init")

    const st = worktreeState(dir)
    st.branch = "pi/20261115-130108-ysgo"
    st.base = "origin/main"
    st.baseIsRemote = true
    const line = await statusLine(fakePi, st)
    assert.match(line, /local pi\/20261115-130108-ysgo/)
    assert.match(line, /remote origin\/main/)
    assert.match(line, /local main/)

    const withWork = await statusLine(fakePi, st, { commits: 2, files: 1 })
    assert.match(withWork, /2 commits, 1 uncommitted file/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("buildSection states the role of the branch, the base and the target", () => {
  const st = worktreeState("/x")
  st.branch = "pi/1"
  st.base = "origin/main"
  st.baseIsRemote = true
  const section = buildSection(st)
  assert.match(section, /Local branch: pi\/1/)
  assert.match(section, /Base: origin\/main, a remote-tracking branch/)
  assert.match(section, /Merge target: main, a local branch/)

  st.baseIsRemote = false
  st.base = "feature/lr/4.3.8.2"
  st.target = "feature/lr/4.3.8.2"
  assert.match(buildSection(st), /Base: feature\/lr\/4\.3\.8\.2, a local branch/)
})

test("the merge question returns when the pending work grows", () => {
  const empty = { commits: 0, files: 0 }
  const oneFile = { commits: 0, files: 1 }
  const twoFiles = { commits: 0, files: 2 }

  assert.equal(shouldOfferMerge(empty, null), false) // nothing to merge, stay quiet
  assert.equal(shouldOfferMerge(oneFile, null), true) // first offer
  assert.equal(shouldOfferMerge(oneFile, workSignature(oneFile)), false) // declined, same amount
  assert.equal(shouldOfferMerge(twoFiles, workSignature(oneFile)), true) // grew, ask again
  assert.equal(shouldOfferMerge(null, null), false)
})

test("pendingWork reports nothing for a missing worktree", async () => {
  const gone = worktreeState("/nonexistent/pi-worktree")
  assert.equal(await pendingWork(fakePi, gone), null)
  assert.equal(hasWork(null), false)
})

function worktreeState(path: string): WorktreeState {
  return {
    branch: "pi/test",
    path,
    base: "main",
    target: "main",
    pathSource: "test",
    createdAt: 0,
  }
}

// --- Reclaiming what dead sessions leave behind -------------------------------

test("reapDecision forgets a record whose worktree is already gone", () => {
  assert.equal(reapDecision({ exists: false, alive: true, work: { commits: 1, files: 1 } }), "drop-record")
  assert.equal(reapDecision({ exists: false, alive: false, work: null }), "drop-record")
})

test("reapDecision never touches a live session's worktree", () => {
  assert.equal(reapDecision({ exists: true, alive: true, work: { commits: 3, files: 2 } }), "none")
  assert.equal(reapDecision({ exists: true, alive: true, work: { commits: 0, files: 0 } }), "none")
})

test("reapDecision removes an abandoned worktree only when it holds nothing", () => {
  assert.equal(reapDecision({ exists: true, alive: false, work: { commits: 0, files: 0 } }), "remove-worktree")
  // Unreadable counts are treated as work: never delete on a guess.
  assert.equal(reapDecision({ exists: true, alive: false, work: null }), "keep")
  assert.equal(reapDecision({ exists: true, alive: false, work: { commits: 1, files: 0 } }), "keep")
  assert.equal(reapDecision({ exists: true, alive: false, work: { commits: 0, files: 2 } }), "keep")
})

test("sessionAlive trusts a same-host pid", () => {
  const st = { pid: 4242, host: "here", createdAt: 1_000, lastSeen: 2_000 }
  assert.equal(sessionAlive(st, { host: "here", now: 3_000, probe: () => true }), true)
  assert.equal(sessionAlive(st, { host: "here", now: 3_000, probe: () => false }), false)
})

test("sessionAlive cannot probe another host and assumes the session lives", () => {
  const st = { pid: 4242, host: "elsewhere", createdAt: 1_000, lastSeen: 2_000 }
  assert.equal(sessionAlive(st, { host: "here", now: 3_000, probe: () => false }), true)
})

test("sessionAlive treats a pid-less record and a stale one as gone", () => {
  const opts = { host: "here", now: 10_000, probe: () => true }
  // Written before 0.3.0: no pid, so nobody who is running now owns it.
  assert.equal(sessionAlive({ createdAt: 1_000 }, opts), false)
  // Live pid but untouched for longer than the cutoff: the pid was reused.
  assert.equal(sessionAlive({ pid: 1, host: "here", createdAt: 1_000, lastSeen: 2_000 }, { ...opts, staleAfterMs: 100 }), false)
  // Same record inside the cutoff: the probe decides.
  assert.equal(sessionAlive({ pid: 1, host: "here", createdAt: 9_000, lastSeen: 9_900 }, { ...opts, staleAfterMs: 100 }), true)
})

test("the default pid probe sees this process", () => {
  assert.equal(defaultPidProbe(process.pid), true)
})

test("describeReapEntries words a dry run differently from an applied pass", () => {
  const report = {
    entries: [
      { branch: "pi/a", path: "/x/a", action: "remove-worktree" as const, work: { commits: 0, files: 0 }, note: "empty" },
      { branch: "pi/b", path: "/x/b", action: "keep" as const, work: { commits: 2, files: 0 }, note: "2 commits" },
      { branch: "pi/c", path: "/x/c", action: "drop-record" as const, work: null, note: "directory gone" },
      { branch: "pi/d", path: "/x/d", action: "none" as const, work: null, note: "session alive" },
    ],
    removed: ["pi/a"],
    dropped: 1,
    orphanBranches: [],
    kept: ["pi/b"],
    failed: [],
  }
  assert.deepEqual(describeReapEntries(report, true), [
    "would remove  pi/a  (empty)",
    "kept  pi/b  (2 commits)",
    "forget record  pi/c  (directory gone)",
    "in use  pi/d  (session alive)",
  ])
  assert.equal(describeReapEntries(report, false)[0], "removed  pi/a  (empty)")
  assert.equal(describeReapEntries(report, false)[2], "forgot record  pi/c  (directory gone)")
})
