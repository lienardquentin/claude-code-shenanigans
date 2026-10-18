#!/usr/bin/env sh
# Fails naming each plugin of .claude/mods whose shipped files changed since a commit while its version did not:
# `claude plugin update` takes a plugin whose version is unchanged for up to date, whatever its files hold. Its tests
# and its CHANGELOG are not shipped code, so a change to them alone needs no bump.
#
#   sh .claude/mods/kit/check-versions.sh <base>   compares HEAD with where it left <base>

set -eu

mods=$(cd "$(dirname "$0")/.." && pwd)
root=$(git -C "$mods" rev-parse --show-toplevel)
rel=${mods#"$root"/}
base=$(git -C "$root" merge-base "$1" HEAD)
version='s/.*"version": *"\([^"]*\)".*/\1/p'
unbumped=0

for manifest in "$mods"/*/.claude-plugin/plugin.json; do
  name=$(basename "$(dirname "$(dirname "$manifest")")")
  changed=$(git -C "$root" diff --name-only "$base" HEAD -- "$rel/$name" ":(exclude)$rel/$name/tests" ":(exclude)$rel/$name/CHANGELOG.md")

  [ -n "$changed" ] || continue

  # A plugin new since the base has no version to keep
  was=$(git -C "$root" show "$base:$rel/$name/.claude-plugin/plugin.json" 2>/dev/null | sed -n "$version") || was=
  now=$(sed -n "$version" "$manifest")

  if [ -n "$was" ] && [ "$was" = "$now" ]; then
    echo "unbumped: $name changed since $(git -C "$root" rev-parse --short "$base") but is still $now"
    unbumped=1
  fi
done

exit $unbumped
