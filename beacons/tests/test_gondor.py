import re

import httpx
import pytest
from fastapi.testclient import TestClient

from gondor import archive, realm
from gondor.app import app as gondor
from rohan.app import app as rohan


@pytest.fixture(autouse=True)
def beacons_dark():
    realm.lit.clear()
    getattr(realm, "lightings", []).clear()
    yield
    realm.lit.clear()
    getattr(realm, "lightings", []).clear()


# A UTC time to the millisecond, with Z: 2026-10-14T09:12:03.481Z
MS_Z = re.compile(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z")


def road_to(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(base_url="http://rohan.test", transport=httpx.MockTransport(handler))


@pytest.fixture
def client():
    with TestClient(gondor) as gondor_client:
        yield gondor_client


# sting: gondor GET /health
def test_health(client):
    assert client.get("/health").json() == {"realm": "gondor", "stands": True, "lit": 0}


def test_beacons_start_dark_and_come_in_chain_order(client):
    beacons = client.get("/beacons").json()

    assert [b["beacon"] for b in beacons] == realm.BEACONS
    assert not any(b["lit"] for b in beacons)


# sting: gondor POST /beacons/amon-din/light
def test_lighting_a_beacon_names_the_next_and_shows_in_the_list(client):
    answer = client.post("/beacons/amon-din/light")

    assert answer.status_code == 200
    assert answer.json() == {"beacon": "amon-din", "lit": True, "watch_next": "eilenach", "keeper": None}
    assert {b["beacon"] for b in client.get("/beacons").json() if b["lit"]} == {"amon-din"}


def test_every_beacon_but_the_last_hands_on_to_the_next():
    chain = realm.BEACONS

    assert [realm.light(name, None)["watch_next"] for name in chain[:-1]] == chain[1:]


def test_an_unknown_beacon_is_a_404(client):
    answer = client.post("/beacons/mount-doom/light")

    assert answer.status_code == 404
    assert "mount-doom" in answer.json()["detail"]


@pytest.mark.xfail(strict=True, reason="Halifirien has no next beacon: the bug left in on purpose (KeyError, 500)")
def test_the_last_beacon_can_be_lit(client):
    answer = client.post("/beacons/halifirien/light")

    assert answer.status_code == 200
    assert answer.json()["lit"] is True


def test_quench_puts_them_all_out_and_counts(client):
    client.post("/beacons/amon-din/light")
    client.post("/beacons/eilenach/light")

    assert client.post("/beacons/quench").json() == {"quenched": 2}
    assert not any(b["lit"] for b in client.get("/beacons").json())


def test_with_no_database_what_burns_is_kept_in_memory(client):
    assert archive.archivists is None

    client.post("/beacons/nardol/light")

    assert set(realm.lit) == {"nardol"}
    assert realm.lit["nardol"]["keeper"] is None
    assert MS_Z.fullmatch(realm.lit["nardol"]["since"])
    assert [lighting["beacon"] for lighting in realm.lightings] == ["nardol"]


def test_the_archives_shut_is_a_503_the_realm_survives(client, monkeypatch):
    async def shut() -> dict:
        raise archive.Shut("the archives are shut, and none can say what burns")

    monkeypatch.setattr(archive, "burning", shut)

    answer = client.get("/beacons")

    assert answer.status_code == 503
    assert answer.json() == {"detail": "the archives are shut, and none can say what burns"}
    assert client.get("/health").status_code == 200


def test_a_lighting_is_written_before_the_next_beacon_is_named(client, monkeypatch):
    kept = []

    async def keep(beacon: str, keeper: str | None) -> None:
        kept.append(beacon)

    monkeypatch.setattr(archive, "keep", keep)

    # Halifirien has no next beacon and fails; its fire was written all the same
    with TestClient(gondor, raise_server_exceptions=False) as failing:
        failing.post("/beacons/halifirien/light")

    client.post("/beacons/amon-din/light")

    assert kept == ["halifirien", "amon-din"]


# sting: gondor POST /beacons/eilenach/light '{"keeper": "Hirgon"}'
def test_lighting_with_a_keeper_answers_who_lit_it(client):
    answer = client.post("/beacons/eilenach/light", json={"keeper": "Hirgon"})

    assert answer.status_code == 200
    assert answer.json() == {"beacon": "eilenach", "lit": True, "watch_next": "nardol", "keeper": "Hirgon"}
    assert realm.lit["eilenach"]["keeper"] == "Hirgon"


def test_lighting_with_no_body_or_a_null_keeper_has_no_keeper(client):
    assert client.post("/beacons/amon-din/light").json()["keeper"] is None
    assert client.post("/beacons/eilenach/light", json={}).json()["keeper"] is None
    assert client.post("/beacons/nardol/light", json={"keeper": None}).json()["keeper"] is None


def test_a_blank_keeper_reads_as_none(client):
    assert client.post("/beacons/amon-din/light", json={"keeper": "   "}).json()["keeper"] is None
    assert client.post("/beacons/eilenach/light", json={"keeper": ""}).json()["keeper"] is None
    assert realm.lit["amon-din"]["keeper"] is None


# sting: gondor GET /beacons
def test_beacons_name_the_first_keeper_and_since_of_what_burns(client):
    dark = {b["beacon"]: b for b in client.get("/beacons").json()}

    assert dark["amon-din"] == {"beacon": "amon-din", "lit": False, "keeper": None, "since": None}

    client.post("/beacons/amon-din/light", json={"keeper": "Hirgon"})
    first = {b["beacon"]: b for b in client.get("/beacons").json()}["amon-din"]

    client.post("/beacons/amon-din/light", json={"keeper": "Beregond"})
    client.post("/beacons/eilenach/light")
    beacons = client.get("/beacons").json()
    by_name = {b["beacon"]: b for b in beacons}

    assert [b["beacon"] for b in beacons] == realm.BEACONS
    assert all(set(b) == {"beacon", "lit", "keeper", "since"} for b in beacons)
    assert by_name["amon-din"]["lit"] is True
    assert by_name["amon-din"]["keeper"] == "Hirgon"
    assert MS_Z.fullmatch(by_name["amon-din"]["since"])
    assert by_name["amon-din"]["since"] == first["since"]
    # A fire with no keeper burns all the same, its keeper unknown
    assert by_name["eilenach"]["lit"] is True
    assert by_name["eilenach"]["keeper"] is None
    assert MS_Z.fullmatch(by_name["eilenach"]["since"])
    assert by_name["nardol"] == {"beacon": "nardol", "lit": False, "keeper": None, "since": None}


def test_relighting_a_burning_beacon_keeps_its_first_keeper_and_since():
    realm.light("amon-din", "Hirgon")
    first = dict(realm.lit["amon-din"])
    realm.light("amon-din", "Beregond")

    assert realm.lit["amon-din"] == first
    assert first["keeper"] == "Hirgon"
    assert [lighting["keeper"] for lighting in realm.lightings] == ["Hirgon", "Beregond"]


def test_the_beacons_are_named_as_the_chronicle_spells_them():
    assert realm.NAMES == {
        "amon-din": "Amon Dîn",
        "eilenach": "Eilenach",
        "nardol": "Nardol",
        "erelas": "Erelas",
        "min-rimmon": "Min-Rimmon",
        "calenhad": "Calenhad",
        "halifirien": "Halifirien",
    }


def test_there_are_no_lightings_before_any_fire(client):
    assert client.get("/lightings").json() == []


# sting: gondor GET /lightings
def test_lightings_are_answered_newest_last_as_narsil_spells_them(client):
    client.post("/beacons/amon-din/light", json={"keeper": "Hirgon"})
    client.post("/beacons/min-rimmon/light")
    client.post("/beacons/amon-din/light", json={"keeper": "Beregond"})

    answer = client.get("/lightings")

    assert answer.status_code == 200

    lightings = answer.json()

    assert all(set(lighting) == {"id", "beacon", "realm", "lit_at", "keeper", "watchers", "note"} for lighting in lightings)
    assert [(lighting["beacon"], lighting["keeper"]) for lighting in lightings] == [
        ("Amon Dîn", "Hirgon"),
        ("Min-Rimmon", None),
        ("Amon Dîn", "Beregond"),
    ]
    assert all(lighting["realm"] == "Gondor" for lighting in lightings)
    assert all(lighting["watchers"] == 0 for lighting in lightings)
    assert all(lighting["note"] == "" for lighting in lightings)
    assert all(MS_Z.fullmatch(lighting["lit_at"]) for lighting in lightings)
    assert [lighting["lit_at"] for lighting in lightings] == sorted(lighting["lit_at"] for lighting in lightings)

    ids = [lighting["id"] for lighting in lightings]

    assert all(isinstance(i, int) for i in ids)
    assert ids == sorted(set(ids))


def test_quench_puts_out_the_fires_but_the_lightings_stay(client):
    client.post("/beacons/amon-din/light", json={"keeper": "Hirgon"})

    assert client.post("/beacons/quench").json() == {"quenched": 1}
    assert client.get("/health").json()["lit"] == 0
    assert {b["beacon"]: b for b in client.get("/beacons").json()}["amon-din"]["keeper"] is None
    assert [lighting["keeper"] for lighting in client.get("/lightings").json()] == ["Hirgon"]


def test_palantiri_are_listed_sorted(client):
    assert client.get("/palantiri").json() == sorted(realm.STONES)


def test_gazing_shows_the_vision(client):
    assert client.get("/palantiri/anor/gaze").json() == {"stone": "anor", "vision": realm.STONES["anor"]}


def test_a_lost_stone_is_a_404(client):
    answer = client.get("/palantiri/osgiliath/gaze")

    assert answer.status_code == 404
    assert "osgiliath" in answer.json()["detail"]


def test_the_stone_held_by_the_enemy_raises():
    with pytest.raises(realm.StoneIsWatched, match="Ithil"):
        realm.gaze("ithil")


def test_gazing_into_the_held_stone_is_a_500_the_realm_survives():
    with TestClient(gondor, raise_server_exceptions=False) as client:
        answer = client.get("/palantiri/ithil/gaze")

        assert answer.status_code == 500
        assert answer.json() == {"detail": "the realm is in disarray"}
        assert client.get("/health").status_code == 200


def test_the_request_id_is_carried_to_rohan(client):
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(request.headers)
        return httpx.Response(200, json={"riding": 100, "days": 5})

    client.app.state.rohan = road_to(handler)
    client.post("/muster?spears=100", headers={"x-request-id": "abc123"})

    assert seen["x-request-id"] == "abc123"
    assert seen["authorization"].startswith("Bearer ")


def test_muster_relays_rohans_answer(client):
    client.app.state.rohan = road_to(lambda request: httpx.Response(200, json={"riding": 2000, "days": 5}))

    answer = client.post("/muster")

    assert answer.status_code == 200
    assert answer.json() == {"rohan": {"riding": 2000, "days": 5}}


def test_muster_passes_a_refusal_on_with_its_reason(client):
    client.app.state.rohan = road_to(lambda request: httpx.Response(409, json={"detail": "Rohan has 6000 spears, not 9000"}))

    answer = client.post("/muster?spears=9000")

    assert answer.status_code == 409
    assert answer.json() == {"detail": "Rohan has 6000 spears, not 9000"}


def test_muster_is_a_502_when_rohan_does_not_answer(client):
    def down(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("no road")

    client.app.state.rohan = road_to(down)

    answer = client.post("/muster")

    assert answer.status_code == 502
    assert answer.json() == {"detail": "Rohan does not answer"}


def test_gondor_and_rohan_agree_on_the_contract(client, monkeypatch):
    # The real Rohan behind the road, with the king's doubt taken out
    monkeypatch.setattr("rohan.app.random.random", lambda: 1.0)
    client.app.state.rohan = httpx.AsyncClient(base_url="http://rohan.test", transport=httpx.ASGITransport(app=rohan))

    assert client.post("/muster?spears=1500").json() == {"rohan": {"riding": 1500, "days": 5}}
    assert client.post("/muster?spears=9000").status_code == 409
