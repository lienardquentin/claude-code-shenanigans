"""Starts Gondor, Rohan, the riders and Anor, each writing all it says to a file of its own under logs/.

    uv run --project beacons python beacons/muster.py

A realm is started again when its code changes; Anor, the Nuxt frontend, reloads by itself, and is left out until
its packages are installed (npm install --prefix beacons/anor). Everything a process writes goes to its file, a
crash at import included, which is what a watcher of the logs needs to see. A file that has grown past two
megabytes is cut back to its last one, so that the logs stay small enough to read whole however long this runs.
Ctrl+C stops them all.
"""

import os
import shutil
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import IO

from watchfiles import watch

HERE = Path(__file__).resolve().parent
LOGS = HERE / "logs"
# Nuxt is told to send nothing of this project anywhere, and to write its log without colors
# A log past the first is cut back to the second, at the start of a line: what is kept is the latest
MAX_LOG_BYTES = 2 * 1024 * 1024
KEPT_LOG_BYTES = 1024 * 1024
ENV = {**os.environ, "PYTHONUNBUFFERED": "1", "PYTHONUTF8": "1", "NUXT_TELEMETRY_DISABLED": "1", "NO_COLOR": "1"}


@dataclass
class Member:
    name: str
    argv: list[str]
    cwd: Path = HERE
    # Whether it is started again when its code changes: not what reloads by itself
    restarts: bool = True
    log: IO[bytes] = field(init=False)
    process: subprocess.Popen = field(init=False)
    # What the process says and what is noted about it come from two threads
    lock: threading.Lock = field(default_factory=threading.Lock)

    def open(self) -> None:
        # Started afresh each time: yesterday's errors are not today's
        self.log = open(LOGS / f"{self.name}.log", "w+b")

    def start(self) -> None:
        # What it says comes through here and not straight to the file, so that the file can be cut back: a process
        # that held the file itself would go on writing where it was, past the cut
        self.process = subprocess.Popen(self.argv, cwd=self.cwd, env=ENV, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        threading.Thread(target=self.carry, args=(self.process.stdout,), daemon=True).start()

    def carry(self, said: IO[bytes]) -> None:
        """Writes each line the process says to its log, until it says no more."""
        for line in iter(said.readline, b""):
            self.write(line)

    def write(self, line: bytes) -> None:
        with self.lock:
            self.log.write(line)

            if self.log.tell() > MAX_LOG_BYTES:
                self.trim()

            self.log.flush()

    def trim(self) -> None:
        """Cuts the log back to its latest lines, in place: the file a watcher follows stays the same file."""
        self.log.seek(-KEPT_LOG_BYTES, os.SEEK_END)

        kept = self.log.read()
        kept = kept[kept.find(b"\n") + 1 :]

        self.log.seek(0)
        self.log.truncate()
        self.log.write(kept)

    def stop(self) -> None:
        if self.process.poll() is not None:
            return

        # On Windows a kill of the tree is the one way that never leaves a port held
        if os.name == "nt":
            subprocess.run(["taskkill", "/T", "/F", "/PID", str(self.process.pid)], capture_output=True)
        else:
            self.process.terminate()

        self.process.wait()

    def note(self, text: str) -> None:
        self.write(f"{text}\n".encode())


def serve(realm: str, port: int) -> list[str]:
    return [sys.executable, "-m", "uvicorn", f"{realm}.app:app", "--port", str(port), "--no-access-log"]


def keep(member: Member, halt: threading.Event) -> None:
    """Starts the realm again each time its code changes. Its own reloader is not used: this one behaves the same
    with or without a console, and starts a realm that died at import again once its code is put right."""
    for changes in watch(HERE / member.name, stop_event=halt):
        changed = sorted({Path(path).name for _, path in changes if path.endswith(".py")})

        if not changed:
            continue

        member.stop()
        member.note(f"WARNING:  {', '.join(changed)} changed, {member.name} starts again")
        member.start()


def main() -> None:
    LOGS.mkdir(exist_ok=True)

    company = [Member("gondor", serve("gondor", 8101)), Member("rohan", serve("rohan", 8102)), Member("riders", [sys.executable, "-m", "riders"])]
    npm = shutil.which("npm")

    if npm is not None and (HERE / "anor" / "node_modules").is_dir():
        company.append(Member("anor", [npm, "run", "dev"], cwd=HERE / "anor", restarts=False))
    else:
        print("anor: left out, its packages are not installed (npm install --prefix beacons/anor)", flush=True)

    halt = threading.Event()

    try:
        for member in company:
            member.open()
            member.start()

            if member.restarts:
                threading.Thread(target=keep, args=(member, halt), daemon=True).start()

            print(f"{member.name}: writing to {(LOGS / f'{member.name}.log').relative_to(HERE.parent)}", flush=True)

            # The riders set out once the gates are open
            time.sleep(1.5)

        print("Ctrl+C stops them.", flush=True)

        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        halt.set()

        for member in company:
            member.stop()


if __name__ == "__main__":
    main()
