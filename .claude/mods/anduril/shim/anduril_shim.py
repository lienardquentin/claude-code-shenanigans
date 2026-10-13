#!/usr/bin/env python3
"""Runs a command-line tool and keeps a record of the run, for the anduril mod.

The tool is run as it would be without this: its arguments, working directory, environment and standard input are
its own, and what it writes reaches whoever ran it, byte for byte. A stream that was a terminal is still one for the
tool (a pty stands in, of the same size), so its colours and its width do not change for being recorded; a stream
that was a pipe or a file is a pipe. When the reader of a pipe leaves (`tool | head`), the tool's own pipe is closed,
so it meets the broken pipe it would have met.

Once the tool has exited, one JSON file is written under <dir>/runs: what was run, how it ended, how long it took,
what it consumed, and what it wrote to each stream: all of it, or its start and its end. This exits as the tool did.

    anduril_shim.py --dir DIR --label NAME --binary PATH -- ARGS...
"""

import errno
import fcntl
import json
import os
import pty
import select
import signal
import subprocess
import sys
import termios
import time

# What is kept of each stream: all of it up to this many bytes, and past that its start and its end, half each.
# A tool that fails says why at the end. What lies between is counted and dropped.
KEPT_BYTES = 256 * 1024
HALF = KEPT_BYTES // 2
# How many records are kept: the oldest go once there are more.
KEPT_RUNS = 500
# The variables that change how a tool draws, written to the record when they are set.
DRAWING_ENV = ("NO_COLOR", "CLICOLOR", "CLICOLOR_FORCE", "FORCE_COLOR", "TERM", "COLUMNS", "LINES", "LANG", "LC_ALL")


def fail(message, code=127):
    sys.stderr.write("anduril: %s\n" % message)
    sys.exit(code)


def arguments(argv):
    """--dir, --label and --binary before `--`, the tool's own arguments after it."""
    if "--" not in argv:
        fail("usage: anduril_shim.py --dir DIR --label NAME --binary PATH -- ARGS...", 2)
    cut = argv.index("--")
    ours, theirs = argv[:cut], argv[cut + 1 :]
    named = dict(zip(ours[::2], ours[1::2]))
    for name in ("--dir", "--label", "--binary"):
        if name not in named:
            fail("%s is missing" % name, 2)
    return named["--dir"], named["--label"], named["--binary"], theirs


def stream_for(fd):
    """What the tool is given in place of our stream: (the end it writes to, the end we read, whether it is a pty)."""
    if os.isatty(fd):
        ours, theirs = pty.openpty()
        try:
            # The same size as the terminal it stands in for
            size = fcntl.ioctl(fd, termios.TIOCGWINSZ, b"\0" * 8)
            fcntl.ioctl(theirs, termios.TIOCSWINSZ, size)
            # No newline is rewritten on the way: the real terminal does that to what we hand it
            modes = termios.tcgetattr(theirs)
            modes[1] &= ~termios.ONLCR
            termios.tcsetattr(theirs, termios.TCSANOW, modes)
        except (OSError, termios.error):
            pass
        return theirs, ours, True
    ours, theirs = os.pipe()
    return theirs, ours, False


def columns_of(fd):
    try:
        return os.get_terminal_size(fd).columns
    except OSError:
        return 0


def relay(sources):
    """Hands on what the tool writes until every stream has ended. `sources` maps the end we read to its stream."""
    while sources:
        try:
            ready, _, _ = select.select(list(sources), [], [])
        except InterruptedError:
            continue
        for fd in ready:
            stream = sources[fd]
            try:
                chunk = os.read(fd, 65536)
            except OSError as error:
                # A pty whose other end is closed says so with an error where a pipe reads nothing
                if error.errno != errno.EIO:
                    raise
                chunk = b""
            if not chunk:
                os.close(fd)
                del sources[fd]
                continue
            stream["bytes"] += len(chunk)
            room = HALF - len(stream["head"])
            stream["head"] += chunk[:room]
            stream["tail"] += chunk[room:]
            # Cut back now and then, not at every chunk
            if len(stream["tail"]) > 4 * HALF:
                del stream["tail"][:-HALF]
            try:
                written = 0
                while written < len(chunk):
                    written += os.write(stream["to"], chunk[written:])
            except OSError:
                # Whoever read us has left: the tool is told the same way, by its own pipe closing
                os.close(fd)
                del sources[fd]


def kept(stream):
    """What the record holds of a stream, as text: the whole, or its start and its end around what was dropped."""
    head, tail = bytes(stream["head"]), bytes(stream["tail"][-HALF:])
    dropped = stream["bytes"] - len(head) - len(tail)
    if dropped <= 0:
        return (head + tail).decode("utf-8", "replace")
    # The end starts where the cut fell: not in the middle of a character
    while tail and tail[0] & 0xC0 == 0x80:
        tail = tail[1:]
    return "%s\n… %d bytes not kept …\n%s" % (head.decode("utf-8", "replace"), dropped, tail.decode("utf-8", "replace"))


def prune(runs):
    try:
        names = sorted(name for name in os.listdir(runs) if name.endswith(".json"))
        for name in names[: max(0, len(names) - KEPT_RUNS)]:
            os.remove(os.path.join(runs, name))
    except OSError:
        pass


def main():
    directory, label, binary, args = arguments(sys.argv[1:])
    if not os.path.isfile(binary):
        fail("%s is not built: %s is not there" % (label, binary))

    out_theirs, out_ours, out_tty = stream_for(1)
    err_theirs, err_ours, err_tty = stream_for(2)
    columns = columns_of(1) or columns_of(2)
    started_at = time.time()
    started = time.monotonic()
    try:
        child = subprocess.Popen([binary] + args, executable=binary, stdout=out_theirs, stderr=err_theirs, close_fds=True)
    except OSError as error:
        fail("%s could not be run: %s" % (binary, error.strerror), 126)
    os.close(out_theirs)
    os.close(err_theirs)

    # A Ctrl+C reaches the tool by itself, being in the terminal's foreground with us: we wait for how it ends.
    # What is sent to us alone is handed on.
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    for number in (signal.SIGTERM, signal.SIGHUP):
        signal.signal(number, lambda received, _frame: os.kill(child.pid, received))

    streams = {
        "stdout": {"to": 1, "head": bytearray(), "tail": bytearray(), "bytes": 0},
        "stderr": {"to": 2, "head": bytearray(), "tail": bytearray(), "bytes": 0},
    }
    relay({out_ours: streams["stdout"], err_ours: streams["stderr"]})

    while True:
        try:
            _, status, usage = os.wait4(child.pid, 0)
            break
        except InterruptedError:
            continue
    duration = time.monotonic() - started
    code = os.waitstatus_to_exitcode(status)
    child.returncode = code

    killed_by = ""
    if code < 0:
        try:
            killed_by = signal.Signals(-code).name
        except ValueError:
            killed_by = "signal %d" % -code

    try:
        built_at = int(os.stat(binary).st_mtime * 1000)
    except OSError:
        built_at = 0

    record = {
        "id": "%d-%d" % (int(started_at * 1000), os.getpid()),
        "label": label,
        "argv": args,
        "cwd": os.getcwd(),
        "by": os.environ.get("ANDURIL_BY", "person"),
        "startedAt": int(started_at * 1000),
        "durationMs": round(duration * 1000, 3),
        "exitCode": code if code >= 0 else 128 - code,
        "signal": killed_by,
        "userMs": round(usage.ru_utime * 1000, 3),
        "sysMs": round(usage.ru_stime * 1000, 3),
        # Kilobytes on Linux, bytes on macOS
        "maxRssKb": usage.ru_maxrss // 1024 if sys.platform == "darwin" else usage.ru_maxrss,
        "isStdinTty": os.isatty(0),
        "isStdoutTty": out_tty,
        "isStderrTty": err_tty,
        "columns": columns,
        "env": {name: os.environ[name] for name in DRAWING_ENV if name in os.environ},
        "binary": binary,
        "builtAt": built_at,
        "stdout": kept(streams["stdout"]),
        "stderr": kept(streams["stderr"]),
        "stdoutBytes": streams["stdout"]["bytes"],
        "stderrBytes": streams["stderr"]["bytes"],
    }

    # A record that cannot be written costs the run nothing: the tool has run, and its answer stands
    try:
        runs = os.path.join(directory, "runs")
        os.makedirs(runs, exist_ok=True)
        path = os.path.join(runs, record["id"] + ".json")
        with open(path + ".tmp", "w", encoding="utf-8") as file:
            json.dump(record, file)
        os.replace(path + ".tmp", path)
        prune(runs)
    except OSError:
        pass

    sys.exit(record["exitCode"])


if __name__ == "__main__":
    main()
