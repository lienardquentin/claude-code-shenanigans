import asyncio

import pytest
from fastapi.testclient import TestClient

from rohan import app as rohan_module
from rohan.app import EOREDS, RED_ARROW, SPEARS, Logfmt, app

ARROW = {"Authorization": f"Bearer {RED_ARROW}"}


@pytest.fixture
def client(monkeypatch):
    # No hesitation, and no waiting should there be one
    monkeypatch.setattr(rohan_module.random, "random", lambda: 1.0)

    return TestClient(app)


def test_health(client):
    assert client.get("/health").json() == {"realm": "rohan", "stands": True}


def test_riders_lists_the_eoreds_and_their_spears(client):
    riders = client.get("/riders").json()

    assert {r["eored"]: r["spears"] for r in riders} == EOREDS


def test_the_eoreds_hold_no_more_than_the_mark_can_muster():
    assert sum(EOREDS.values()) <= SPEARS


def test_the_rohirrim_ride(client):
    answer = client.post("/riders/muster", json={"spears": 1000}, headers=ARROW)

    assert answer.status_code == 200
    assert answer.json() == {"riding": 1000, "days": 5}


def test_exactly_what_the_mark_has_is_granted(client):
    assert client.post("/riders/muster", json={"spears": SPEARS}, headers=ARROW).status_code == 200


def test_one_spear_too_many_is_refused(client):
    answer = client.post("/riders/muster", json={"spears": SPEARS + 1}, headers=ARROW)

    assert answer.status_code == 409
    assert str(SPEARS) in answer.json()["detail"]


def test_a_false_arrow_is_turned_away(client):
    answer = client.post("/riders/muster", json={"spears": 10}, headers={"Authorization": "Bearer nope"})

    assert answer.status_code == 401


def test_no_arrow_at_all_is_turned_away(client):
    assert client.post("/riders/muster", json={"spears": 10}).status_code == 401


def test_a_muster_without_a_number_is_unprocessable(client):
    assert client.post("/riders/muster", json={}, headers=ARROW).status_code == 422


def test_the_kings_doubt_delays_but_does_not_refuse(monkeypatch):
    slept = []

    async def sleep(seconds):
        slept.append(seconds)

    monkeypatch.setattr(rohan_module.random, "random", lambda: 0.0)
    monkeypatch.setattr(rohan_module.asyncio, "sleep", sleep)

    answer = TestClient(app).post("/riders/muster", json={"spears": 10}, headers=ARROW)

    assert answer.status_code == 200
    assert len(slept) == 1 and 0.4 <= slept[0] <= 0.9


def test_logfmt_quotes_values_with_spaces():
    import logging

    record = logging.LogRecord("rohan", logging.INFO, __file__, 1, "the Rohirrim ride", None, None)
    record.fields = {"rid": "abc", "note": "two words"}

    line = Logfmt().format(record)

    assert 'level=info' in line
    assert 'msg="the Rohirrim ride"' in line
    assert "rid=abc" in line
    assert 'note="two words"' in line
