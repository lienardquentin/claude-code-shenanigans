"""Gondor's log: one JSON object per line, a traceback in plain lines under the line that reports it."""

import json
import logging
import sys
from contextvars import ContextVar
from datetime import datetime, timezone

# The id of the request being answered, carried to Rohan so one errand reads as one story across both logs
request_id: ContextVar[str] = ContextVar("request_id", default="")


class JsonLines(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        line = {
            "time": datetime.fromtimestamp(record.created, timezone.utc).isoformat(timespec="milliseconds"),
            "level": record.levelname.lower(),
            "msg": record.getMessage(),
        }

        if request_id.get():
            line["rid"] = request_id.get()

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
