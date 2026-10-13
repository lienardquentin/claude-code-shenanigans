#!/usr/bin/env python3
"""Plays a project's kept runs on two builds of a tool and says what differs, for the anduril mod.

A build is the working tree's (`work`) or a commit's (any name git resolves: a tag, a branch, HEAD~3). The working
tree is built where it is. A commit is checked out in a worktree of the tool's own, .anduril/trees/<label>, built
there, and its binary kept under .anduril/builds/<label>/<sha>, so a commit is built once.

Each build plays the kept runs in order, in a folder of its own that starts as a copy of the tool's source folder as
the working tree has it (what git tracks, and what it neither tracks nor ignores): both builds read the same files,
and nothing a run writes there reaches the project. The folder, the home and the temporary folder beside it are at
the same path for both, so a path a run prints is the same text. No run has a terminal or a standard input.

What is compared, run by run: how it ended, what it wrote to each stream, and the files it left changed, each text
file as a diff. Where strace is there, a run is traced: what it wrote outside those folders, and what it wrote and
removed again before it ended, are compared too.

Reads one JSON job on stdin and writes one JSON answer on stdout:

    {"home", "label", "binary", "root", "build", "masks": [...], "corpus": [...], "from", "to", "mergeBase"}
"""

import difflib
import hashlib
import json
import os
import re
import shlex
import shutil
import signal
import subprocess
import sys
import time

# How long one run may take before it is ended
RUN_SECONDS = 60
# How many lines of a stream's or a file's diff are handed back
DIFF_LINES = 80
# What a mask leaves where it matched
MASKED = "<masked>"
# A file is compared as text up to this size, and by its bytes alone past it
TEXT_BYTES = 256 * 1024
# The system calls that make, change or remove a file
TRACED = "open,openat,openat2,creat,unlink,unlinkat,rename,renameat,renameat2,mkdir,mkdirat,rmdir,truncate,link,linkat,symlink,symlinkat"
# Where a write is no file of anyone's
NO_FILES = ("/dev/", "/proc/", "/sys/")


class Stop(Exception):
    """What ends the making of one side, said as its error."""


def git(home, *args):
    done = subprocess.run(["git", *args], cwd=home, capture_output=True, text=True, errors="replace")
    return done.returncode, done.stdout.strip(), done.stderr.strip()


def tail(text, lines=12):
    return "\n".join(text.strip().splitlines()[-lines:])


def build(command, cwd):
    """Runs the project's build command through the person's login shell, so it finds what their terminal finds."""
    shell = os.environ.get("SHELL") or "/bin/sh"
    done = subprocess.run([shell, "-lc", command], cwd=cwd, stdin=subprocess.DEVNULL, capture_output=True, text=True, errors="replace")
    if done.returncode != 0:
        raise Stop("it does not build (%s, exit %d):\n%s" % (command, done.returncode, tail(done.stderr or done.stdout)))


def resolve(home, ref):
    if ref == "work":
        return {"ref": "work", "sha": "", "error": ""}
    code, sha, _ = git(home, "rev-parse", "--verify", "--quiet", ref + "^{commit}")
    if code != 0:
        return {"ref": ref, "sha": "", "error": "git knows no commit by the name %s" % ref}
    return {"ref": ref, "sha": sha, "error": ""}


def binary_of(job, side):
    """The binary of one side, built when it has to be."""
    home, label = job["home"], job["label"]
    if side["ref"] == "work":
        if job["build"]:
            build(job["build"], home)
        if not os.path.isfile(job["binary"]):
            raise Stop("it is not built: %s is not there" % job["binary"])
        return job["binary"]

    kept = os.path.join(home, ".anduril", "builds", label, side["sha"], os.path.basename(job["binary"]))
    if os.path.isfile(kept):
        return kept
    if not job["build"]:
        raise Stop("a commit cannot be built: the project names no build command (%s.build=…)" % label)

    tree = os.path.join(home, ".anduril", "trees", label)
    if os.path.isdir(tree):
        code, _, said = git(tree, "checkout", "--detach", "--force", "--quiet", side["sha"])
    else:
        os.makedirs(os.path.dirname(tree), exist_ok=True)
        code, _, said = git(home, "worktree", "add", "--detach", "--force", tree, side["sha"])
    if code != 0:
        raise Stop("it could not be checked out: %s" % tail(said, 3))

    build(job["build"], tree)
    built = os.path.join(tree, os.path.relpath(job["binary"], home))
    if not os.path.isfile(built):
        raise Stop("its build left no %s" % os.path.relpath(job["binary"], home))
    os.makedirs(os.path.dirname(kept), exist_ok=True)
    shutil.copy2(built, kept)
    return kept


def tracer():
    """The tracer's path and nothing, or nothing and why no run is traced."""
    path = shutil.which("strace")
    if path is None:
        return None, "strace is not installed"
    try:
        tried = subprocess.run([path, "-f", "-qq", "-e", "trace=" + TRACED, "-o", os.devnull, "true"], capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return None, "strace could not be run"
    if tried.returncode != 0:
        return None, "strace may not trace here (%s)" % (tail(tried.stderr, 1) or "exit %d" % tried.returncode)
    return path, ""


def sandbox(job, binary):
    """A fresh place to play in: the tool's source folder as the working tree has it, an empty home, an empty
    temporary folder, and the tool under its own name."""
    home = job["home"]
    base = os.path.join(home, ".anduril", "replay")
    shutil.rmtree(base, ignore_errors=True)
    root = os.path.join(base, "root")
    for name in ("root", "home", "tmp", ".bin"):
        os.makedirs(os.path.join(base, name))
    os.symlink(binary, os.path.join(base, ".bin", job["label"]))
    if job["root"]:
        code, listed, _ = git(home, "ls-files", "-co", "--exclude-standard", "-z", "--", job["root"])
        for path in listed.split("\0") if code == 0 else []:
            source = os.path.join(home, path)
            if path and os.path.isfile(source):
                target = os.path.join(root, os.path.relpath(source, job["root"]))
                os.makedirs(os.path.dirname(target), exist_ok=True)
                shutil.copy2(source, target)
    return base


def snapshot(base, before):
    """Every file under the folders played in, by path: (size, time written, hash). A file whose size and time are
    what they were is not read again."""
    now = {}
    for name in ("root", "home", "tmp"):
        for folder, _, names in os.walk(os.path.join(base, name)):
            for file_name in names:
                path = os.path.join(folder, file_name)
                key = os.path.relpath(path, base)
                try:
                    stat = os.stat(path)
                    held = before.get(key)
                    if held is not None and held[0] == stat.st_size and held[1] == stat.st_mtime_ns:
                        now[key] = held
                        continue
                    with open(path, "rb") as file:
                        now[key] = (stat.st_size, stat.st_mtime_ns, hashlib.sha1(file.read()).hexdigest())
                except OSError:
                    pass
    return now


def text_of(path):
    """A file's text when it is one of a size to compare line by line; None for bytes, or too many of them."""
    try:
        if os.path.getsize(path) > TEXT_BYTES:
            return None
        with open(path, "rb") as file:
            return file.read().decode("utf-8")
    except (OSError, UnicodeDecodeError):
        return None


STRING = re.compile(r'"((?:[^"\\]|\\.)*)"')
CALL = re.compile(r"^\d+\s+(\w+)\((.*)\)\s+=\s+(-?\d+)")
DIRFD = re.compile(r"^(?:AT_FDCWD|\d+)<([^>]*)>")


def traced(trace_file, cwd):
    """What a run's trace says it wrote and what it removed, as whole paths. Calls that failed are left out."""
    wrote, removed = [], []
    try:
        with open(trace_file, "r", errors="replace") as file:
            lines = file.readlines()
    except OSError:
        return wrote, removed

    def whole(path, args):
        if not os.path.isabs(path):
            under = DIRFD.match(args)
            path = os.path.join(under.group(1) if under else cwd, path)
        return os.path.normpath(path)

    for line in lines:
        call = CALL.match(line)
        if call is None or int(call.group(3)) < 0:
            continue
        name, args = call.group(1), call.group(2)
        # A path as strace writes it: bytes past ASCII as escapes
        paths = [whole(found.encode("latin-1", "replace").decode("unicode_escape").encode("latin-1", "replace").decode("utf-8", "replace"), args) for found in STRING.findall(args)]
        if not paths:
            continue
        if name in ("open", "openat", "openat2", "creat"):
            if name == "creat" or re.search(r"O_(WRONLY|RDWR|CREAT|TRUNC|APPEND)", args):
                wrote.append(paths[0])
        elif name in ("unlink", "unlinkat", "rmdir"):
            removed.append(paths[0])
        elif name in ("rename", "renameat", "renameat2", "link", "linkat", "symlink", "symlinkat"):
            wrote.append(paths[-1])
            if name.startswith("rename"):
                removed.append(paths[0])
        else:
            wrote.append(paths[0])
    return wrote, removed


def play(job, binary, strace):
    """Every kept run on one binary, in order and in one place. Answers how each ended, the state of every file after
    each, and the text of each file a run changed."""
    base = sandbox(job, binary)
    root = os.path.join(base, "root")
    env = {
        "PATH": os.path.join(base, ".bin") + os.pathsep + os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": os.path.join(base, "home"),
        "TMPDIR": os.path.join(base, "tmp"),
        "LANG": "C.UTF-8",
        "TERM": "xterm-256color",
        "COLUMNS": "80",
        "LINES": "24",
    }
    trace_file = os.path.join(base, "trace")
    state = snapshot(base, {})
    outcomes = []
    for line in job["corpus"]:
        outcome = {"exitCode": -1, "signal": "", "durationMs": 0, "stdoutBytes": 0, "stderrBytes": 0, "error": "", "stdout": "", "stderr": ""}
        played = {"outcome": outcome, "state": state, "touched": {}, "outside": [], "transient": []}
        outcomes.append(played)
        try:
            argv = shlex.split(line)
        except ValueError as error:
            outcome["error"] = "the line does not read as a command: %s" % error
            continue
        if not argv or argv[0] != job["label"]:
            outcome["error"] = "the line is no run of %s" % job["label"]
            continue
        command = argv if strace is None else [strace, "-f", "-qq", "-y", "-s", "4096", "-e", "trace=" + TRACED, "-o", trace_file, "--", *argv]
        started = time.monotonic()
        try:
            done = subprocess.run(command, cwd=root, env=env, stdin=subprocess.DEVNULL, capture_output=True, timeout=RUN_SECONDS)
        except subprocess.TimeoutExpired:
            outcome["error"] = "it was ended after %d seconds" % RUN_SECONDS
            continue
        except OSError as error:
            outcome["error"] = "it could not be run: %s" % error.strerror
            continue
        outcome["durationMs"] = round((time.monotonic() - started) * 1000, 3)
        code = done.returncode
        if code < 0:
            try:
                outcome["signal"] = signal.Signals(-code).name
            except ValueError:
                outcome["signal"] = "signal %d" % -code
        outcome["exitCode"] = code if code >= 0 else 128 - code
        outcome["stdoutBytes"], outcome["stderrBytes"] = len(done.stdout), len(done.stderr)
        outcome["stdout"] = done.stdout.decode("utf-8", "replace")
        outcome["stderr"] = done.stderr.decode("utf-8", "replace")

        if strace is not None:
            wrote, removed = traced(trace_file, root)
            try:
                os.remove(trace_file)
            except OSError:
                pass
            inside = base + os.sep
            played["outside"] = sorted({path for path in wrote if not path.startswith(inside) and not path.startswith(NO_FILES) and path != trace_file})
            played["transient"] = sorted({os.path.relpath(path, base) if path.startswith(inside) else path for path in wrote if path in removed and not os.path.lexists(path)})

        after = snapshot(base, state)
        for key in set(state) | set(after):
            if state.get(key, (0, 0, ""))[2] != after.get(key, (0, 0, ""))[2]:
                played["touched"][key] = text_of(os.path.join(base, key)) if key in after else None
        state = after
        played["state"] = state
    return outcomes


def masked(text, masks):
    for mask in masks:
        text = mask.sub(MASKED, text)
    return text


def lines_diff(before, after, name):
    """The lines that differ, as a unified diff, cut where it grows long; empty when the two are the same."""
    if before == after:
        return ""
    lines = list(difflib.unified_diff(before.splitlines(), after.splitlines(), "from/" + name, "to/" + name, lineterm="", n=2))
    if len(lines) > DIFF_LINES:
        lines = lines[:DIFF_LINES] + ["… %d more lines differ" % (len(lines) - DIFF_LINES)]
    return "\n".join(lines)


def text_at(job, side, index, key):
    """A file's text on one side once run `index` was played: as its last run to change it left it, else as the
    working tree has it. None for a file that is not text, or not there."""
    for played in reversed(side[: index + 1]):
        if key in played["touched"]:
            return played["touched"][key]
    if key.startswith("root" + os.sep) and job["root"]:
        return text_of(os.path.join(job["root"], os.path.relpath(key, "root")))
    return None


def files_diff(job, before, after, index, masks):
    """The files run `index` changed on either side that are not the same on both once it was played."""
    differing = []
    one, other = before[index], after[index]
    for key in sorted(set(one["touched"]) | set(other["touched"])):
        had, has = one["state"].get(key), other["state"].get(key)
        if (had and had[2]) == (has and has[2]):
            continue
        if had is None or has is None:
            # A file one build alone left: what it holds, when it is text
            held = text_at(job, before if has is None else after, index, key)
            diff = "" if held is None else lines_diff(masked(held, masks) if has is None else "", "" if has is None else masked(held, masks), key)
            differing.append({"path": key, "change": "added" if had is None else "removed", "diff": diff})
            continue
        was, now = text_at(job, before, index, key), text_at(job, after, index, key)
        if was is None or now is None:
            differing.append({"path": key, "change": "changed", "diff": "not text, or too large to compare by line: %d bytes, then %d" % (had[0], has[0])})
            continue
        diff = lines_diff(masked(was, masks), masked(now, masks), key)
        if diff:
            differing.append({"path": key, "change": "changed", "diff": diff})
    return differing


def main():
    job = json.load(sys.stdin)
    home = job["home"]
    answer = {"label": job["label"], "from": resolve(home, job["from"]), "to": resolve(home, job["to"]), "error": "", "untraced": "", "cases": []}
    sides = [answer["from"], answer["to"]]

    masks = []
    for source in job["masks"]:
        try:
            masks.append(re.compile(source))
        except re.error as error:
            answer["error"] = "the mask %s is no regular expression: %s" % (source, error)
    if not job["corpus"]:
        answer["error"] = "no run is kept to play"

    # Against where the two parted, in place of where the first now stands: what `to` alone changed
    if job.get("mergeBase") and not any(side["error"] for side in sides) and answer["from"]["sha"]:
        code, base, _ = git(home, "merge-base", answer["from"]["sha"], answer["to"]["sha"] or "HEAD")
        if code == 0 and base:
            answer["from"] = {"ref": "where it left %s" % answer["from"]["ref"], "sha": base, "error": ""}
            sides[0] = answer["from"]

    strace, answer["untraced"] = tracer()
    played = []
    for side in sides:
        if answer["error"] or side["error"]:
            played.append(None)
            continue
        try:
            played.append(play(job, binary_of(job, side), strace))
        except Stop as stop:
            side["error"] = str(stop)
            played.append(None)
    shutil.rmtree(os.path.join(home, ".anduril", "replay"), ignore_errors=True)

    if played[0] is not None and played[1] is not None:
        before, after = played
        for index, line in enumerate(job["corpus"]):
            one, other = before[index]["outcome"], after[index]["outcome"]
            out = lines_diff(masked(one.pop("stdout"), masks), masked(other.pop("stdout"), masks), "stdout")
            err = lines_diff(masked(one.pop("stderr"), masks), masked(other.pop("stderr"), masks), "stderr")
            files = files_diff(job, before, after, index, masks)
            outside = {"from": before[index]["outside"], "to": after[index]["outside"]}
            transient = {"from": before[index]["transient"], "to": after[index]["transient"]}
            is_changed = (
                bool(out or err or files)
                or (one["exitCode"], one["signal"], one["error"]) != (other["exitCode"], other["signal"], other["error"])
                or outside["from"] != outside["to"]
                or transient["from"] != transient["to"]
            )
            answer["cases"].append(
                {"line": line, "isChanged": is_changed, "from": one, "to": other, "stdoutDiff": out, "stderrDiff": err, "files": files, "outside": outside, "transient": transient}
            )

    json.dump(answer, sys.stdout)


if __name__ == "__main__":
    main()
