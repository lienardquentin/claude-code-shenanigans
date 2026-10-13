"""The watchers on Rohan's border: they read from the broker the tidings of each beacon Gondor lights."""

import json
import os
import threading
import time
from collections.abc import Callable
from logging import ERROR, INFO, WARNING

from kafka import KafkaConsumer
from kafka.errors import KafkaError

# Where the broker is, as host:port, comma separated. With none, nobody watches and the realm stands as before.
BROKERS = os.environ.get("KAFKA_BROKERS", "")
TOPIC = "beacons.lit"
GROUP = "rohan-watchers"
# How long a watcher looks at each fire before he turns to the next, in seconds: above the pace the beacons are lit
# at, the watchers fall behind
PACE = float(os.environ.get("WATCH_PACE", "0"))
# How long the watchers wait before they look again: for the broker, and at tidings they could not read
PATIENCE = 5.0

Say = Callable[..., None]


def see(record, say: Say) -> None:
    """Reads one record. Tidings that do not read are an error, and stay the next to be read."""
    rid = next((value.decode() for key, value in record.headers if key == "rid"), "")
    tidings = json.loads(record.value)

    time.sleep(PACE)
    say(INFO, "the watchers see a beacon burning", rid=rid, beacon=tidings["beacon"], next=tidings["watch_next"], offset=record.offset)


def watch(say: Say, halt: threading.Event) -> None:
    """Reads the tidings one by one until told to halt, each marked as read only once it has been."""
    while not halt.is_set():
        try:
            # Watchers who leave without a word are missed by the broker after ten seconds, not the usual forty-five
            watchers = KafkaConsumer(TOPIC, bootstrap_servers=BROKERS.split(","), group_id=GROUP, client_id="rohan", bootstrap_timeout_ms=5000, session_timeout_ms=10000, enable_auto_commit=False, auto_offset_reset="earliest")
        except KafkaError as failure:
            say(WARNING, "the watchers find no broker", brokers=BROKERS, why=type(failure).__name__)
            halt.wait(PATIENCE)
            continue

        say(INFO, "the watchers take their posts", topic=TOPIC, group=GROUP)

        try:
            while not halt.is_set():
                for partition, records in watchers.poll(timeout_ms=1000, max_records=1).items():
                    for record in records:
                        try:
                            see(record, say)
                        except Exception as failure:
                            # Not skipped: what cannot be read stands in the way of all that comes after it
                            say(ERROR, f"the watchers cannot read the tidings: {type(failure).__name__}: {failure}", topic=TOPIC, offset=record.offset)
                            watchers.seek(partition, record.offset)
                            halt.wait(PATIENCE)
                        else:
                            watchers.commit()
        except KafkaError as failure:
            say(ERROR, f"the watchers lost the broker: {type(failure).__name__}", brokers=BROKERS)
            halt.wait(PATIENCE)
        finally:
            watchers.close()


def post(say: Say) -> threading.Event:
    """Sets the watchers on their hill, where there is a broker to watch. Set what it hands back to call them down."""
    halt = threading.Event()

    if BROKERS:
        threading.Thread(target=watch, args=(say, halt), daemon=True).start()

    return halt
