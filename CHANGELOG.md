# Changelog

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
