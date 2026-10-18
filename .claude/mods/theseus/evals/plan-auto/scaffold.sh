#!/usr/bin/env bash
set -euo pipefail
bash "$(dirname "$0")/../fixture/make.sh"
cat > .theseus/issues/2.md <<'MD'
# Balances by label, and a report of them

A ledger should say how much each label comes to, and print it.

- `ledger.balances(entries)` answers a dict from each label to the sum of its amounts, in cents.
- `ledger.report(entries)` answers one line a label, sorted by label, `label: 12.34` (cents written as a decimal
  amount with two places, a minus for a negative one), then a last line `total: …` for the whole ledger.

## Verification
python3 -m unittest discover -s tests -q
MD
