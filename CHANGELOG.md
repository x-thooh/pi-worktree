# Changelog

## [0.3.0]

- Reap worktrees left behind by sessions that ended without a merge. Every
  startup now walks the records under `<git-common-dir>/pi-worktree/` and:
  forgets records whose directory is gone (plus `git worktree prune`), removes
  abandoned worktrees that hold no commits and no uncommitted files, and keeps —
  with a warning naming the branches — anything that holds work.
- Records now carry the owning PID, host, and last-touched time, so a live
  session is never disturbed: a PID is probed with signal 0 on the same host, a
  record from another machine is assumed live, and a record untouched for seven
  days counts as dead even if its PID was recycled.
- Quitting the session reclaims an empty worktree immediately instead of leaving
  it for the next startup. `reload`/`new`/`resume`/`fork` still hand the worktree
  over untouched.
- Records written before this version have no PID, so the first startup after
  upgrading clears the leftovers they describe — the exact case this fixes.
- New `reap` setting (default `true`, env `PI_WT_WORKTREE_REAP`) to turn the
  automatic cleanup off.
- Safety: no reap path passes `--force` or `--force-delete`. `wt remove` and
  `git branch -d` refuse a dirty worktree or an unmerged branch by themselves, so
  a wrong liveness probe can only fail to clean up, never discard work.

## [0.2.0]

- Label every ref with its role: `local <branch>` for the session branch,
  `remote <ref>` for the remote-tracking base, `local <target>` for the branch
  that gets fast-forwarded. The role is read from git, not guessed from the name
  (`feature/lr/4.3.8.2` stays local).
- Publish a footer status entry while a worktree is active, refreshed with the
  pending work at each settle.
- `/wt-status` prints one field per line instead of a single sentence.
- Fix: the merge question was asked at most once per session, so a session whose
  first turn changed nothing never asked again. It now tracks the amount already
  offered and asks again once that amount grows.
- Fix: untracked files created by project hooks before the agent started (copied
  local config, warm caches, marker files) no longer count as work, so a project
  that does not gitignore its hook output no longer gets a merge dialog after an
  empty task.

## [0.1.0]

Initial release, extracted from a local Pi extension into a package.

- Create an isolated worktree per Pi session with `wt switch --create`.
- Worktree directory defaults to `<primary worktree>/.worktrees/<branch>`, configurable
  by env `PI_WT_WORKTREE_PATH`, `<repo>/.pi/wt-worktree.json`, or
  `~/.pi/agent/wt-worktree.json` (template variables `{{ repo_path }}`,
  `{{ branch }}`, `{{ branch | sanitize }}`).
- Project hooks from `<repo>/.config/wt.toml` now run during creation instead of
  being skipped with `--no-hooks`; the pre-create notice lists them and flags
  unapproved ones.
- The merge prompt is skipped when the worktree carries no commits and no
  uncommitted files.
- Per-session state under `<git-common-dir>/pi-worktree/`, so `/reload` re-attaches
  and concurrent sessions do not clobber each other.
- No nested worktree when Pi starts inside a linked worktree.
