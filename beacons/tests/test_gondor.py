import asyncio
import logging

import httpx
import pytest
from fastapi.testclient import TestClient

from gondor import archive, realm, tidings
from gondor.app import app as gondor
from rohan.app import app as rohan


@pytest.fixture(autouse=True)
def beacons_dark():
    realm.lit.clear()
    yield
    realm.lit.clear()


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


def test_lighting_a_beacon_names_the_next_and_shows_in_the_list(client):
    answer = client.post("/beacons/amon-din/light")

    assert answer.status_code == 200
    assert answer.json() == {"beacon": "amon-din", "lit": True, "watch_next": "eilenach"}
    assert {b["beacon"] for b in client.get("/beacons").json() if b["lit"]} == {"amon-din"}


# sting: gondor GET /beacons/amon-din
def test_one_beacon_answers_its_own_state_lit_or_not(client):
    assert client.get("/beacons/amon-din").json() == {"beacon": "amon-din", "lit": False}

    client.post("/beacons/amon-din/light")

    assert client.get("/beacons/amon-din").json() == {"beacon": "amon-din", "lit": True}
    assert client.get("/beacons/eilenach").json() == {"beacon": "eilenach", "lit": False}

    client.post("/beacons/quench")

    assert client.get("/beacons/amon-din").json() == {"beacon": "amon-din", "lit": False}


def test_asking_after_an_unknown_beacon_is_a_404(client):
    answer = client.get("/beacons/mount-doom")

    assert answer.status_code == 404
    assert "mount-doom" in answer.json()["detail"]


def test_asking_after_one_beacon_with_the_archives_shut_is_a_503(client, monkeypatch):
    async def shut() -> set[str]:
        raise archive.Shut("the archives are shut, and none can say what burns")

    monkeypatch.setattr(archive, "burning", shut)

    answer = client.get("/beacons/amon-din")

    assert answer.status_code == 503
    assert answer.json() == {"detail": "the archives are shut, and none can say what burns"}


# sting: gondor POST /beacons/amon-din/quench
def test_quenching_one_beacon_puts_out_only_that_one(client):
    client.post("/beacons/amon-din/light")
    client.post("/beacons/eilenach/light")

    answer = client.post("/beacons/amon-din/quench")

    assert answer.status_code == 200
    assert answer.json() == {"beacon": "amon-din", "quenched": True}
    assert {b["beacon"] for b in client.get("/beacons").json() if b["lit"]} == {"eilenach"}


# sting: gondor GET /beacons
def test_a_quenched_beacon_shows_dark_in_the_chain(client):
    client.post("/beacons/amon-din/light")
    client.post("/beacons/amon-din/quench")

    assert {b["beacon"]: b["lit"] for b in client.get("/beacons").json()}["amon-din"] is False


# sting: gondor POST /beacons/quench
def test_quenching_all_leaves_out_a_beacon_already_quenched(client):
    client.post("/beacons/amon-din/light")
    client.post("/beacons/eilenach/light")
    client.post("/beacons/amon-din/quench")

    assert client.post("/beacons/quench").json() == {"quenched": 1}


# sting: gondor POST /beacons/amon-din/quench
def test_quenching_a_dark_beacon_is_a_409(client):
    answer = client.post("/beacons/amon-din/quench")

    assert answer.status_code == 409
    assert "does not burn" in answer.json()["detail"]


# sting: gondor POST /beacons/mount-doom/quench
def test_quenching_an_unknown_beacon_is_a_404(client):
    answer = client.post("/beacons/mount-doom/quench")

    assert answer.status_code == 404
    assert "mount-doom" in answer.json()["detail"]


def test_a_single_quench_is_logged_and_sends_no_tidings(client, caplog, monkeypatch):
    sent = []
    monkeypatch.setattr(tidings, "send", lambda *args, **kwargs: sent.append(args))
    client.post("/beacons/amon-din/light")
    sent.clear()

    gondor_log = logging.getLogger("gondor")
    gondor_log.addHandler(caplog.handler)
    try:
        with caplog.at_level(logging.INFO, logger="gondor"):
            assert client.post("/beacons/amon-din/quench").status_code == 200
    finally:
        gondor_log.removeHandler(caplog.handler)

    assert any("amon-din" in record.getMessage() and "quenched" in record.getMessage() for record in caplog.records)
    assert sent == []


def test_every_beacon_but_the_last_hands_on_to_the_next():
    chain = realm.BEACONS

    assert [realm.light(name)["watch_next"] for name in chain[:-1]] == chain[1:]


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


def test_douse_puts_one_beacon_out_and_says_it_burned():
    realm.lit.update({"amon-din", "eilenach"})

    assert asyncio.run(archive.douse("amon-din")) is True
    assert realm.lit == {"eilenach"}
    assert asyncio.run(archive.douse("amon-din")) is False


def test_with_no_database_what_burns_is_kept_in_memory(client):
    assert archive.archivists is None

    client.post("/beacons/nardol/light")

    assert realm.lit == {"nardol"}


def test_the_archives_shut_is_a_503_the_realm_survives(client, monkeypatch):
    async def shut() -> set[str]:
        raise archive.Shut("the archives are shut, and none can say what burns")

    monkeypatch.setattr(archive, "burning", shut)

    answer = client.get("/beacons")

    assert answer.status_code == 503
    assert answer.json() == {"detail": "the archives are shut, and none can say what burns"}
    assert client.get("/health").status_code == 200


def test_a_lighting_is_written_before_the_next_beacon_is_named(client, monkeypatch):
    kept = []

    async def keep(beacon: str) -> None:
        kept.append(beacon)

    monkeypatch.setattr(archive, "keep", keep)

    # Halifirien has no next beacon and fails; its fire was written all the same
    with TestClient(gondor, raise_server_exceptions=False) as failing:
        failing.post("/beacons/halifirien/light")

    client.post("/beacons/amon-din/light")

    assert kept == ["halifirien", "amon-din"]


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
