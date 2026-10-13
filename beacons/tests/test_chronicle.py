import json
import logging
import sys

from gondor.chronicle import JsonLines, request_id


def record(msg="the beacons are quenched", exc_info=None):
    return logging.LogRecord("gondor", logging.INFO, __file__, 1, msg, None, exc_info)


def test_a_line_is_one_json_object():
    line = json.loads(JsonLines().format(record()))

    assert line["level"] == "info"
    assert line["msg"] == "the beacons are quenched"
    assert "rid" not in line


def test_the_request_id_is_in_the_line_while_one_is_being_answered():
    marker = request_id.set("abc123")
    try:
        assert json.loads(JsonLines().format(record()))["rid"] == "abc123"
    finally:
        request_id.reset(marker)


def test_a_traceback_goes_under_the_line_in_plain_text():
    try:
        raise KeyError("halifirien")
    except KeyError:
        text = JsonLines().format(record(exc_info=sys.exc_info()))

    first, _, trace = text.partition("\n")

    assert json.loads(first)["msg"]
    assert "KeyError: 'halifirien'" in trace


def test_non_ascii_is_kept_as_written():
    assert "Dîn" in JsonLines().format(record("Amon Dîn burns"))
