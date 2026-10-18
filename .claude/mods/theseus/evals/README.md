# Theseus's evals

Unit tests say the parts work. These say whether Theseus does: each case gives Claude, with Theseus loaded, what a
person would ask, in a fresh sandbox holding a small project, and grades what came of it: the tools called, the run's
end, the files on the run's branch, and what Claude told the person.

| Case | What it asks | What it checks |
|---|---|---|
| `doctor` | "Is Theseus set up here?" | Claude asks Theseus's doctor tool, and names the missing remote and project file with their fixes. |
| `init` | `/theseus init` | A project file is proposed from the project, with the reviews, and nothing is written. |
| `errand-bugfix` | Fix local issue 1 as an errand that goes on by itself | The run ends built; the fix and a test of it are on the run's branch, not in your checkout; Claude reports the proof and the reviewers. |
| `plan-auto` | Plan local issue 2 and build it by itself | Planned before built, two tasks or more committed, both functions on the branch. |
| `tests-first` | Have the test writer write the tests of `average` | Tests are written and shown red; the source is left for whoever builds it. |

Every case starts from `fixture/make.sh`: a Python ledger with its tests, under git, with no remote, so its issues are
local ones (`.theseus/issues/<n>.md`, named `local:<n>`), and a run ends built and reviewed, before any push.

## Running them

```sh
sh evals/run.sh --tag cheap           # the setup cases: seconds, cents
sh evals/run.sh                       # every case: the better part of an hour, a few dollars
sh evals/run.sh --case errand-bugfix --runs 3
```

`run.sh` keeps the report on this machine (it is never published), appends a line a case to
`history/<version>.jsonl`, and fails when a case that passed in the last version recorded fails now, or the suite costs
over a quarter more. Run it before tagging a release, and commit the history line with the release.

The cases that run agents grant them a shell, which the eval allows only in Claude Code's sandbox: on Linux, bubblewrap
and socat must be on the PATH (`/theseus doctor` says whether they are).
