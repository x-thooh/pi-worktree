// Tests for the pure helpers and the pending-work probe. Run with `bun run test`.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { hasWork, pendingWork, renderTemplate, sanitize, worktreePathFor } from "../src/extension.ts"
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
