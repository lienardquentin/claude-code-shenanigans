#!/usr/bin/env sh
# Writes theseus/schema/theseus.schema.json from the schema core/schema.ts holds, which a test holds to the keys the
# plugin reads. Needs Node, and fetches tsx through npx the first time.
#
#   sh .claude/mods/kit/write-schema.sh          writes it
#   sh .claude/mods/kit/write-schema.sh --check  changes nothing, and fails when the file differs from the schema

set -eu

mods=$(cd "$(dirname "$0")/.." && pwd)
out="$mods/theseus/schema/theseus.schema.json"
made=$(cd "$mods/theseus" && npx --yes tsx@4.19.2 -e "import { SCHEMA } from './core/schema.ts'; process.stdout.write(JSON.stringify(SCHEMA, null, 2) + '\n')")

if [ "${1:-}" = "--check" ]; then
  printf '%s\n' "$made" | cmp -s - "$out" || { echo "drifted: theseus/schema/theseus.schema.json differs from core/schema.ts: sh .claude/mods/kit/write-schema.sh"; exit 1; }
else
  printf '%s\n' "$made" > "$out"
fi
