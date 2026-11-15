# pi-worktree

A [Pi](https://pi.dev) extension that puts every session's work in its own
git worktree created by [wt (worktrunk)](https://worktrunk.dev), and merges it
back when the task is done.

```
startup ──► wt switch --create pi/<stamp> --base <upstream> --path <template>
            │  (project hooks from .config/wt.toml run here: copy-local, mise trust,
            │   go-cache, codegraph …)
            ▼
        agent works inside <primary worktree>/.worktrees/<branch>
            ▼
task settles ──► has work?  ── no ──► stay quiet, worktree kept
                    │ yes
                    ▼
                 wt merge <branch> <target>   (squash + rebase + fast-forward + remove)
```

The main checkout stays untouched, so a parallel session, an IDE build, or
`git status` you ran five minutes ago is never disturbed.

## Install

```bash
pi install git:github.com/x-thooh/pi-worktree@v0.1.0   # pinned
pi install git:github.com/x-thooh/pi-worktree         # track main
```

Requirements: `wt` (worktrunk) >= 0.81 on `PATH`, and a git repo. Without `wt`
the extension disables itself with a single warning and never blocks a session.

Pi clones git packages over `https://github.com/…`. If that endpoint is not
reachable from your network, map GitHub to SSH once — the package then installs
and updates over SSH with no proxy:

```gitconfig
[url "git@github.com:"]
    insteadOf = https://github.com/
```

## Commands

| Command | Effect |
| --- | --- |
| `/wt-status` | Local branch, worktree path, base ref, merge target, pending work |
| `/wt-merge` | Merge the worktree branch back into its target branch now |

## Reading the status

Every ref is labelled with its role, because three different branches are in play:

```
wt · local pi/20261115-130108-ysgo ← remote origin/master → local master 2 commits, 1 uncommitted file
```

| Label | Meaning |
| --- | --- |
| `local <branch>` | the throwaway branch created for this session; it has no upstream and is deleted after the merge |
| `← remote <ref>` | the remote-tracking base the branch was cut from, used only as a diff base |
| `→ local <target>` | the local branch `wt merge` fast-forwards |

The role comes from git (`git rev-parse --verify refs/remotes/<ref>`), not from the
shape of the name, so a local branch like `feature/lr/4.3.8.2` is still reported as
local. `/wt-status` prints one field per line; the same wording appears in the
creation notice, the merge dialog, and the system-prompt section that keeps the
agent inside the worktree.

## Worktree directory

Resolution order — first match wins:

| # | Source | Example |
| --- | --- | --- |
| 1 | env `PI_WT_WORKTREE_PATH` | `../wt/{{ branch \| sanitize }}` |
| 2 | `<repo>/.pi/wt-worktree.json` → `worktreePath` | `"{{ repo_path }}/.worktrees/{{ branch \| sanitize }}"` |
| 3 | `~/.pi/agent/wt-worktree.json` → `worktreePath` | same |
| 4 | built-in default | `{{ repo_path }}/.worktrees/{{ branch \| sanitize }}` |

`<repo>` is the primary worktree — the directory that holds `.git` — so the
default puts worktrees under `<project>/.worktrees/`, even when the session
starts from a linked worktree. Relative templates resolve against the current
directory. Template variables:

| Variable | Value |
| --- | --- |
| `{{ repo_path }}` / `{{ primary_worktree_path }}` | absolute path of the primary worktree |
| `{{ repo }}` | its directory name |
| `{{ branch }}` | full branch name, e.g. `pi/20261115-130108-ysgo` |
| `{{ branch \| sanitize }}` | filesystem-safe form, e.g. `pi-20261115-130108-ysgo` |
| `{{ branch_sanitized }}` | same as the filter above |

Config files may be flat or wrapped in `wtWorktree`:

```json
{
  "worktreePath": "{{ repo_path }}/.worktrees/{{ branch | sanitize }}",
  "hooks": true,
  "mergePrompt": true,
  "createTimeoutMs": 900000
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `worktreePath` | `{{ repo_path }}/.worktrees/{{ branch \| sanitize }}` | directory template |
| `hooks` | `true` | run `<repo>/.config/wt.toml` project hooks during creation |
| `mergePrompt` | `true` | ask once when the agent settles |
| `createTimeoutMs` | `900000` | budget for `wt switch`; project hooks can copy gigabytes |

Env overrides: `PI_WT_WORKTREE_PATH`, `PI_WT_WORKTREE_HOOKS` (`0`/`false`),
`PI_WT_WORKTREE_MERGE_PROMPT`, `PI_WT_WORKTREE_TIMEOUT_MS`.

## Project hooks (`wt.toml`)

Creation goes through plain `wt switch --create … -y`, so the project's
`.config/wt.toml` hooks run exactly as they do for a manual switch:

| Phase | Runs |
| --- | --- |
| `pre-switch` | before the worktree exists |
| `pre-start` | after the worktree lands, blocking |
| `post-switch`, `post-start` | spawned in the background by wt |

Before creating, the extension reads `wt hook show --format json` and reports
which hooks will run and how many still need approval. Unapproved project hooks
are approved by `-y` (the same as answering "yes" to wt's prompt); set
`"hooks": false` to keep a project's hooks out of agent-run creation entirely.

## When it asks to merge

Only when the worktree actually carries work:

- commits ahead of the base ref (`git rev-list --count <base>..HEAD`), or
- uncommitted changes (`git status --porcelain`)

An empty worktree stays put, silently, with a one-line notification — no
dialog. The prompt runs `wt merge --branch <branch> <target>`: squash, rebase,
fast-forward the target, remove the worktree (and its branch). Declining keeps
everything; `/wt-merge` asks again on demand.

Untracked files that the project hooks produced before the agent started are
not counted as work, and the question returns as soon as the pending work grows.

Note that `wt merge` stages everything by default, hook output included, so
gitignore the files your hooks create (`.go`, `.codegraph`, local config) — that
is what the marketing repo's `.gitignore` does.

## Behaviour details

- **One worktree per Pi session.** State lives in
  `<git-common-dir>/pi-worktree/<session-id>.json`, so `/reload` re-attaches
  instead of creating a duplicate, and two sessions in one repo keep separate
  records.
- **No nesting.** If Pi starts inside a linked worktree, no second worktree is
  created.
- **Only on startup.** `reload`, `new`, `resume`, and `fork` re-attach to the
  persisted worktree.
- **Fail open.** Any extension error is logged and the session continues.

## Development

```bash
npm install
npm run typecheck && npm test
pi -e .        # load the local package for one session
python3 tests/e2e_rpc.py                 # drive a real Pi over RPC (spends tokens)
PI_WT_E2E_INSTALLED=1 python3 tests/e2e_rpc.py   # same, against the installed package
```

`tests/e2e_rpc.py` covers what the unit tests cannot: worktree creation with the
project hook, the footer status, the dialog appearing only when work exists, and
`/wt-merge` merging back and removing the worktree.

CI runs the type check and the tests on Node 22.19 and 24 (`.github/workflows/ci.yml`).
Node 22.19 is the floor because the pi 1.5.2 host types declare `>=22.19.0`; below
it npm silently resolves an older pi release and the type check fails on API
that does not exist there.

## License

MIT
