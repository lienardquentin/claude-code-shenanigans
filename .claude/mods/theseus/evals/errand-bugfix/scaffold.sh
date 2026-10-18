#!/usr/bin/env bash
set -euo pipefail
bash "$(dirname "$0")/../fixture/make.sh"
cat > .theseus/issues/1.md <<'MD'
# Total ignores the last entry

`ledger.total` leaves the last entry out of the sum: `total([Entry("a", 100), Entry("b", 50)])` answers 100, where it
should answer 150. An empty ledger totals 0.

## Verification
python3 -m unittest discover -s tests -q
MD
