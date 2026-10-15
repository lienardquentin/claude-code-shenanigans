#!/usr/bin/env python3
"""Runs the tests a change can break in one target, and tells what it broke from what was broken already.

The project names the command (`label.affected=`), which runs that target's tests: all of them, or those its own
tool says the change affects. It is run on the working tree. Only when it fails is it run again on the source of the
commit compared against, with the working tree's tests laid over it (as the proof does, in the target's worktree):
a test that fails on both was broken before the change, one that fails only on the working tree is broken by it.
A run that passes, the usual one, costs one run.

Reads one JSON job on stdin and writes one JSON answer on stdout:

    {"home", "label", "tests": [...], "command", "from"}

The answer: {"label", "to": {"error", "exitCode", "output"}, "from": {...} | null}
"""

import json
import sys

from prove import Stop, checkout, git, overlay, run


def main():
    job = json.load(sys.stdin)
    home = job["home"]
    after = {"error": "", "exitCode": -1, "output": ""}
    before = None

    try:
        after["exitCode"], after["output"] = run(job["command"], home)
    except Stop as stop:
        after["error"] = str(stop)

    if after["exitCode"] != 0 and not after["error"]:
        before = {"error": "", "exitCode": -1, "output": ""}
        try:
            code, sha, _ = git(home, "rev-parse", "--verify", "--quiet", job["from"] + "^{commit}")
            if code != 0:
                raise Stop("git knows no commit by the name %s" % job["from"])
            tree = checkout(home, job["label"], sha)
            overlay(home, tree, job["tests"])
            before["exitCode"], before["output"] = run(job["command"], tree)
        except Stop as stop:
            before["error"] = str(stop)

    json.dump({"label": job["label"], "to": after, "from": before}, sys.stdout)


if __name__ == "__main__":
    main()
