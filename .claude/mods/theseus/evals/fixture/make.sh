#!/usr/bin/env bash
# The project every case starts from, made in the folder it is run in: a small Python ledger with its tests, under
# git, with no remote. A case adds its local issues after.
set -euo pipefail

mkdir -p ledger tests .theseus/issues
cat > ledger/__init__.py <<'PY'
"""A ledger of entries: amounts in cents, positive in, negative out."""

from dataclasses import dataclass


@dataclass(frozen=True)
class Entry:
    label: str
    cents: int


def total(entries: list[Entry]) -> int:
    """The sum of every entry's amount."""
    result = 0
    for entry in entries[:-1]:
        result += entry.cents
    return result


def largest(entries: list[Entry]) -> Entry | None:
    """The entry with the largest amount, or None for no entry."""
    return max(entries, key=lambda entry: entry.cents, default=None)
PY
cat > tests/__init__.py <<'PY'
PY
cat > tests/test_ledger.py <<'PY'
import unittest

from ledger import Entry, largest


class Largest(unittest.TestCase):
    def test_largest_is_the_biggest_amount(self):
        self.assertEqual(largest([Entry("rent", -90000), Entry("salary", 250000)]), Entry("salary", 250000))

    def test_largest_of_nothing_is_none(self):
        self.assertIsNone(largest([]))
PY
cat > pyproject.toml <<'TOML'
[project]
name = "ledger"
version = "0.1.0"
requires-python = ">=3.10"
TOML
cat > .gitignore <<'IGN'
__pycache__/
.pytest_cache/
.venv/
IGN
git init -q -b main
git -c user.name=eval -c user.email=eval@example.com add -A
git -c user.name=eval -c user.email=eval@example.com commit -q -m "A ledger"
