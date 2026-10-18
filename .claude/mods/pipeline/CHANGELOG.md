# Changelog

Each release bumps `version` in `.claude-plugin/plugin.json`: `claude plugin update` takes a plugin whose version has
not changed for up to date, whatever its files hold.

## 0.2.2

- No failure is dropped any more (#145). A part's work on a clock, its store writes, its prompts to Claude and its
  agent types say their failure in a toast and keep it: `mcp__pipeline__pane` with `troubles` lists what each part
  failed at, how often and when. A part failing alike is said once, then counted.
- What a run decides from no longer defaults when it cannot be read: the project's targets (once taken as none, which
  proved a change by its plan's commands alone), the quota (once taken as no limit), the tests written first (once
  taken as none, which skipped the check of what a builder changed of them), the ignore file of `.pipeline/`.
- Toasts say "failed" where they said "stumbled".

## 0.2.1

- CI validates and tests every mod, checks the kit copies and refuses a changed plugin whose version was not
  bumped (#146). `handlers/service.py` passes ruff.

## 0.2.0

- The lag check compares everything the plugin ships, not `hooks/` alone, and says when a copy differs under the same
  version, which `claude plugin update` will not replace (#144).
- First versioned release: everything merged up to #143 (the planner, the build, the test writer, verify, the review
  follow-up, the cleanup and the issues pane).

## 0.1.0

- The plugin as first installed, before versions were kept.
