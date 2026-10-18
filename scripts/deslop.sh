#!/bin/sh
# Deslop on the lines a change added in one folder of the project, for a target's check in .claude/theseus.toml:
#   scripts/deslop.sh <folder> <commit>
# Built from the source next to this script first, then run from the folder, so that it judges that folder alone.
set -e
root=$(cd "$(dirname "$0")/.." && pwd)
cargo build --quiet --manifest-path "$root/deslop/Cargo.toml"
cd "$root/$1"
exec "$root/deslop/target/debug/deslop" check --since "$2"
