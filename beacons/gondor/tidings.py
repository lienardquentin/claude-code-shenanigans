"""The tidings Gondor sends abroad: one record on the broker for each beacon lit, for whoever watches the hills."""

import json
import os
import threading
from datetime import datetime, timezone

from kafka import KafkaProducer
from kafka.errors import KafkaError

from .chronicle import request_id, scribe

# Where the broker is, as host:port, comma separated. With none, no tidings are sent and the realm stands as before.
BROKERS = os.environ.get("KAFKA_BROKERS", "")
TOPIC = "beacons.lit"
# How long the heralds wait before they look for the broker again
PATIENCE = 5.0

log = scribe()

herald: KafkaProducer | None = None
halt = threading.Event()


def seek() -> None:
    """Looks for the broker until it is found: a realm that wakes before the broker does sends tidings once it can."""
    global herald

    while not halt.is_set():
        try:
            # A lighting waits a second at most for the broker, and a record that cannot be handed over is given up
            # on after ten: what a watcher of the logs should see is the error, not a realm that hangs
            herald = KafkaProducer(bootstrap_servers=BROKERS.split(","), client_id="gondor", bootstrap_timeout_ms=5000, max_block_ms=1000, request_timeout_ms=5000, delivery_timeout_ms=10000)
        except KafkaError as failure:
            log.warning("the heralds find no broker at %s: %s", BROKERS, type(failure).__name__)
            halt.wait(PATIENCE)
        else:
            log.info("the heralds stand ready; tidings go to %s on %s", TOPIC, BROKERS)

            return


def wake() -> None:
    if BROKERS:
        halt.clear()
        threading.Thread(target=seek, daemon=True).start()


def sleep() -> None:
    halt.set()

    if herald is not None:
        herald.close(timeout=2)


def lost(rid: str, beacon: str, failure: BaseException) -> None:
    log.error("the tidings of %s were lost on the road: %s", beacon, type(failure).__name__, extra={"rid": rid})


def send(beacon: str, watch_next: str, keeper: str | None) -> None:
    """Tells the broker a beacon is lit, and who lit it, under the id of the request that lit it. A lighting never fails for it."""
    if not BROKERS:
        return

    rid = request_id.get()

    if herald is None:
        log.warning("no tidings of %s are sent: the heralds have found no broker yet", beacon)

        return

    tidings = {"beacon": beacon, "watch_next": watch_next, "keeper": keeper, "at": datetime.now(timezone.utc).isoformat(timespec="milliseconds")}

    try:
        sent = herald.send(TOPIC, key=beacon.encode(), value=json.dumps(tidings).encode(), headers=[("rid", rid.encode())])
    except KafkaError as failure:
        lost(rid, beacon, failure)

        return

    # The answer comes on the herald's own thread, where no request is being answered: the id is handed along
    sent.add_errback(lambda failure: lost(rid, beacon, failure))
    log.info("tidings of %s are sent to %s", beacon, TOPIC)
