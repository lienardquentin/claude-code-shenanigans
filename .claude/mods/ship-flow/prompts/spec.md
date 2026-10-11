# Writing the spec of a run

The grilling is over. Synthesise what was agreed into the run's spec; ask the person nothing new except the one check in step 2. Everything you write goes in the run's working folder, `.scratch/<feature>/`, named in your first instructions. Publish nothing: the run opens the issue and the pull request itself.

## Steps

1. **Know the code.** Explore the repo where the feature lands, through the Explore agent named in your first instructions, unless this conversation already did. Use the vocabulary of `CONTEXT.md` and respect the decisions under `docs/adr/`. Done when you can name every module the feature touches.

2. **Choose the seams.** A seam is where the feature is tested from. Prefer a seam that exists to a new one, and the highest one that reaches the behaviour: the ideal number is one. Put the seams to the person and wait for their answer. Done when they have agreed to them.

3. **Find the verification commands.** These are the commands the unattended run executes, exactly as written, to decide that a ticket is built: the repo's tests, its typecheck, its lint. Look them up (`package.json` scripts, a Makefile, CI config, the README) and run each once to see that it works here and passes now. Done when every command you will list has run green in this session.

4. **Write `spec.md`** from the template below. Done when every section is filled and every decision of the grilling appears in it.

5. **Write `issue.md`**, only when the run started from an idea. It is the text of the one GitHub issue the run opens when the person approves: a first line `# <title>`, then the problem and the solution from the person's side, in a few short paragraphs. The spec stays local; the issue carries none of it. A run that started from an issue already has one: write no `issue.md`.

6. Read `tickets.md`, beside this file, and follow it.

## The spec template

```
# Spec: <feature>

## Problem Statement

The problem the person has, from their side.

## Solution

What solves it, from their side.

## User Stories

A long numbered list, each "As a <actor>, I want <feature>, so that <benefit>". Cover every aspect of the feature.

## Implementation Decisions

The modules built or changed and their interfaces, the architectural decisions, schema changes, API contracts, and
what the person clarified. Name modules, never file paths, and write no code: both go stale. One exception: a
snippet from a prototype that states a decision more exactly than prose can (a state machine, a schema, a type),
trimmed to the decision.

## Testing Decisions

The seams agreed in step 2, what makes a good test here (behaviour seen from outside, never the implementation),
which modules are tested, and the tests already in the repo that are the model for the new ones.

## Verification

One command a line, in a fenced block, each a real command that runs from the repo's root. Nothing else in the block.

## Out of Scope

What this spec leaves out.

## Further Notes
```
