# Changelog

Each release bumps `version` in `.claude-plugin/plugin.json`: `claude plugin update` takes a plugin whose version has
not changed for up to date, whatever its files hold.

## 0.2.1

- A tool call another plugin refused gets no note added to it: the note made the answer one the engine does not take
  (found by the type check, `kit/typecheck.sh`).

## 0.2.0

- `.claude/palantir`, the project file's name before #104, is no longer read: name it `.claude/runtime` (#150).

## 0.1.1

- The manifest names its author, homepage, repository, license (MIT) and keywords (#149).

## 0.1.0

- First versioned release.
