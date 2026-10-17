"""Gondor's log: one JSON object per line, a traceback in plain lines under the line that reports it."""

import json
import logging
import sys
from contextvars import ContextVar
from datetime import UTC, datetime

# The id of the request being answered, carried to Rohan so one errand reads as one story across both logs
request_id: ContextVar[str] = ContextVar("request_id", default="")


class JsonLines(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        line = {
            "time": datetime.fromtimestamp(record.created, UTC).isoformat(timespec="milliseconds"),
            "level": record.levelname.lower(),
            "msg": record.getMessage(),
        }

        # A line written outside a request (a record's fate, told on the herald's thread) names its own
        rid = getattr(record, "rid", "") or request_id.get()

        if rid:
            line["rid"] = rid

        text = json.dumps(line, ensure_ascii=False)

        return f"{text}\n{self.formatException(record.exc_info)}" if record.exc_info else text


def scribe() -> logging.Logger:
    log = logging.getLogger("gondor")

    if not log.handlers:
        handler = logging.StreamHandler(sys.stderr)
        handler.setFormatter(JsonLines())
        log.addHandler(handler)
        log.setLevel(logging.INFO)
        log.propagate = False

    return log
