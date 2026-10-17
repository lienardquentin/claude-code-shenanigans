#!/usr/bin/env python3
"""Runs a tool's integration tests on two sides and hands back what each wrote, for the argonath mod.

One side is the working tree, where the tests are run as they stand. The other is the source of a commit (any name
git resolves) with the working tree's tests laid over it: the commit is checked out in a worktree of the tool's own,
.argonath/trees/<label>, and the files the project names as tests are copied there from the working tree, what git
tracks and what it neither tracks nor ignores. A test written a moment ago is so run on the source as it was before
the change: one that pins the change fails there and passes on the working tree.

The test command is run from the worktree's folder and then from the project's, through the person's login shell.
What it built in the worktree is left there, so a second proof builds little.

Reads one JSON job on stdin and writes one JSON answer on stdout:

    {"home", "label", "tests": [...], "test", "from"}
"""

import json
import os
import shutil
import subprocess
import sys

# How long the tests of one side may take before they are ended
SIDE_SECONDS = 280
# How much of what a side wrote is handed back: its end, where a runner names what failed
KEPT_CHARS = 200_000


class Stop(Exception):
    """What ends the making of one side, said as its error."""


def git(cwd, *args):
    done = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, errors="replace")
    return done.returncode, done.stdout.strip(), done.stderr.strip()


def tail(text, lines=3):
    return " ".join(text.strip().splitlines()[-lines:])


def checkout(home, label, sha):
    """The commit in the tool's worktree, with nothing of an earlier proof left in it but what git ignores."""
    tree = os.path.join(home, ".argonath", "trees", label)
    if os.path.isdir(tree):
        git(tree, "clean", "-fdq")
        code, _, said = git(tree, "checkout", "--detach", "--force", "--quiet", sha)
    else:
        os.makedirs(os.path.dirname(tree), exist_ok=True)
        code, _, said = git(home, "worktree", "add", "--detach", "--force", tree, sha)
    if code != 0:
        raise Stop("it could not be checked out: %s" % tail(said))
    return tree


def overlay(home, tree, tests):
    """The working tree's tests in place of the commit's; nothing where no test is named, as git would list every file."""
    if not tests:
        return
    inside = [os.path.relpath(path, home) for path in tests]
    if any(path.startswith("..") for path in inside):
        raise Stop("a test path is outside the project")
    for path in inside:
        target = os.path.join(tree, path)
        if os.path.isdir(target) and not os.path.islink(target):
            shutil.rmtree(target)
        elif os.path.lexists(target):
            os.remove(target)
    code, listed, said = git(home, "ls-files", "-co", "--exclude-standard", "-z", "--", *inside)
    if code != 0:
        raise Stop("the tests could not be listed: %s" % tail(said))
    for path in listed.split("\0"):
        source = os.path.join(home, path)
        if path and os.path.isfile(source):
            target = os.path.join(tree, path)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            shutil.copy2(source, target)


def run(command, cwd):
    """The test command on one side: what it exited with, and the end of what it wrote to both streams."""
    shell = os.environ.get("SHELL") or "/bin/sh"
    env = {**os.environ, "NO_COLOR": "1", "CARGO_TERM_COLOR": "never", "FORCE_COLOR": "0"}
    try:
        done = subprocess.run([shell, "-lc", command], cwd=cwd, env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, errors="replace", timeout=SIDE_SECONDS)
    except subprocess.TimeoutExpired:
        raise Stop("the tests were ended after %d seconds" % SIDE_SECONDS)
    return done.returncode, (done.stdout + "\n" + done.stderr)[-KEPT_CHARS:]


def main():
    job = json.load(sys.stdin)
    home = job["home"]
    before = {"ref": job["from"], "sha": "", "error": "", "exitCode": -1, "output": ""}
    after = {"ref": "work", "sha": "", "error": "", "exitCode": -1, "output": ""}

    try:
        code, sha, _ = git(home, "rev-parse", "--verify", "--quiet", job["from"] + "^{commit}")
        if code != 0:
            raise Stop("git knows no commit by the name %s" % job["from"])
        before["sha"] = sha
        tree = checkout(home, job["label"], sha)
        overlay(home, tree, job["tests"])
        before["exitCode"], before["output"] = run(job["test"], tree)
    except Stop as stop:
        before["error"] = str(stop)

    try:
        after["exitCode"], after["output"] = run(job["test"], home)
    except Stop as stop:
        after["error"] = str(stop)

    json.dump({"label": job["label"], "from": before, "to": after}, sys.stdout)


if __name__ == "__main__":
    main()
