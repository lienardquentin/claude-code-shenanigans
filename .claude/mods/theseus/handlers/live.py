#!/usr/bin/env python3
"""Plays a service's kept requests on two builds against its real dependencies, for verify's live stage.

The service runs in a Kubernetes cluster, deployed from a build that is neither HEAD nor the working tree, so the
two builds cannot be compared there. Each build is run here instead, in-process as the fast stage runs it, with the
environment the deployed workload has: its variables as its spec sets them, a secret's value read from the secret,
and each service named in `forward` reached through a `kubectl port-forward` of its own, its address in every value
put to the forwarded one. What the project sets in `env` is laid over that.

Nothing is left behind. With `scratch`, the variable that holds the database's address, each build plays against a
copy of the database of its own: one copy made in the database's pod from a dump of it, a second made from the first
(so both builds start from the very same rows, whatever the shared database does meanwhile), the variable pointed at
each, and both dropped once played. A build's migrations (a column its schema adds) then run on its copy alone, and
the shared database is only read. Both builds then answer from the same data, so their answers are compared value
for value, the project's masks applied, as the fast stage compares them. Without it, every request carries an id of the run's own
(`verify-<time>-<build>-<n>`) for the service to file what it writes under: before the first build plays, `before`
reads what the database holds that a request may undo; after each build, every `cleanup` statement is run with that id,
and `restore` puts back what `before` read. Both run in the database's own pod, through its own tools, which let them in
with no password. The port forwards are ended last, whatever happened.

A context whose name holds "prod" is never touched: nothing is read from it, and nothing is run in it.

Without `scratch`, builds are compared by their answers' status and shape (each object's keys and each value's type),
not their values: the shared database changes while the run lasts, by others' doing.

Reads one JSON job on stdin and writes one JSON answer on stdout:

    {"home", "label", "app", "python", "env": {...}, "requests": [...], "from",
     "live": {"workload", "forward": [...], "env": {...}, "db", "before", "cleanup": [...], "restore", "scratch"}}

The answer: {"label", "where", "skipped", "error", "cases": [{"line", "isChanged", "evidence"}]}
"""

import base64
import difflib
import json
import os
import re
import shutil
import subprocess
import sys
import time
from urllib.parse import urlsplit

from prove import Stop, checkout, git, tail

HERE = os.path.dirname(os.path.abspath(__file__))
SIDE_SECONDS = 180
FORWARD_SECONDS = 20
COPY_SECONDS = 300
PSQL = 'exec psql -X -q -A -t -F "|" -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-${POSTGRES_USER:-postgres}}" -c "$0"'
# The database copied whole into a new one named $0, in its own pod: a dump read back, its owners left out
COPY = (
    'set -e; user="${POSTGRES_USER:-postgres}"; createdb -U "$user" "$0"; '
    'pg_dump -U "$user" -d "${POSTGRES_DB:-$user}" --no-owner --no-privileges | psql -X -q -v ON_ERROR_STOP=1 -U "$user" -d "$0" >/dev/null'
)
DROP = 'exec dropdb -U "${POSTGRES_USER:-postgres}" --if-exists --force "$0"'
# A second copy made from the first, row for row, named $0 from $1
TWIN = 'exec createdb -U "${POSTGRES_USER:-postgres}" -T "$1" "$0"'


def kubectl(context, namespace, *args, stdin=None, seconds=60):
    done = subprocess.run(["kubectl", "--context", context, "-n", namespace, *args], input=stdin, capture_output=True, text=True, errors="replace", timeout=seconds)
    if done.returncode != 0:
        raise Stop("kubectl %s failed: %s" % (args[0], tail(done.stderr, 2)))
    return done.stdout


def workload_env(context, namespace, kind, name):
    """The variables the deployed workload's first container runs with, each secret read from its secret; and the
    secrets' values, to be kept out of everything the handler answers."""
    spec = json.loads(kubectl(context, namespace, "get", kind, name, "-o", "json"))
    if not (spec.get("status", {}).get("readyReplicas") or 0):
        return None
    env = {}
    secrets = []
    for variable in spec["spec"]["template"]["spec"]["containers"][0].get("env", []):
        if "value" in variable:
            env[variable["name"]] = variable["value"]
            continue
        secret = variable.get("valueFrom", {}).get("secretKeyRef")
        if secret:
            held = kubectl(context, namespace, "get", "secret", secret["name"], "-o", "jsonpath={.data.%s}" % secret["key"].replace(".", "\\."))
            env[variable["name"]] = base64.b64decode(held).decode() if held else ""
            secrets.append(env[variable["name"]])
    return env, secrets


def redacted(answer, secrets):
    """An answer with every secret's value written <secret>, wherever an app or an error put it: the answer is shown
    in the pane, to Claude and to the reviewers. A value under four characters says too little to be one."""
    text = json.dumps(answer)
    for secret in sorted({one for one in secrets if len(one) >= 4}, key=len, reverse=True):
        text = text.replace(json.dumps(secret)[1:-1], "<secret>")
    return json.loads(text)


def forward(context, namespace, service, port):
    """A port-forward to a service, and the local port it listens on."""
    process = subprocess.Popen(["kubectl", "--context", context, "-n", namespace, "port-forward", "svc/" + service, ":" + port], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    started = time.monotonic()
    while time.monotonic() - started < FORWARD_SECONDS:
        line = process.stdout.readline()
        found = re.search(r"127\.0\.0\.1:(\d+)", line)
        if found:
            return process, found.group(1)
        if process.poll() is not None:
            break
    process.kill()
    raise Stop("%s:%s could not be forwarded: %s" % (service, port, tail(process.stderr.read() if process.stderr else "", 2)))


def psql(context, namespace, db, sql):
    """The rows a statement answers, run in the database's own pod: each a list of its columns."""
    out = kubectl(context, namespace, "exec", db, "--", "sh", "-c", PSQL, sql)
    return [line.split("|") for line in out.splitlines() if line.strip()]


def copied(context, namespace, db, name):
    """A copy of the database, made in its own pod under a name of the run's own."""
    kubectl(context, namespace, "exec", db, "--", "sh", "-c", COPY, name, seconds=COPY_SECONDS)


def twinned(context, namespace, db, name, source):
    """A copy of a copy, nobody connected to the first: both start from the same rows."""
    kubectl(context, namespace, "exec", db, "--", "sh", "-c", TWIN, name, source, seconds=COPY_SECONDS)


def dropped(context, namespace, db, name):
    """The copy taken away, whoever is still connected to it."""
    kubectl(context, namespace, "exec", db, "--", "sh", "-c", DROP, name)


def pointed_at(address, name):
    """A database's address, its database named `name`: a URL's path, or a connection string's dbname."""
    if "://" in address:
        return urlsplit(address)._replace(path="/" + name).geturl()
    if re.search(r"(^|\s)dbname=", address):
        return re.sub(r"(^|\s)dbname=\S*", lambda found: found.group(1) + "dbname=" + name, address)
    return (address + " dbname=" + name).strip()


def quoted(value):
    return "'" + value.replace("'", "''") + "'"


def shape(value):
    """What an answer is made of: each object's keys, each value's type, the shapes a list holds."""
    if isinstance(value, dict):
        return {key: shape(held) for key, held in sorted(value.items())}
    if isinstance(value, list):
        seen = []
        for held in value:
            one = shape(held)
            if one not in seen:
                seen.append(one)
        return seen
    return "null" if value is None else type(value).__name__


def described(answer):
    if answer["error"]:
        return answer["error"]
    try:
        body = json.dumps(shape(json.loads(answer["body"])), sort_keys=True)
    except ValueError:
        body = "text"
    return "%s %s" % (answer["status"], body)


def valued(answer, masks):
    """An answer as it is, its status and its body, each mask applied."""
    if answer["error"]:
        return answer["error"]
    body = answer["body"]
    for mask in masks:
        body = mask.sub("<masked>", body)
    return "%s\n%s" % (answer["status"], body)


def changes(was, now, most=30):
    """How one answer became another, as the lines that differ."""
    lines = [line for line in difflib.unified_diff(was.splitlines(), now.splitlines(), "from", "to", lineterm="", n=1)]
    return "\n".join(lines[:most] + (["… %d more lines differ" % (len(lines) - most)] if len(lines) > most else []))


def play(job, folder, env, rid):
    python = os.path.join(folder, job["python"]) if job["python"] else folder
    uv = shutil.which("uv")
    command = [uv, "run", "--quiet", "--project", python, "python", "-P"] if uv and os.path.isfile(os.path.join(python, "pyproject.toml")) else [sys.executable, "-P"]
    try:
        done = subprocess.run(
            [*command, os.path.join(HERE, "play_http.py")],
            input=json.dumps({"app": job["app"], "requests": job["requests"], "rid": rid}),
            cwd=python, env={**os.environ, **env, "PYTHONPATH": python, "NO_COLOR": "1"},
            capture_output=True, text=True, errors="replace", timeout=SIDE_SECONDS,
        )
    except subprocess.TimeoutExpired:
        raise Stop("its requests were ended after %d seconds" % SIDE_SECONDS)
    try:
        return json.loads(done.stdout)["answers"]
    except (ValueError, KeyError, TypeError):
        raise Stop("its app did not answer (exit %d): %s" % (done.returncode, tail(done.stderr, 4)))


def main():
    job = json.load(sys.stdin)
    live = job["live"]
    answer = {"label": job["label"], "where": live["workload"], "skipped": "", "error": "", "cases": []}
    parts = live["workload"].split("/")

    if len(parts) != 4:
        answer["error"] = "the live workload is said as context/namespace/kind/name, not %s" % live["workload"]
        return json.dump(answer, sys.stdout)

    context, namespace, kind, name = parts
    if not live.get("isAllowed"):
        answer["error"] = "the context %s is not named in live_contexts in .claude/theseus.toml: verify reads nothing from it and runs nothing in it" % context
        return json.dump(answer, sys.stdout)
    if "prod" in context.lower():
        answer["error"] = "the context %s names prod: verify reads nothing from it and runs nothing in it" % context
        return json.dump(answer, sys.stdout)

    forwards = []
    rid = "verify-%d" % int(time.time())
    snapshot = []
    secrets = []
    try:
        found = workload_env(context, namespace, kind, name)
        if found is None:
            answer["skipped"] = "%s is not running" % live["workload"]
            return json.dump(answer, sys.stdout)
        env, secrets = found

        for one in live["forward"]:
            service, _, port = one.partition(":")
            process, local = forward(context, namespace, service, port)
            forwards.append(process)
            env = {key: value.replace("%s:%s" % (service, port), "127.0.0.1:%s" % local) for key, value in env.items()}
        env.update(live["env"])

        scratch = live.get("scratch", "")
        if scratch and not live["db"]:
            raise Stop("a copy of the database is asked for (live.scratch), but no live.db says where it runs")
        if scratch and not env.get(scratch):
            raise Stop("the workload has no %s to point at a copy of its database" % scratch)

        if live["before"] and not scratch:
            snapshot = psql(context, namespace, live["db"], live["before"])

        code, sha, _ = git(job["home"], "rev-parse", "--verify", "--quiet", job["from"] + "^{commit}")
        if code != 0:
            raise Stop("git knows no commit by the name %s" % job["from"])

        played = []
        sides = (("from", checkout(job["home"], job["label"], sha)), ("to", job["home"]))
        if scratch:
            # One dump of the shared database, then a twin of it: both builds start from the same rows
            copies = {side: "%s_%s" % (rid.replace("-", "_"), side) for side, _ in sides}
            try:
                copied(context, namespace, live["db"], copies["from"])
                twinned(context, namespace, live["db"], copies["to"], copies["from"])
                for side, folder in sides:
                    played.append(play(job, folder, {**env, scratch: pointed_at(env[scratch], copies[side])}, "%s-%s" % (rid, side)))
            finally:
                for copy in copies.values():
                    dropped(context, namespace, live["db"], copy)
        else:
            for side, folder in sides:
                try:
                    played.append(play(job, folder, env, "%s-%s" % (rid, side)))
                finally:
                    clean(context, namespace, live, rid, snapshot)

        masks = [re.compile(source) for source in job.get("masks") or []]
        for line, before, after in zip(job["requests"], played[0], played[1]):
            # Each build on the same rows: what they answered is compared as it is, masks applied; else its shape
            was, now = (valued(before, masks), valued(after, masks)) if scratch else (described(before), described(after))
            answer["cases"].append({"line": line, "isChanged": was != now, "evidence": "" if was == now else "live, with the real dependencies:\n%s" % changes(was, now)})
    except Stop as stop:
        answer["error"] = str(stop)
    except subprocess.TimeoutExpired:
        answer["error"] = "kubectl did not answer in time"
    finally:
        for process in forwards:
            process.kill()

    json.dump(redacted(answer, secrets), sys.stdout)


def clean(context, namespace, live, rid, snapshot):
    """What the run wrote, taken out; what it undid, put back."""
    if not live["db"]:
        return
    for statement in live["cleanup"]:
        psql(context, namespace, live["db"], statement.replace("{rid}", rid))
    if live["restore"] and snapshot:
        rows = ",".join("(%s)" % ",".join(quoted(column) for column in row) for row in snapshot)
        psql(context, namespace, live["db"], live["restore"].replace("{rows}", rows))


if __name__ == "__main__":
    main()
