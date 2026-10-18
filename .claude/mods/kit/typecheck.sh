#!/usr/bin/env sh
# Type-checks a mod against the engine's own types, which Claude Code writes: beside a mod it has loaded from a folder
# (.claude-plugin/types/), or with the plugin-authoring skill once it has loaded in a session. Needs Node; fetches
# TypeScript through npx the first time.
#
#   sh .claude/mods/kit/typecheck.sh <mod folder> [types file]

set -eu

mod=$(cd "$1" && pwd)
types=${2:-}

if [ -z "$types" ]; then
  if [ -f "$mod/.claude-plugin/types/claude-code/index.d.ts" ]; then
    types="$mod/.claude-plugin/types/claude-code/index.d.ts"
  else
    types=$(ls -t /tmp/claude-*/bundled-skills/*/*/plugin-authoring/types/claude-code.d.ts 2>/dev/null | head -n 1 || true)
  fi
fi

[ -n "$types" ] && [ -f "$types" ] || { echo "No engine types found: load the mod once (claude --plugin-dir $1), or the plugin-authoring skill in a session, or name the types file."; exit 2; }

config=$(mktemp -d)
trap 'rm -rf "$config"' EXIT
cat > "$config/tsconfig.json" <<JSON
{
  "compilerOptions": {
    "target": "es2023", "lib": ["es2023"], "types": [],
    "module": "esnext", "moduleResolution": "bundler",
    "strict": true, "noUncheckedIndexedAccess": true,
    "noEmit": true, "skipLibCheck": true,
    "jsx": "react", "jsxFactory": "h", "jsxFragmentFactory": "Fragment"
  },
  "include": ["$types", "$mod/hooks", "$mod/core", "$mod/types"]
}
JSON
npx --yes -p typescript@5.6.3 tsc -p "$config/tsconfig.json"
