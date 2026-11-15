#!/usr/bin/env python3
"""End-to-end test for pi-worktree through Pi's RPC mode.

Not part of CI: it starts a real `pi` process and spends model tokens.

    python3 tests/e2e_rpc.py                          # test this working tree
    PI_WT_E2E_INSTALLED=1 python3 tests/e2e_rpc.py    # test the installed package

Drives a real Pi run in a scratch git repo and asserts the three behaviours that
the unit tests cannot reach:
  1. a worktree is created on startup, in <repo>/.worktrees/<branch>,
  2. the project's .config/wt.toml pre-start hook runs,
  3. an empty task never raises the merge dialog, while a task that writes
     something does — and answering "no" keeps the worktree, answering "yes"
     from /wt-merge merges it back and removes it.
"""

import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import queue
import shutil

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Default: run this checkout. PI_WT_E2E_INSTALLED=1 runs whatever pi has installed.
EXTRA = [] if os.environ.get("PI_WT_E2E_INSTALLED") else ["--no-extensions", "-e", REPO]
WORK = tempfile.mkdtemp(prefix="wt-e2e-")
TIMEOUT = 240


def sh(*args, cwd=WORK):
    return subprocess.run(args, cwd=cwd, capture_output=True, text=True)


class Pi:
    def __init__(self):
        env = dict(os.environ)
        env.pop("PI_WT_WORKTREE_PATH", None)
        self.proc = subprocess.Popen(
            ["pi", "--mode", "rpc", "--no-session", "--no-mcp", "--no-skills"] + EXTRA,
            cwd=WORK,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            bufsize=0,
        )
        self.records = queue.Queue()
        self.all = []
        self.stderr = []
        threading.Thread(target=self._read, daemon=True).start()
        threading.Thread(target=self._read_err, daemon=True).start()

    def _read(self):
        for line in self.proc.stdout:
            line = line.decode("utf-8").strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            self.all.append(rec)
            self.records.put(rec)

    def _read_err(self):
        for line in self.proc.stderr:
            self.stderr.append(line.decode("utf-8", "replace").rstrip())

    def send(self, rec):
        self.proc.stdin.write((json.dumps(rec) + "\n").encode())
        self.proc.stdin.flush()

    def wait_for(self, pred, deadline, label):
        while time.time() < deadline:
            try:
                rec = self.records.get(timeout=max(1, deadline - time.time()))
            except queue.Empty:
                break
            if pred(rec):
                return rec
        seen = []
        for r in self.all:
            item = r.get("type")
            if item == "extension_ui_request":
                item = "ui:" + str(r.get("method"))
                if r.get("method") == "notify":
                    item += " " + str(r.get("message"))[:120]
            seen.append(item)
        raise AssertionError(
            f"timeout waiting for {label}\nseen:\n  " + "\n  ".join(seen[-40:])
            + "\nstderr:\n" + "\n".join(self.stderr[-20:])
        )

    def prompt(self, message, expect_dialog=False):
        """Send a prompt. A dialog opened from the extension's agent_settled handler
        blocks the settled event, so stop at whichever comes first."""
        self.send({"id": "p", "type": "prompt", "message": message})
        self.wait_for(lambda r: r.get("type") == "response" and r.get("id") == "p", time.time() + 60, "prompt response")

        def done(r):
            if expect_dialog and r.get("type") == "extension_ui_request" and r.get("method") == "confirm":
                return True
            return r.get("type") == "agent_settled"

        return self.wait_for(done, time.time() + TIMEOUT, "agent_settled or dialog")

    def wait_settled(self):
        return self.wait_for(lambda r: r.get("type") == "agent_settled", time.time() + TIMEOUT, "agent_settled")

    def notifies(self):
        return [r for r in self.all if r.get("type") == "extension_ui_request" and r.get("method") == "notify"]

    def statuses(self):
        return [
            r.get("statusText")
            for r in self.all
            if r.get("type") == "extension_ui_request"
            and r.get("method") == "setStatus"
            and r.get("statusKey") == "wt-worktree"
        ]

    def assistant_texts(self):
        out = []
        for r in self.all:
            if r.get("type") == "message_end":
                m = r.get("message") or {}
                if m.get("role") == "assistant":
                    for part in m.get("content") or []:
                        if part.get("type") == "text":
                            out.append(part.get("text", ""))
        return out

    def confirms(self):
        return [r for r in self.all if r.get("type") == "extension_ui_request" and r.get("method") == "confirm"]

    def close(self):
        try:
            self.proc.stdin.close()
        except Exception:
            pass
        try:
            self.proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            self.proc.kill()


def step(msg):
    print(f"\n=== {msg}")


def main():
    failures = []
    sh("git", "init", "-q", "-b", "main", ".")
    open(os.path.join(WORK, "a.txt"), "w").write("one\n")
    sh("git", "add", "-A")
    sh("git", "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "init")
    os.makedirs(os.path.join(WORK, ".config"), exist_ok=True)
    open(os.path.join(WORK, ".config", "wt.toml"), "w").write('[pre-start]\nmark = "date > pre-start.txt"\n')
    gitignore = os.path.join(WORK, ".gitignore")
    if not os.path.exists(gitignore):
        open(gitignore, "w").write(".config/\npre-start.txt\n")
        sh("git", "add", ".gitignore")
        sh("git", "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "ignore hook output")

    # a real remote makes the base a remote-tracking ref, the case the status must label
    bare = os.path.join(tempfile.mkdtemp(prefix="wt-e2e-origin-"), "origin.git")
    sh("git", "init", "-q", "--bare", bare)
    sh("git", "remote", "add", "origin", bare)
    sh("git", "push", "-q", "-u", "origin", "main")

    pi = Pi()
    try:
        step("A. empty task must not raise the merge dialog")
        pi.prompt("Reply with exactly: ok")
        time.sleep(2)
        notifies = [n.get("message", "") for n in pi.notifies()]
        confirms = pi.confirms()
        print("notifies:", json.dumps(notifies, ensure_ascii=False, indent=2))
        print("confirms:", len(confirms))
        if confirms:
            failures.append("A: merge dialog appeared for an empty task")
        if not any("no changes" in m for m in notifies):
            failures.append("A: missing 'no changes' notification")
        if not any("creating" in m for m in notifies):
            failures.append("A: missing worktree creation notification")
        if not any("local branch" in m and "merge target local" in m for m in notifies):
            failures.append("A: creation notice does not label local vs remote")

        statuses = [t for t in pi.statuses() if t]
        print("status:", statuses[-1] if statuses else None)
        if not statuses:
            failures.append("A: no wt-worktree status entry")
        else:
            last = statuses[-1]
            if "local " not in last or "remote " not in last:
                failures.append(f"A: status does not distinguish local/remote: {last}")
            if "→ local" not in last:
                failures.append(f"A: status does not mark the local merge target: {last}")

        branches = sh("git", "branch", "--list", "pi/*").stdout.split()
        worktrees = [l for l in sh("git", "worktree", "list").stdout.splitlines() if ".worktrees" in l]
        print("branches:", branches)
        print("worktrees:", worktrees)
        if not worktrees:
            failures.append("A: no worktree created")
            raise SystemExit(report(failures))
        if not os.path.exists(os.path.join(worktrees[0].split()[0], "pre-start.txt")):
            failures.append("A: project pre-start hook did not run")
        if not os.path.isdir(os.path.join(WORK, ".git", "pi-worktree")):
            failures.append("A: per-session state file missing")

        wt_path = worktrees[0].split()[0]

        step("B. a task that writes must raise the dialog; answering no keeps the worktree")
        confirm = pi.prompt(
            f"Create the file {wt_path}/hello.txt containing exactly 'hi' using the write tool, "
            "then reply with exactly: done",
            expect_dialog=True,
        )
        print("files in worktree:", sorted(os.listdir(wt_path)) if os.path.isdir(wt_path) else "gone")
        print("assistant:", json.dumps(pi.assistant_texts()[-2:], ensure_ascii=False)[:600])
        if confirm.get("type") != "extension_ui_request":
            raise AssertionError(
                f"B: expected a confirm dialog, got {confirm.get('type')}\n"
                f"worktree listing: {sorted(os.listdir(wt_path)) if os.path.isdir(wt_path) else 'gone'}\n"
                f"worktree status: {sh('git', 'status', '--porcelain', cwd=wt_path).stdout!r}\n"
                f"assistant said: {pi.assistant_texts()[-2:]}"
            )
        print("confirm:", json.dumps(confirm, ensure_ascii=False))
        print("dialog:", confirm.get("title"), "|", confirm.get("message"))
        if "local branch" not in confirm.get("message", ""):
            failures.append("B: dialog does not name the local branches")
        if "wt merge?" not in confirm.get("title", ""):
            failures.append("B: unexpected confirm title")
        if "commit" not in confirm.get("message", "") and "uncommitted" not in confirm.get("message", ""):
            failures.append("B: confirm message does not describe the pending work")
        pi.send({"type": "extension_ui_response", "id": confirm["id"], "confirmed": False})
        pi.wait_settled()
        time.sleep(1)
        if not os.path.exists(wt_path):
            failures.append("B: declining the merge removed the worktree")

        step("C. /wt-merge then yes must merge back and remove the worktree")
        # An extension command runs inside the command handler, and its dialog blocks
        # the prompt response — wait for the dialog, not for the response.
        pi.send({"id": "c", "type": "prompt", "message": "/wt-merge"})
        confirm2 = pi.wait_for(
            lambda r: r.get("type") == "extension_ui_request" and r.get("method") == "confirm" and r.get("id") != confirm["id"],
            time.time() + 120,
            "merge confirm from /wt-merge",
        )
        pi.send({"type": "extension_ui_response", "id": confirm2["id"], "confirmed": True})
        deadline = time.time() + 240
        merged = None
        while time.time() < deadline:
            for rec in pi.all:
                if rec.get("type") == "extension_ui_request" and rec.get("method") == "notify":
                    if "merged" in rec.get("message", ""):
                        merged = rec.get("message")
            if merged:
                break
            time.sleep(1)
        print("merge notify:", merged)
        if not merged:
            failures.append("C: no merge notification")
        gone_deadline = time.time() + 90
        while os.path.exists(wt_path) and time.time() < gone_deadline:
            time.sleep(1)
        if os.path.exists(wt_path):
            failures.append("C: worktree still present after merge")
        if not os.path.exists(os.path.join(WORK, "hello.txt")):
            failures.append("C: hello.txt did not reach the target branch")
        print("main head:", sh("git", "log", "--oneline", "-1").stdout.strip())
        print("status:", repr(sh("git", "status", "--porcelain").stdout))
    finally:
        pi.close()

    return report(failures)


def report(failures):
    print("\n" + "=" * 60)
    if failures:
        print("FAIL")
        for f in failures:
            print(" -", f)
        print("workdir kept:", WORK)
        return 1
    print("PASS — all end-to-end assertions hold")
    shutil.rmtree(WORK, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
