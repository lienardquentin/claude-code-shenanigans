#!/usr/bin/env python3
"""A warm database for the argonath mod's fast stage: one container a project, kept between proofs.

A container started for every proof is what makes testcontainers slow: the image starts, the cluster initialises, the
server comes up, and only then is the first statement run. Here the container is started once, the first time a
proof needs it, and left running: a build then gets a database of its own in it, made empty from `template0` in
milliseconds and dropped once the build has played. Its data lives in memory (a tmpfs) with fsync off: nothing of it
is worth keeping, and nothing of it outlives the container. The argonath mod stops it when the session ends;
`python3 warm.py stop <home> <image>` does by hand, and `docker rm -f` on a container labelled `argonath.home` too.

Only Postgres is known: the image is any whose server is Postgres (`postgres:18-alpine`, `postgis/postgis:17-3.5`).
"""

import hashlib
import subprocess
import sys
import time
import uuid

# How long a container that was just started is given to take connections
READY_SECONDS = 60
USER = "argonath"
PASSWORD = "argonath"


class Cold(Exception):
    """Why no warm database could be had."""


def docker(*args, seconds=60):
    try:
        done = subprocess.run(["docker", *args], capture_output=True, text=True, errors="replace", timeout=seconds)
    except FileNotFoundError:
        raise Cold("docker is not installed")
    except subprocess.TimeoutExpired:
        raise Cold("docker %s did not answer in %d seconds" % (args[0], seconds))
    return done.returncode, done.stdout.strip(), done.stderr.strip()


def name_of(home, image):
    """The container of a project and an image: the same name every time, so a second proof finds it running."""
    return "argonath-db-" + hashlib.sha256(("%s|%s" % (home, image)).encode()).hexdigest()[:12]


def port_of(name):
    code, out, _ = docker("port", name, "5432/tcp")
    if code != 0 or not out:
        return ""
    # `127.0.0.1:49153`, a line an address it listens on
    return out.splitlines()[0].rsplit(":", 1)[-1]


def is_ready(name):
    code, _, _ = docker("exec", name, "pg_isready", "-q", "-U", USER, "-d", "postgres", seconds=10)
    return code == 0


def warm(home, image):
    """The running container's name and the port it listens on, on this machine's loopback; started when it is not."""
    name = name_of(home, image)
    code, out, _ = docker("inspect", "-f", "{{.State.Running}}", name)
    if code == 0 and out == "true" and port_of(name) and is_ready(name):
        return name, port_of(name)
    if code == 0:
        # Stopped, or up without its port: started afresh
        docker("rm", "-f", name)

    code, _, said = docker(
        "run", "-d", "--name", name, "--label", "argonath.home=%s" % home,
        "-e", "POSTGRES_USER=%s" % USER, "-e", "POSTGRES_PASSWORD=%s" % PASSWORD,
        "--tmpfs", "/var/lib/postgresql:rw",
        "-p", "127.0.0.1::5432", image,
        "-c", "fsync=off", "-c", "synchronous_commit=off", "-c", "full_page_writes=off",
        seconds=300,
    )
    if code != 0:
        raise Cold("the database container could not be started: %s" % " ".join(said.splitlines()[-2:]))

    started = time.monotonic()
    while time.monotonic() - started < READY_SECONDS:
        # The image's entrypoint starts a server of its own while it initialises: it is ready once the real one answers
        if is_ready(name) and port_of(name):
            code, _, _ = docker("exec", name, "psql", "-U", USER, "-d", "postgres", "-tAc", "SELECT 1", seconds=10)
            if code == 0:
                return name, port_of(name)
        time.sleep(0.3)
    raise Cold("the database container did not take connections in %d seconds" % READY_SECONDS)


def fresh(name, port, sides):
    """A database of each side's own, empty, made in one call into the container: the address of each, by side."""
    made = {side: "argonath_%s_%s" % (side, uuid.uuid4().hex[:8]) for side in sides}
    script = "set -e; for db in \"$@\"; do createdb -U %s -T template0 \"$db\"; done" % USER
    code, _, said = docker("exec", name, "sh", "-c", script, "sh", *made.values())
    if code != 0:
        raise Cold("a database could not be made: %s" % said)
    return {side: (database, "postgresql://%s:%s@127.0.0.1:%s/%s" % (USER, PASSWORD, port, database)) for side, database in made.items()}


def dropped(name, databases):
    """The databases taken away, in the background: nothing waits on it, and the next proof makes its own."""
    script = "for db in \"$@\"; do dropdb -U %s --if-exists --force \"$db\"; done" % USER
    subprocess.Popen(["docker", "exec", name, "sh", "-c", script, "sh", *databases], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)


def stop(home, image):
    docker("rm", "-f", name_of(home, image))


if __name__ == "__main__":
    if len(sys.argv) == 4 and sys.argv[1] == "stop":
        stop(sys.argv[2], sys.argv[3])
    else:
        sys.exit("usage: warm.py stop <home> <image>")
