#!/usr/bin/env python3
"""Plays requests against one build of a web app, in-process, for verify's service handler.

Run by the Python of that build's project, its folder on the path. Reads on stdin:

    {"app": "gondor.app:app", "requests": ["gondor GET /health", "gondor POST /beacons/amon-din/light {...}"],
     "rid": "", "ready": {"request": "GET /health", "match": "\"lit\": \\d", "seconds": 30},
     "changed": {"/abs/path/app.py": [12, 13]}}

and writes on stdout {"answers": [{"status", "body", "error"}, a request each, in order], "unreached": {path: [lines]},
"measured": bool}. The requests go one after another to one app, started once: what one does to the app's state, the
next sees. The body is JSON with its keys sorted, or the text.

`ready`, when given, is asked again and again before the first request, until it answers 2xx with a body that `match`
finds: an app that makes its tables in the background is so played once they are there. `changed`, when given, has
the requests played under coverage (coverage.py, which the caller puts in the build's environment): `unreached` is
then, of each file's changed lines, the statements no request ran.
"""

import importlib
import json
import logging
import re
import shlex
import sys
import time
import warnings

# What the libraries warn of is theirs, not the app's answer
warnings.simplefilter("ignore")


def answered(given):
    answer = {"status": given.status_code, "body": "", "error": ""}
    try:
        answer["body"] = json.dumps(given.json(), indent=2, sort_keys=True, ensure_ascii=False)
    except ValueError:
        answer["body"] = given.text
    return answer


def wait_until_ready(client, ready):
    """Asks the readiness request until it answers 2xx with a body its pattern finds; says why when it never does."""
    method, path = ready["request"].split()[:2]
    pattern = re.compile(ready.get("match") or ".")
    seconds = ready.get("seconds") or 30
    started = time.monotonic()
    last = "nothing"
    while time.monotonic() - started < seconds:
        try:
            answer = answered(client.request(method.upper(), path))
            if 200 <= answer["status"] < 300 and pattern.search(answer["body"]):
                return ""
            last = "%s %s" % (answer["status"], answer["body"][:120])
        except Exception as error:
            last = "%s: %s" % (type(error).__name__, error)
        time.sleep(0.2)
    return "the app was not ready in %d seconds: %s answered %s" % (seconds, ready["request"], last)


def ran(cov):
    """The lines measured so far, by file."""
    data = cov.get_data()
    return {path: set(data.lines(path) or []) for path in data.measured_files()}


def is_sysmon(cov):
    """Whether coverage measures through sys.monitoring, which sees every thread whenever it is started again."""
    return "sysmon" in str(dict(cov.sys_info()).get("core", "")).lower()


def unreached_of(cov, changed, earlier):
    """
    Of each changed file's lines, the statements no request ran, nor the app's import and startup (`earlier`): a line
    that is no statement is none of them.
    """
    found = {}
    for path, lines in changed.items():
        if not path.endswith(".py"):
            continue
        try:
            _, statements, _, missing, _ = cov.analysis2(path)
        except Exception:
            continue
        lost = sorted((set(lines) & set(statements) & set(missing)) - earlier.get(path, set()))
        if lost:
            found[path] = lost
    return found


def main():
    job = json.load(sys.stdin)
    changed = job.get("changed") or {}
    cov = None
    if changed:
        try:
            import coverage

            cov = coverage.Coverage(data_file=None, include=list(changed), branch=False)
            cov.start()
        except ImportError:
            cov = None

    module, _, attribute = job["app"].partition(":")
    app = getattr(importlib.import_module(module), attribute or "app")
    # The app's own log holds times and ids, which differ from build to build: what it answers is what is compared
    logging.disable(logging.CRITICAL)

    from fastapi.testclient import TestClient

    # A run that cleans up after itself names each request, for what the app writes to be found again
    rid = job.get("rid", "")
    answers = []
    earlier = {}
    with TestClient(app, raise_server_exceptions=False) as client:
        # What runs while the app is asked whether it is ready takes paths no kept request does (a retry, an error
        # before the tables are there): it is kept out of the measure. sys.monitoring records a line once, so what
        # import and startup ran is kept aside before the measure is paused, and the requests are measured afresh.
        # A tracer of another kind would not follow the app's thread once started again: there it measures on
        pauses = cov is not None and bool(job.get("ready")) and is_sysmon(cov)
        if pauses:
            cov.stop()
            earlier = ran(cov)
        waited = wait_until_ready(client, job["ready"]) if job.get("ready") else ""
        if pauses:
            cov.erase()
            cov.start()
        for number, line in enumerate(job["requests"]):
            answer = {"status": 0, "body": "", "error": ""}
            answers.append(answer)
            if waited:
                answer["error"] = waited
                continue
            try:
                _, method, path, *body = shlex.split(line)
                headers = {"X-Request-Id": "%s-%d" % (rid, number)} if rid else None
                answer.update(answered(client.request(method.upper(), path, json=json.loads(body[0]) if body else None, headers=headers)))
            except Exception as error:  # a request that cannot be made is said, and the next is played
                answer["error"] = "%s: %s" % (type(error).__name__, error)

    unreached = {}
    if cov is not None:
        cov.stop()
        unreached = unreached_of(cov, changed, earlier)

    json.dump({"answers": answers, "unreached": unreached, "measured": cov is not None}, sys.stdout)


if __name__ == "__main__":
    main()
