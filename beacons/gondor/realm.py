"""What Gondor keeps: the seven beacons from Minas Tirith to the border of Rohan, and the seeing-stones."""

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

lit: set[str] = set()

STONES = {
    "anor": "Minas Tirith, and a white tree in flower",
    "orthanc": "Isengard, and a wheel of fire",
    "ithil": None,
    "elostirion": "the Sea, and the Straight Road beyond it",
}


class StoneIsWatched(Exception):
    """The stone is held by another will, and shows only what that will lets through."""


def light(name: str) -> dict[str, object]:
    lit.add(name)

    return {"beacon": name, "lit": True, "watch_next": RELAY[name]}


def gaze(stone: str) -> str:
    vision = STONES[stone]

    if vision is None:
        raise StoneIsWatched(f"the {stone.capitalize()}-stone is held by the Enemy")

    return vision
