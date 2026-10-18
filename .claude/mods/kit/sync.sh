#!/usr/bin/env sh
# The mods' kit: this folder is the one source of each helper they share. A plugin is installed alone,
# so each mod carries its own copy under hooks/kit/; this script lays every file here over each copy a mod of the
# marketplace holds. A mod takes up a kit file by copying it into its hooks/kit/ once; from then on it is kept here.
#
#   sh .claude/mods/kit/sync.sh          lays the kit over every copy
#   sh .claude/mods/kit/sync.sh --check  changes nothing, and fails naming each copy that differs from the kit

set -eu

kit=$(cd "$(dirname "$0")" && pwd)
mods=$(dirname "$kit")
check=false
[ "${1:-}" = "--check" ] && check=true

# The marketplace's own plugins, by the folder each is sourced from
plugins=$(sed -n 's/.*"source": *"\.\/\([^"]*\)".*/\1/p' "$mods/.claude-plugin/marketplace.json")
drift=0

for plugin in $plugins; do
  for source in "$kit"/*.ts; do
    copy="$mods/$plugin/hooks/kit/$(basename "$source")"

    [ -f "$copy" ] || continue
    cmp -s "$source" "$copy" && continue

    if $check; then
      echo "drifted: ${copy#"$mods"/}"
      drift=1
    else
      cp "$source" "$copy"
      echo "laid: ${copy#"$mods"/}"
    fi
  done
done

exit $drift
