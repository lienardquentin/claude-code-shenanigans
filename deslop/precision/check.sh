#!/bin/sh
# Deslop's findings on the projects of deslop/precision/projects, each at its pinned commit, against the findings
# kept beside it in <name>.txt: a change to deslop that adds a false finding, or loses a true one, shows as a diff.
#   deslop/precision/check.sh            compare, exit 1 on a difference
#   deslop/precision/check.sh --update   keep what deslop now finds
# Each project is fetched once into a folder of its own under $DESLOP_PRECISION_CACHE, a new temporary folder when
# unset, and only read: deslop parses it, nothing of it is run.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
cargo build --quiet --manifest-path "$root/deslop/Cargo.toml"
deslop="$root/deslop/target/debug/deslop"
if [ -n "${DESLOP_PRECISION_CACHE:-}" ]; then
    cache=$DESLOP_PRECISION_CACHE
else
    # A folder of this run's own, let go with what was fetched into it when the run ends
    cache=$(mktemp -d)
    trap 'rm -rf "$cache"' EXIT
fi
update=false
if [ "${1:-}" = --update ]; then update=true; fi
# git's empty tree: judged since it, every line of a project is one it added
empty=4b825dc642cb6eb9a060e54bf8d69288fbee4904
status=0
while read -r name url commit; do
    case $name in '' | '#'*) continue ;; esac
    tree="$cache/$name-$commit"
    if [ ! -d "$tree" ]; then
        # Fetched beside its place and moved there whole, so that a fetch that fails leaves no tree to judge
        fetching="$tree.fetching"
        rm -rf "$fetching"
        mkdir -p "$fetching"
        git -C "$fetching" init --quiet
        git -C "$fetching" fetch --quiet --depth 1 "$url" "$commit"
        git -C "$fetching" -c advice.detachedHead=false checkout --quiet FETCH_HEAD
        mv "$fetching" "$tree"
    fi
    found="$cache/$name.found"
    judged=0
    (cd "$tree" && "$deslop" check --since "$empty") >"$found" 2>"$cache/$name.stderr" || judged=$?
    # 1 is deslop finding something; more is deslop failing
    if [ "$judged" -gt 1 ]; then
        echo "deslop failed on $name:" >&2
        cat "$cache/$name.stderr" >&2
        exit 2
    fi
    if $update; then
        cp "$found" "$here/$name.txt"
        echo "$name: $(wc -l <"$found") findings kept"
    elif ! diff -u --label "$name.txt" --label "$name, now" "$here/$name.txt" "$found"; then
        status=1
    fi
done <"$here/projects"
exit $status
