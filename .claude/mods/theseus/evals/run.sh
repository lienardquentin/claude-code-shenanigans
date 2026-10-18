#!/usr/bin/env sh
# Runs Theseus's eval suite as a release is checked: every case, each its own sandbox, the report kept on this machine
# (never published), and a line a case appended to history/<version>.jsonl. Refuses (exit 1) when a case that passed
# in the last version recorded fails now, or the suite costs more than a quarter more.
#
#   sh evals/run.sh [--tag cheap] [--case <glob>] [--runs N] [--max-cost-usd N]
#
# It runs agents on your Claude account, as you: a full run of the suite costs a few dollars and takes the better
# part of an hour. `--tag cheap` checks the setup cases alone, in seconds and cents. Cases that run agents grant them a
# shell, which the eval runs only in Claude Code's sandbox: on Linux, bubblewrap and socat on the PATH.

set -eu

plugin=$(cd "$(dirname "$0")/.." && pwd)
version=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$plugin/.claude-plugin/plugin.json")
history="$plugin/evals/history"
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
mkdir -p "$history"

claude plugin eval "$plugin" --scaffold --trust-plugin --no-publish --ablation none --threshold 0 \
  --allow-tools Bash Edit Write Read Grep Glob ToolSearch 'mcp__theseus__*' \
  --json "$out/result.json" "$@"

# A line a case: its score, its cost, the version and when
node -e '
  const result = require(process.argv[1])
  const at = new Date().toISOString()
  // A case scores the mean of its runs, and costs what its runs and their judges spent
  for (const one of result.cases) {
    const runs = one.arms?.with ?? []
    console.log(JSON.stringify({ version: process.argv[2], at, case: one.name, score: one.aggregates.score, runs: runs.length, cost: runs.reduce((sum, run) => sum + (run.costUsd ?? 0), 0) }))
  }
' "$out/result.json" "$version" >> "$history/$version.jsonl"

# The last version recorded before this one, to compare with
previous=$(ls "$history" | sed 's/\.jsonl$//' | grep -v "^$version\$" | sort -V | tail -n 1)
[ -z "$previous" ] && { echo "No earlier version recorded: nothing to compare with."; exit 0; }

node -e '
  const fs = require("fs")
  const read = file => fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line))
  const last = by => Object.fromEntries(by.map(one => [one.case, one]))
  const before = last(read(process.argv[1]))
  const now = last(read(process.argv[2]))
  const worse = Object.values(now).filter(one => (before[one.case]?.score ?? 0) >= 1 && one.score < 1).map(one => one.case)
  const cost = rows => Object.values(rows).reduce((sum, one) => sum + (one.cost ?? 0), 0)
  const shared = Object.keys(now).filter(name => name in before)
  const costBefore = cost(Object.fromEntries(shared.map(name => [name, before[name]])))
  const costNow = cost(Object.fromEntries(shared.map(name => [name, now[name]])))
  if (worse.length > 0) { console.log(`Worse than ${process.argv[3]}: ${worse.join(", ")} passed there and fail now.`); process.exit(1) }
  if (costBefore > 0 && costNow > costBefore * 1.25) { console.log(`Dearer than ${process.argv[3]}: $${costNow.toFixed(2)} for what cost $${costBefore.toFixed(2)}.`); process.exit(1) }
  console.log(`As good as ${process.argv[3]} on every case it shares, for $${costNow.toFixed(2)} (was $${costBefore.toFixed(2)}).`)
' "$history/$previous.jsonl" "$history/$version.jsonl" "$previous"
