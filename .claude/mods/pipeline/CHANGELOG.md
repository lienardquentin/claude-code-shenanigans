# Changelog

Each release bumps `version` in `.claude-plugin/plugin.json`: `claude plugin update` takes a plugin whose version has
not changed for up to date, whatever its files hold.

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
