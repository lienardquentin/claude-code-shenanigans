"""The archives of Minas Tirith: which beacons burn, and every lighting there was, kept in a database."""

import asyncio
import os

from psycopg import Error
from psycopg.errors import UndefinedTable
from psycopg_pool import AsyncConnectionPool, PoolTimeout

from . import realm
from .chronicle import request_id, scribe

# Where the database is, as a postgresql:// address. With none, what burns is kept in the realm's own memory, gone
# when it sleeps, and the realm stands as before.
DATABASE_URL = os.environ.get("DATABASE_URL", "")
# How long the archivists wait before they try the door again
PATIENCE = 5.0
# How long a request waits for an archivist to be free, in seconds: past it the archives are said shut
WAIT = 2.0

SHELVES = """
CREATE TABLE IF NOT EXISTS burning (
    beacon text PRIMARY KEY,
    rid text NOT NULL,
    since timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS lightings (
    id bigserial PRIMARY KEY,
    beacon text NOT NULL,
    rid text NOT NULL,
    at timestamptz NOT NULL DEFAULT now()
);
"""

log = scribe()

archivists: AsyncConnectionPool | None = None
shelving: asyncio.Task | None = None


class Shut(Exception):
    """The archives cannot be reached: nothing is read from them or written to them."""


async def shelve() -> None:
    """Puts up the shelves once the database answers: a realm that wakes before it does keeps trying the door."""
    while archivists is not None:
        try:
            async with archivists.connection(timeout=PATIENCE) as desk:
                await desk.execute(SHELVES)
        except (Error, PoolTimeout) as failure:
            log.warning("the archives do not open: %s", type(failure).__name__)
            await asyncio.sleep(PATIENCE)
        else:
            log.info("the archives are open; what burns and every lighting are written there")

            return


async def wake() -> None:
    global archivists, shelving

    if not DATABASE_URL:
        return

    # Named, so that whoever looks at the database's sessions knows whose they are
    archivists = AsyncConnectionPool(DATABASE_URL, min_size=1, max_size=4, timeout=WAIT, open=False, kwargs={"application_name": "gondor"})
    await archivists.open(wait=False)
    shelving = asyncio.create_task(shelve())


async def sleep() -> None:
    global archivists, shelving

    if shelving is not None:
        shelving.cancel()
        shelving = None

    if archivists is not None:
        closing, archivists = archivists, None
        await closing.close(timeout=2)


def shut(doing: str, failure: BaseException) -> Shut:
    global shelving

    log.error("the archives are shut, %s: %s", doing, type(failure).__name__)

    # A database that came back with nothing of what it held has no shelves: they are put up again
    if isinstance(failure, UndefinedTable) and (shelving is None or shelving.done()):
        shelving = asyncio.create_task(shelve())

    return Shut(f"the archives are shut, {doing}")


async def burning() -> dict[str, tuple[str | None, str]]:
    """The beacons that burn now, each with its first keeper and since when it burns."""
    if archivists is None:
        return {beacon: (fire["keeper"], fire["since"]) for beacon, fire in realm.lit.items()}

    try:
        async with archivists.connection() as desk:
            found = await desk.execute("SELECT beacon, since FROM burning")

            # The keeper is not written in the archives yet
            return {beacon: (None, realm.stamp(since)) for beacon, since in await found.fetchall()}
    except (Error, PoolTimeout) as failure:
        raise shut("and none can say what burns", failure) from failure


async def lightings() -> list[dict[str, object]]:
    """Every lighting there was, oldest first: id, beacon, lit_at, keeper."""
    if archivists is None:
        return list(realm.lightings)

    try:
        async with archivists.connection() as desk:
            found = await desk.execute("SELECT id, beacon, at FROM lightings ORDER BY id")

            return [{"id": id, "beacon": beacon, "lit_at": realm.stamp(at), "keeper": None} for id, beacon, at in await found.fetchall()]
    except (Error, PoolTimeout) as failure:
        raise shut("and none can say what was lit", failure) from failure


async def keep(beacon: str) -> None:
    """Writes that a beacon burns, and the lighting itself, under the id of the request that lit it."""
    if archivists is None:
        return

    rid = request_id.get()

    try:
        # One errand: both are written, or neither
        async with archivists.connection() as desk:
            await desk.execute("INSERT INTO lightings (beacon, rid) VALUES (%s, %s)", (beacon, rid))
            await desk.execute("INSERT INTO burning (beacon, rid) VALUES (%s, %s) ON CONFLICT (beacon) DO NOTHING", (beacon, rid))
    except (Error, PoolTimeout) as failure:
        raise shut(f"and the lighting of {beacon} is not written", failure) from failure


async def quench() -> int:
    """Puts them all out, and says how many burned. The lightings there were stay written."""
    if archivists is None:
        count = len(realm.lit)

        realm.lit.clear()

        return count

    try:
        async with archivists.connection() as desk:
            return (await desk.execute("DELETE FROM burning")).rowcount
    except (Error, PoolTimeout) as failure:
        raise shut("and the beacons burn on", failure) from failure
