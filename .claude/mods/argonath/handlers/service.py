#!/usr/bin/env python3
"""Plays a web service's kept requests on two builds and says which answered otherwise, for the argonath mod.

A build is the working tree's (`work`) or a commit's: the commit is checked out in a worktree of the service's own,
.argonath/trees/<label>, as the proof does. Each build plays every request in order, in-process, with the Python of
its own project (uv's, when the project names one), and the app as that build has it. No server is started and
nothing is listened on. The environment the project names is set for both.

With `db`, each build plays against a database of its own, made empty in a warm container (see warm.py) and dropped
after: what it writes and reads is real SQL on a real Postgres, and both builds start from the same nothing, so their
answers are compared value for value. `db.setup`, when named, is run in the build's folder first, its address set
(a migration). `ready` is asked before the first request until the app answers that it is (see play_http.py).

The working tree's build is played under coverage: of the lines the change touched in the target's folders, those no
request ran are said, file by file, as `unreached`.

What is compared, request by request: the status, and the body, each mask applied, as a diff of its lines.

Reads one JSON job on stdin and writes one JSON answer on stdout:

    {"home", "label", "app", "python", "env": {...}, "masks": [...], "requests": [...], "from", "roots": [...],
     "db": {"image", "env", "setup"} | null, "ready": {"request", "match"} | null, "project"}

`home` is the working tree played: the project's own, or a quest's worktree. `project`, the project's own folder, names
the warm container, so every worktree of one project plays against the same one; `home` when left out.

The answer: {"label", "from": {"ref", "sha", "error"}, "to": {...}, "error", "cases": [{"line", "isChanged",
"evidence"}], "unreached": {"path from home": "12-13, 40"}, "measured": bool}
"""

import difflib
import json
import os
import re
import shutil
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

from prove import Stop, checkout, git, tail
import warm

HERE = os.path.dirname(os.path.abspath(__file__))
# How long one build may take to play every request
SIDE_SECONDS = 180
# How long a build's database setup may take
SETUP_SECONDS = 180
# How many lines of a body's diff are handed back
DIFF_LINES = 40
MASKED = "<masked>"


def interpreter(python, measured):
    """How a build's Python is run: uv's for its project, coverage beside it when measured; else this one."""
    uv = shutil.which("uv")
    if uv and os.path.isfile(os.path.join(python, "pyproject.toml")):
        return [uv, "run", "--quiet", "--project", python, *(["--with", "coverage"] if measured else []), "python", "-P"]
    return [sys.executable, "-P"]


def play(job, folder, env, changed=None):
    """Every request on the build in `folder`: its answers, and the changed lines no request ran when measured."""
    python = os.path.join(folder, job["python"]) if job["python"] else folder
    try:
        done = subprocess.run(
            [*interpreter(python, bool(changed)), os.path.join(HERE, "play_http.py")],
            input=json.dumps({"app": job["app"], "requests": job["requests"], "ready": job.get("ready"), "changed": changed or {}}),
            cwd=python, env={**os.environ, **env, "PYTHONPATH": python, "NO_COLOR": "1"},
            capture_output=True, text=True, errors="replace", timeout=SIDE_SECONDS,
        )
    except subprocess.TimeoutExpired:
        raise Stop("its requests were ended after %d seconds" % SIDE_SECONDS)
    try:
        return json.loads(done.stdout)
    except ValueError:
        raise Stop("its app did not answer (exit %d): %s" % (done.returncode, tail(done.stderr, 4)))


def setup(job, folder, env):
    """The build's database made ready by its own command (a migration), run in its Python folder."""
    command = (job.get("db") or {}).get("setup") or ""
    if not command:
        return
    python = os.path.join(folder, job["python"]) if job["python"] else folder
    shell = os.environ.get("SHELL") or "/bin/sh"
    try:
        done = subprocess.run([shell, "-lc", command], cwd=python, env={**os.environ, **env}, capture_output=True, text=True, errors="replace", timeout=SETUP_SECONDS)
    except subprocess.TimeoutExpired:
        raise Stop("its database setup was ended after %d seconds" % SETUP_SECONDS)
    if done.returncode != 0:
        raise Stop("its database setup failed: %s" % tail(done.stderr or done.stdout, 3))


def played_on(job, folder, url, changed=None):
    """One build played, against its own database when the target names one."""
    env = dict(job["env"])
    if url:
        env[job["db"]["env"]] = url
        setup(job, folder, env)
    return play(job, folder, env, changed)


def changed_lines(home, roots):
    """The lines the working tree adds or changes against HEAD in the target's folders, by absolute path; a new file whole."""
    inside = [os.path.relpath(root, home) for root in roots]
    code, diff, _ = git(home, "diff", "-U0", "--no-color", "--no-ext-diff", "HEAD", "--", *inside)
    found = {}
    path = ""
    for line in diff.splitlines() if code == 0 else []:
        if line.startswith("+++ "):
            path = "" if line[4:] == "/dev/null" else os.path.join(home, line[4:].removeprefix("b/"))
        elif line.startswith("@@") and path:
            hunk = re.search(r"\+(\d+)(?:,(\d+))?", line)
            start, count = int(hunk.group(1)), int(hunk.group(2) if hunk.group(2) is not None else 1)
            found.setdefault(path, []).extend(range(start, start + count))
    code, listed, _ = git(home, "ls-files", "-o", "--exclude-standard", "--", *inside)
    for relative in listed.splitlines() if code == 0 else []:
        path = os.path.join(home, relative)
        try:
            with open(path, encoding="utf-8", errors="replace") as source:
                found[path] = list(range(1, sum(1 for _ in source) + 1))
        except OSError:
            continue
    return {path: lines for path, lines in found.items() if lines}


def spans(lines):
    """Lines as spans, `12-13, 40`."""
    said, start, last = [], None, None
    for line in sorted(lines):
        if start is not None and line == last + 1:
            last = line
            continue
        if start is not None:
            said.append(str(start) if start == last else "%d-%d" % (start, last))
        start = last = line
    if start is not None:
        said.append(str(start) if start == last else "%d-%d" % (start, last))
    return ", ".join(said)


def masked(text, masks):
    for mask in masks:
        text = mask.sub(MASKED, text)
    return text


def evidence(before, after, masks):
    """How one request's answer changed, as lines: the status, then the body's diff; empty when it did not."""
    lines = []
    if (before["status"], before["error"]) != (after["status"], after["error"]):
        lines.append("status %s → %s" % (before["error"] or before["status"], after["error"] or after["status"]))
    body = list(difflib.unified_diff(masked(before["body"], masks).splitlines(), masked(after["body"], masks).splitlines(), "from/body", "to/body", lineterm="", n=1))
    if len(body) > DIFF_LINES:
        body = body[:DIFF_LINES] + ["… %d more lines differ" % (len(body) - DIFF_LINES)]
    return "\n".join(lines + body)


def main():
    job = json.load(sys.stdin)
    home = job["home"]
    answer = {"label": job["label"], "from": {"ref": job["from"], "sha": "", "error": ""}, "to": {"ref": "work", "sha": "", "error": ""}, "error": "", "cases": [], "unreached": {}, "measured": False}

    masks = []
    for source in job["masks"]:
        try:
            masks.append(re.compile(source))
        except re.error as error:
            answer["error"] = "the mask %s is no regular expression: %s" % (source, error)
    if not job["requests"]:
        answer["error"] = "no request is kept to play"

    played = [None, None]
    # A database of each build's own, both made at once in the warm container
    container, databases = "", {}
    if not answer["error"] and job.get("db"):
        try:
            container, port = warm.warm(job.get("project") or home, job["db"]["image"])
            databases = warm.fresh(container, port, ["from", "to"])
        except warm.Cold as cold:
            answer["error"] = "its database could not be had: %s" % cold
    url = lambda side: databases[side][1] if side in databases else ""

    def before():
        code, sha, _ = git(home, "rev-parse", "--verify", "--quiet", job["from"] + "^{commit}")
        if code != 0:
            raise Stop("git knows no commit by the name %s" % job["from"])
        answer["from"]["sha"] = sha
        return played_on(job, checkout(home, job["label"], sha), url("from"))

    def after():
        return played_on(job, home, url("to"), changed_lines(home, job.get("roots") or []))

    if not answer["error"]:
        # The two builds share nothing (each its folder and its database): they play side by side
        with ThreadPoolExecutor(max_workers=2) as pool:
            for at, (side, running) in enumerate([("from", pool.submit(before)), ("to", pool.submit(after))]):
                try:
                    played[at] = running.result()
                except Stop as stop:
                    answer[side]["error"] = str(stop)
    if databases:
        warm.dropped(container, [database for database, _ in databases.values()])

    if played[0] is not None and played[1] is not None:
        for line, before, after in zip(job["requests"], played[0]["answers"], played[1]["answers"]):
            said = evidence(before, after, masks)
            answer["cases"].append({"line": line, "isChanged": said != "", "evidence": said})
    if played[1] is not None:
        answer["measured"] = bool(played[1].get("measured"))
        answer["unreached"] = {os.path.relpath(path, home): spans(lines) for path, lines in (played[1].get("unreached") or {}).items()}

    json.dump(answer, sys.stdout)


if __name__ == "__main__":
    main()
