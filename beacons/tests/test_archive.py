"""Gondor's archives in a real Postgres: the keeper kept beside every fire and lighting, old archives included.

These run against the database GONDOR_TEST_DATABASE_URL names, a throwaway one, each in a schema of its own that is
dropped after; with none set they are skipped.
"""

import os
import re
import time
from urllib.parse import quote
from uuid import uuid4

import psycopg
import pytest
from fastapi.testclient import TestClient

from gondor import archive, realm
from gondor.app import app as gondor

TEST_DATABASE_URL = os.environ.get("GONDOR_TEST_DATABASE_URL", "")

# A UTC time to the millisecond, with Z: 2026-10-14T09:12:03.481Z
MS_Z = re.compile(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z")

# The shelves as they stood before the keeper was written: no keeper column in either table
OLD_SHELVES = """
CREATE TABLE burning (
    beacon text PRIMARY KEY,
    rid text NOT NULL,
    since timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE lightings (
    id bigserial PRIMARY KEY,
    beacon text NOT NULL,
    rid text NOT NULL,
    at timestamptz NOT NULL DEFAULT now()
);
"""


@pytest.fixture(autouse=True)
def beacons_dark():
    realm.lit.clear()
    realm.lightings.clear()
    yield
    realm.lit.clear()
    realm.lightings.clear()


@pytest.fixture
def schema(monkeypatch):
    """A schema of its own in the test database, which every archivist of the pool works in, dropped after."""
    if not TEST_DATABASE_URL:
        pytest.skip("GONDOR_TEST_DATABASE_URL is not set: no Postgres to keep the archives in")

    name = f"gondor_test_{uuid4().hex[:12]}"

    with psycopg.connect(TEST_DATABASE_URL, autocommit=True) as desk:
        desk.execute(f"CREATE SCHEMA {name}")

    joiner = "&" if "?" in TEST_DATABASE_URL else "?"
    monkeypatch.setattr(archive, "DATABASE_URL", f"{TEST_DATABASE_URL}{joiner}options={quote(f'-csearch_path={name}')}")

    yield name

    with psycopg.connect(TEST_DATABASE_URL, autocommit=True) as desk:
        desk.execute(f"DROP SCHEMA {name} CASCADE")


def in_schema(schema: str, query: str, params: tuple = ()) -> list[tuple]:
    with psycopg.connect(TEST_DATABASE_URL, autocommit=True) as desk:
        desk.execute(f"SET search_path TO {schema}")

        found = desk.execute(query, params)

        return found.fetchall() if found.description else []


def shelved() -> None:
    """Waits for the archivists to have put up their shelves."""
    deadline = time.monotonic() + 15

    while archive.shelving is not None and not archive.shelving.done():
        assert time.monotonic() < deadline, "the archives never opened"
        time.sleep(0.05)


@pytest.fixture
def archived(schema):
    with TestClient(gondor) as gondor_client:
        assert archive.archivists is not None
        shelved()

        yield gondor_client


def keepers(schema: str, table: str) -> list[tuple]:
    order = "id" if table == "lightings" else "beacon"

    return in_schema(schema, f"SELECT beacon, keeper FROM {table} ORDER BY {order}")


def test_the_keeper_is_handed_to_the_archives_on_light(monkeypatch):
    kept = []

    async def keep(beacon: str, keeper: str | None) -> None:
        kept.append((beacon, keeper))

    monkeypatch.setattr(archive, "keep", keep)

    with TestClient(gondor) as client:
        client.post("/beacons/eilenach/light", json={"keeper": "Hirgon"})
        client.post("/beacons/amon-din/light")
        client.post("/beacons/nardol/light", json={"keeper": "  "})

    assert kept == [("eilenach", "Hirgon"), ("amon-din", None), ("nardol", None)]


def test_the_keeper_is_written_with_the_fire_and_the_lighting(archived, schema):
    assert archived.post("/beacons/eilenach/light", json={"keeper": "Hirgon"}).status_code == 200
    assert archived.post("/beacons/amon-din/light").status_code == 200

    assert keepers(schema, "lightings") == [("eilenach", "Hirgon"), ("amon-din", None)]
    assert keepers(schema, "burning") == [("amon-din", None), ("eilenach", "Hirgon")]


def test_the_beacons_are_answered_from_the_archives_with_their_keepers(archived, schema):
    archived.post("/beacons/eilenach/light", json={"keeper": "Hirgon"})
    archived.post("/beacons/amon-din/light")

    # What the realm holds in memory is not what is answered: the archives are
    realm.lit.clear()

    beacons = {b["beacon"]: b for b in archived.get("/beacons").json()}

    assert beacons["eilenach"]["lit"] is True
    assert beacons["eilenach"]["keeper"] == "Hirgon"
    assert MS_Z.fullmatch(beacons["eilenach"]["since"])
    assert beacons["amon-din"]["lit"] is True
    assert beacons["amon-din"]["keeper"] is None
    assert MS_Z.fullmatch(beacons["amon-din"]["since"])
    assert beacons["nardol"] == {"beacon": "nardol", "lit": False, "keeper": None, "since": None}


def test_the_lightings_are_answered_from_the_archives_with_their_keepers(archived, schema):
    archived.post("/beacons/eilenach/light", json={"keeper": "Hirgon"})
    archived.post("/beacons/amon-din/light")

    realm.lightings.clear()

    lightings = archived.get("/lightings").json()
    ids = [id for (id,) in in_schema(schema, "SELECT id FROM lightings ORDER BY id")]

    assert [(lighting["id"], lighting["beacon"], lighting["keeper"]) for lighting in lightings] == [
        (ids[0], "Eilenach", "Hirgon"),
        (ids[1], "Amon Dîn", None),
    ]
    assert all(MS_Z.fullmatch(lighting["lit_at"]) for lighting in lightings)
    assert all(lighting["realm"] == "Gondor" for lighting in lightings)


def test_a_second_lighting_keeps_the_first_keeper_of_the_fire(archived, schema):
    archived.post("/beacons/eilenach/light", json={"keeper": "Hirgon"})
    archived.post("/beacons/eilenach/light", json={"keeper": "Beregond"})

    realm.lit.clear()
    realm.lightings.clear()

    beacons = {b["beacon"]: b for b in archived.get("/beacons").json()}

    assert beacons["eilenach"]["keeper"] == "Hirgon"
    assert [lighting["keeper"] for lighting in archived.get("/lightings").json()] == ["Hirgon", "Beregond"]
    assert keepers(schema, "burning") == [("eilenach", "Hirgon")]


def test_an_archive_from_before_the_keeper_gains_it_and_keeps_its_old_rows(schema):
    in_schema(schema, OLD_SHELVES)
    in_schema(schema, "INSERT INTO lightings (beacon, rid) VALUES ('amon-din', 'old1'), ('eilenach', 'old2')")
    in_schema(schema, "INSERT INTO burning (beacon, rid) VALUES ('amon-din', 'old1')")

    with TestClient(gondor) as client:
        shelved()

        columns = in_schema(
            schema,
            "SELECT table_name, is_nullable FROM information_schema.columns WHERE table_schema = %s AND column_name = 'keeper' ORDER BY table_name",
            (schema,),
        )

        assert columns == [("burning", "YES"), ("lightings", "YES")]
        assert keepers(schema, "lightings") == [("amon-din", None), ("eilenach", None)]
        assert keepers(schema, "burning") == [("amon-din", None)]

        lightings = client.get("/lightings").json()

        assert [(lighting["beacon"], lighting["keeper"]) for lighting in lightings] == [("Amon Dîn", None), ("Eilenach", None)]

        beacons = {b["beacon"]: b for b in client.get("/beacons").json()}

        assert beacons["amon-din"]["lit"] is True
        assert beacons["amon-din"]["keeper"] is None

        # A new lighting in the old archive is written with its keeper beside the old rows
        assert client.post("/beacons/nardol/light", json={"keeper": "Hirgon"}).status_code == 200
        assert [lighting["keeper"] for lighting in client.get("/lightings").json()] == [None, None, "Hirgon"]
