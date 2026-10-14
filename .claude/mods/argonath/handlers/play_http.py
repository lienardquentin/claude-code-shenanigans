#!/usr/bin/env python3
"""Plays requests against one build of a web app, in-process, for the argonath mod's service handler.

Run by the Python of that build's project, its folder on the path. Reads on stdin:

    {"app": "gondor.app:app", "requests": ["gondor GET /health", "gondor POST /beacons/amon-din/light {...}"]}

and writes on stdout, a request each, in order: {"status", "body", "error"}. The requests go one after another to one
app, started once: what one does to the app's state, the next sees. The body is JSON with its keys sorted, or the text.
"""

import importlib
import json
import logging
import shlex
import sys
import warnings

# What the libraries warn of is theirs, not the app's answer
warnings.simplefilter("ignore")


def main():
    job = json.load(sys.stdin)
    module, _, attribute = job["app"].partition(":")
    app = getattr(importlib.import_module(module), attribute or "app")
    # The app's own log holds times and ids, which differ from build to build: what it answers is what is compared
    logging.disable(logging.CRITICAL)

    from fastapi.testclient import TestClient

    # A run that cleans up after itself names each request, for what the app writes to be found again
    rid = job.get("rid", "")
    answers = []
    with TestClient(app, raise_server_exceptions=False) as client:
        for number, line in enumerate(job["requests"]):
            answer = {"status": 0, "body": "", "error": ""}
            answers.append(answer)
            try:
                _, method, path, *body = shlex.split(line)
                headers = {"X-Request-Id": "%s-%d" % (rid, number)} if rid else None
                given = client.request(method.upper(), path, json=json.loads(body[0]) if body else None, headers=headers)
            except Exception as error:  # a request that cannot be made is said, and the next is played
                answer["error"] = "%s: %s" % (type(error).__name__, error)
                continue
            answer["status"] = given.status_code
            try:
                answer["body"] = json.dumps(given.json(), indent=2, sort_keys=True, ensure_ascii=False)
            except ValueError:
                answer["body"] = given.text

    json.dump(answers, sys.stdout)


if __name__ == "__main__":
    main()
