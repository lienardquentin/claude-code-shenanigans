"""Starts Gondor, Rohan, the riders and Anor, each writing all it says to a file of its own under logs/.

    uv run --project beacons python beacons/muster.py

A realm is started again when its code changes; Anor, the Nuxt frontend, reloads by itself, and is left out until
its packages are installed (npm install --prefix beacons/anor). Everything a process writes goes to its file, a
crash at import included, which is what a watcher of the logs needs to see. Ctrl+C stops them all.
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
ENV = {**os.environ, "PYTHONUNBUFFERED": "1", "PYTHONUTF8": "1", "NUXT_TELEMETRY_DISABLED": "1", "NO_COLOR": "1"}


@dataclass
class Member:
    name: str
    argv: list[str]
    cwd: Path = HERE
    # Whether it is started again when its code changes: not what reloads by itself
    restarts: bool = True
    log: IO[str] = field(init=False)
    process: subprocess.Popen = field(init=False)

    def start(self) -> None:
        self.process = subprocess.Popen(self.argv, cwd=self.cwd, env=ENV, stdout=self.log, stderr=subprocess.STDOUT)

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
        self.log.write(f"{text}\n")
        self.log.flush()


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
            # Started afresh each time: yesterday's errors are not today's
            member.log = open(LOGS / f"{member.name}.log", "w", encoding="utf-8")
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
