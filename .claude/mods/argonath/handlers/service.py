#!/usr/bin/env python3
"""Plays a web service's kept requests on two builds and says which answered otherwise, for the argonath mod.

A build is the working tree's (`work`) or a commit's: the commit is checked out in a worktree of the service's own,
.argonath/trees/<label>, as the proof does. Each build plays every request in order, in-process, with the Python of
its own project (uv's, when the project names one), and the app as that build has it. No server is started and
nothing is listened on. The environment the project names is set for both, so a database or a broker the app would
reach is left out alike.

What is compared, request by request: the status, and the body, each mask applied, as a diff of its lines.

Reads one JSON job on stdin and writes one JSON answer on stdout:

    {"home", "label", "app", "python", "env": {...}, "masks": [...], "requests": [...], "from"}

The answer: {"label", "from": {"ref", "sha", "error"}, "to": {...}, "error", "cases": [{"line", "isChanged", "evidence"}]}
"""

import difflib
import json
import os
import re
import shutil
import subprocess
import sys

from prove import Stop, checkout, git, tail

HERE = os.path.dirname(os.path.abspath(__file__))
# How long one build may take to play every request
SIDE_SECONDS = 180
# How many lines of a body's diff are handed back
DIFF_LINES = 60
MASKED = "<masked>"


def play(job, folder):
    """Every request on the build in `folder`: a status, a body and an error each."""
    python = os.path.join(folder, job["python"]) if job["python"] else folder
    uv = shutil.which("uv")
    has_project = os.path.isfile(os.path.join(python, "pyproject.toml"))
    command = [uv, "run", "--quiet", "--project", python, "python", "-P"] if uv and has_project else [sys.executable, "-P"]
    env = {**os.environ, **job["env"], "PYTHONPATH": python, "NO_COLOR": "1"}
    try:
        done = subprocess.run(
            [*command, os.path.join(HERE, "play_http.py")],
            input=json.dumps({"app": job["app"], "requests": job["requests"]}),
            cwd=python, env=env, capture_output=True, text=True, errors="replace", timeout=SIDE_SECONDS,
        )
    except subprocess.TimeoutExpired:
        raise Stop("its requests were ended after %d seconds" % SIDE_SECONDS)
    try:
        return json.loads(done.stdout)
    except ValueError:
        raise Stop("its app did not answer (exit %d): %s" % (done.returncode, tail(done.stderr, 4)))


def masked(text, masks):
    for mask in masks:
        text = mask.sub(MASKED, text)
    return text


def evidence(before, after, masks):
    """How one request's answer changed, as lines: the status, then the body's diff; empty when it did not."""
    lines = []
    if (before["status"], before["error"]) != (after["status"], after["error"]):
        lines.append("status %s → %s" % (before["error"] or before["status"], after["error"] or after["status"]))
    body = list(difflib.unified_diff(masked(before["body"], masks).splitlines(), masked(after["body"], masks).splitlines(), "from/body", "to/body", lineterm="", n=2))
    if len(body) > DIFF_LINES:
        body = body[:DIFF_LINES] + ["… %d more lines differ" % (len(body) - DIFF_LINES)]
    return "\n".join(lines + body)


def main():
    job = json.load(sys.stdin)
    home = job["home"]
    answer = {"label": job["label"], "from": {"ref": job["from"], "sha": "", "error": ""}, "to": {"ref": "work", "sha": "", "error": ""}, "error": "", "cases": []}

    masks = []
    for source in job["masks"]:
        try:
            masks.append(re.compile(source))
        except re.error as error:
            answer["error"] = "the mask %s is no regular expression: %s" % (source, error)
    if not job["requests"]:
        answer["error"] = "no request is kept to play"

    played = [None, None]
    if not answer["error"]:
        try:
            code, sha, _ = git(home, "rev-parse", "--verify", "--quiet", job["from"] + "^{commit}")
            if code != 0:
                raise Stop("git knows no commit by the name %s" % job["from"])
            answer["from"]["sha"] = sha
            played[0] = play(job, checkout(home, job["label"], sha))
        except Stop as stop:
            answer["from"]["error"] = str(stop)
        try:
            played[1] = play(job, home)
        except Stop as stop:
            answer["to"]["error"] = str(stop)

    if played[0] is not None and played[1] is not None:
        for line, before, after in zip(job["requests"], played[0], played[1]):
            said = evidence(before, after, masks)
            answer["cases"].append({"line": line, "isChanged": said != "", "evidence": said})

    json.dump(answer, sys.stdout)


if __name__ == "__main__":
    main()
