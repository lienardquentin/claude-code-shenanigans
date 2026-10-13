"""The errand-riders: they go to Gondor's door again and again, so the realms have something to log. Plain lines."""

import os
import random
import sys
import time
from datetime import datetime, timezone

import httpx

GONDOR_URL = os.environ.get("GONDOR_URL", "http://127.0.0.1:8101")
ANOR_URL = os.environ.get("ANOR_URL", "http://127.0.0.1:8100")
PACE = float(os.environ.get("RIDERS_PACE", "0.8"))

BEACONS = ["amon-din", "eilenach", "nardol", "erelas", "min-rimmon", "calenhad", "halifirien"]

# Each errand and how often it is ridden. Some end badly by design: the last beacon, the stone the Enemy holds, a
# stone long lost, and a muster of more spears than Rohan has.
ERRANDS = [
    (6, lambda: ("GET", "/beacons")),
    (6, lambda: ("POST", f"/beacons/{random.choice(BEACONS[:-1])}/light")),
    (1, lambda: ("POST", "/beacons/halifirien/light")),
    (1, lambda: ("POST", "/beacons/quench")),
    (4, lambda: ("GET", f"/palantiri/{random.choice(['anor', 'orthanc', 'elostirion'])}/gaze")),
    (1, lambda: ("GET", "/palantiri/ithil/gaze")),
    (1, lambda: ("GET", "/palantiri/osgiliath/gaze")),
    (5, lambda: ("POST", f"/muster?spears={random.choice([500, 2000, 4000, 6000])}")),
    (1, lambda: ("POST", f"/muster?spears={random.choice([7000, 9000, 12000])}")),
]


def tell(text: str) -> None:
    stamp = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")

    print(f"{stamp} {text}", file=sys.stdout, flush=True)


def main() -> None:
    weights = [weight for weight, _ in ERRANDS]
    rider = 0

    tell(f"the riders set out for {GONDOR_URL}")

    # Anor may not be there (its packages not installed): the riders look for it again every half minute
    anor_shut_until = 0.0

    with httpx.Client(base_url=GONDOR_URL, timeout=10) as gondor, httpx.Client(base_url=ANOR_URL, timeout=10) as anor:
        while True:
            rider += 1
            method, path = random.choices(ERRANDS, weights)[0][1]()
            started = time.perf_counter()

            # One rider in four goes by the Steward's stone, as a visitor of the page would
            if random.random() < 0.25 and time.monotonic() >= anor_shut_until:
                try:
                    answer = anor.request(method, f"/api/realm{path}")
                except httpx.HTTPError:
                    anor_shut_until = time.monotonic() + 30
                    tell(f"WARN rider {rider} found Anor veiled: the stone does not answer")
                    continue

                took = round((time.perf_counter() - started) * 1000)
                tell(f"{'WARN ' if answer.status_code >= 400 else ''}rider {rider} looked through Anor: {answer.status_code} to {method} {path} in {took}ms")
                time.sleep(random.uniform(PACE * 0.5, PACE * 1.5))
                continue

            try:
                answer = gondor.request(method, path)
            except httpx.HTTPError as failure:
                tell(f"ERROR rider {rider} found the gate shut: gondor does not answer ({type(failure).__name__})")
                time.sleep(PACE * 3)
                continue

            took = round((time.perf_counter() - started) * 1000)

            if answer.status_code >= 500:
                tell(f"ERROR rider {rider} lost on the road: gondor answered {answer.status_code} to {method} {path}")
            elif answer.status_code >= 400:
                tell(f"WARN rider {rider} turned back: {answer.status_code} to {method} {path}")
            else:
                tell(f"rider {rider} rode {method} {path} in {took}ms")

            time.sleep(random.uniform(PACE * 0.5, PACE * 1.5))


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
