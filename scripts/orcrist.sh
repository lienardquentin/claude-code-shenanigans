#!/bin/sh
# Orcrist on the lines a change added in one folder of the project, for a target's check in .claude/argonath:
#   scripts/orcrist.sh <folder> <commit>
# Built from the source next to this script first, then run from the folder, so that it judges that folder alone.
set -e
root=$(cd "$(dirname "$0")/.." && pwd)
cargo build --quiet --manifest-path "$root/orcrist/Cargo.toml"
cd "$root/$1"
exec "$root/orcrist/target/debug/orcrist" check --since "$2"
