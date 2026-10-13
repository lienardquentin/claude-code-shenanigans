"""Gondor: lights the beacons, gazes into the seeing-stones, and sends the Red Arrow to Rohan."""

import os
from contextlib import asynccontextmanager
from time import perf_counter
from uuid import uuid4

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from . import archive, realm, tidings
from .chronicle import request_id, scribe

ROHAN_URL = os.environ.get("ROHAN_URL", "http://127.0.0.1:8102")
# The token Gondor shows Rohan. A stand-in, and logged below on purpose: a watcher of these logs must hide it.
RED_ARROW = os.environ.get("RED_ARROW", "red-arrow-0f3a9c44d1e2b7a6")

log = scribe()


@asynccontextmanager
async def realm_stands(app: FastAPI):
    # One road to Rohan for the life of the realm; the machine's proxy settings are none of its business
    async with httpx.AsyncClient(base_url=ROHAN_URL, timeout=5, trust_env=False) as road:
        app.state.rohan = road
        log.info("the White City wakes; the road to Rohan is %s", ROHAN_URL)
        tidings.wake()
        await archive.wake()

        yield

        await archive.sleep()
        tidings.sleep()

    log.info("the White City sleeps")


app = FastAPI(title="The Beacons of Gondor", lifespan=realm_stands)


@app.middleware("http")
async def chronicle(request: Request, call_next):
    marker = request_id.set(request.headers.get("x-request-id") or uuid4().hex[:8])
    started = perf_counter()
    errand = f"{request.method} {request.url.path}"

    try:
        response = await call_next(request)
    except Exception:
        log.exception("%s failed", errand)
        response = JSONResponse({"detail": "the realm is in disarray"}, status_code=500)

    took = round((perf_counter() - started) * 1000)
    level = "error" if response.status_code >= 500 else "warning" if response.status_code >= 400 else "info"

    getattr(log, level)("%s -> %s in %sms", errand, response.status_code, took)
    request_id.reset(marker)

    return response


@app.exception_handler(archive.Shut)
async def archives_shut(request: Request, failure: archive.Shut):
    return JSONResponse({"detail": str(failure)}, status_code=503)


@app.get("/health")
async def health():
    return {"realm": "gondor", "stands": True}


@app.get("/beacons")
async def beacons():
    burning = await archive.burning()

    return [{"beacon": name, "lit": name in burning} for name in realm.BEACONS]


@app.post("/beacons/{name}/light")
async def light(name: str):
    if name not in realm.BEACONS:
        raise HTTPException(404, f"no beacon is named {name}")

    # The fire is written down before anyone asks who is told of it
    await archive.keep(name)

    lit = realm.light(name)

    tidings.send(name, str(lit["watch_next"]))

    return lit


@app.post("/beacons/quench")
async def quench():
    count = await archive.quench()

    realm.lit.clear()
    log.info("the beacons are quenched, %s of them", count)

    return {"quenched": count}


@app.get("/palantiri")
async def palantiri():
    return sorted(realm.STONES)


@app.get("/palantiri/{stone}/gaze")
async def gaze(stone: str):
    if stone not in realm.STONES:
        raise HTTPException(404, f"the {stone}-stone is lost")

    return {"stone": stone, "vision": realm.gaze(stone)}


@app.post("/muster")
async def muster(request: Request, spears: int = 2000):
    """Sends the Red Arrow: asks Rohan for that many spears."""
    headers = {"Authorization": f"Bearer {RED_ARROW}", "X-Request-Id": request_id.get()}

    log.info("sending the Red Arrow to %s with Authorization: %s", ROHAN_URL, headers["Authorization"])

    try:
        answer = await request.app.state.rohan.post("/riders/muster", json={"spears": spears}, headers=headers)
    except httpx.HTTPError as failure:
        log.error("Rohan does not answer: %s", type(failure).__name__)
        raise HTTPException(502, "Rohan does not answer") from failure

    if answer.status_code != 200:
        raise HTTPException(answer.status_code, answer.json().get("detail", "Rohan will not ride"))

    return {"rohan": answer.json()}
