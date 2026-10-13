"""Rohan: answers the Red Arrow, and musters what spears it has. Its log is logfmt."""

import asyncio
import logging
import os
import random
import sys
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel

from . import watchers

RED_ARROW = os.environ.get("RED_ARROW", "red-arrow-0f3a9c44d1e2b7a6")
# What the Mark can put in the saddle
SPEARS = 6000

EOREDS = {"edoras": 1200, "eastfold": 1800, "westfold": 1400, "the-wold": 900, "fenmarch": 700}


class Logfmt(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        fields = {
            "ts": datetime.fromtimestamp(record.created, timezone.utc).isoformat(timespec="milliseconds"),
            "level": record.levelname.lower(),
            "msg": record.getMessage(),
            **getattr(record, "fields", {}),
        }
        text = " ".join(f'{key}="{value}"' if " " in str(value) else f"{key}={value}" for key, value in fields.items())

        return f"{text}\n{self.formatException(record.exc_info)}" if record.exc_info else text


log = logging.getLogger("rohan")

if not log.handlers:
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(Logfmt())
    log.addHandler(handler)
    log.setLevel(logging.INFO)
    log.propagate = False


def say(level: int, msg: str, **fields: object) -> None:
    log.log(level, msg, extra={"fields": fields})


@asynccontextmanager
async def realm_stands(app: FastAPI):
    halt = watchers.post(say)

    yield

    halt.set()


app = FastAPI(title="The Riders of Rohan", lifespan=realm_stands)


class Muster(BaseModel):
    spears: int


@app.get("/health")
async def health():
    return {"realm": "rohan", "stands": True}


@app.get("/riders")
async def riders():
    return [{"eored": name, "spears": count} for name, count in EOREDS.items()]


@app.post("/riders/muster")
async def muster(asked: Muster, request: Request):
    rid = request.headers.get("x-request-id", "")
    token = request.headers.get("authorization", "").removeprefix("Bearer ")

    # Logged on purpose, as Gondor's is: a watcher of these logs must hide it
    say(logging.INFO, "the Red Arrow is shown", rid=rid, token=token)

    if token != RED_ARROW:
        say(logging.WARNING, "a false arrow is turned away", rid=rid)
        raise HTTPException(401, "that is no arrow of Gondor")

    # One errand in five finds the king in doubt
    if random.random() < 0.2:
        waited = random.uniform(0.4, 0.9)

        await asyncio.sleep(waited)
        say(logging.WARNING, "Théoden hesitates", rid=rid, ms=round(waited * 1000))

    if asked.spears > SPEARS:
        say(logging.ERROR, "muster refused: more spears asked than the Mark has", rid=rid, asked=asked.spears, spears=SPEARS)
        raise HTTPException(409, f"Rohan has {SPEARS} spears, not {asked.spears}")

    say(logging.INFO, "the Rohirrim ride", rid=rid, spears=asked.spears)

    return {"riding": asked.spears, "days": 5}
