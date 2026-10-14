"""What Gondor keeps: the seven beacons from Minas Tirith to the border of Rohan, and the seeing-stones."""

from datetime import datetime, timezone

# Each beacon and the one its watchers look to next, east to west
RELAY = {
    "amon-din": "eilenach",
    "eilenach": "nardol",
    "nardol": "erelas",
    "erelas": "min-rimmon",
    "min-rimmon": "calenhad",
    "calenhad": "halifirien",
}

BEACONS = [*RELAY, "halifirien"]

# The beacons as narsil's chronicle spells them (narsil/src/chronicle.rs BEACONS, beacons/anor/app/utils/names.ts)
NAMES = {
    "amon-din": "Amon Dîn",
    "eilenach": "Eilenach",
    "nardol": "Nardol",
    "erelas": "Erelas",
    "min-rimmon": "Min-Rimmon",
    "calenhad": "Calenhad",
    "halifirien": "Halifirien",
}

# What burns, with no database: each burning beacon, its first keeper and since when it burns
lit: dict[str, dict[str, str | None]] = {}
# Every lighting there was, with no database, oldest first: id, beacon, lit_at, keeper
lightings: list[dict[str, object]] = []

STONES = {
    "anor": "Minas Tirith, and a white tree in flower",
    "orthanc": "Isengard, and a wheel of fire",
    "ithil": None,
    "elostirion": "the Sea, and the Straight Road beyond it",
}


class StoneIsWatched(Exception):
    """The stone is held by another will, and shows only what that will lets through."""


def stamp(at: datetime) -> str:
    """A time as Gondor writes it everywhere: UTC to the millisecond, with Z (2026-10-14T09:12:03.481Z)."""
    return at.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def light(name: str, keeper: str | None) -> dict[str, object]:
    now = stamp(datetime.now(timezone.utc))

    lightings.append({"id": len(lightings) + 1, "beacon": name, "lit_at": now, "keeper": keeper})
    # A beacon that already burns keeps the keeper and the time of its first lighting
    lit.setdefault(name, {"keeper": keeper, "since": now})

    return {"beacon": name, "lit": True, "watch_next": RELAY[name], "keeper": keeper}


def gaze(stone: str) -> str:
    vision = STONES[stone]

    if vision is None:
        raise StoneIsWatched(f"the {stone.capitalize()}-stone is held by the Enemy")

    return vision
