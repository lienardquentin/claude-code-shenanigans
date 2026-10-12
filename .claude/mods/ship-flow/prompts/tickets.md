# Writing the tickets of a run

The spec is written. Break it into tickets, each built later by a fresh agent that sees only the spec and its own ticket, with nobody to ask. Write them in `.scratch/<feature>/issues/`, the run's working folder. Publish nothing.

## Steps

1. **Draft tracer bullets.** Each ticket is a tracer bullet: a narrow slice that cuts through every layer the feature has (schema, logic, interface, tests) and can be shown working by itself. Slice vertically, by behaviour; a ticket that is one layer of several behaviours is cut wrong. Do any prefactoring first, in tickets of its own: make the change easy, then make the easy change. Done when the tickets together build the whole spec and each one fits a single context window with room to spare.

2. **Give each ticket its blocking edges**: the tickets that must be done before it can start. Name only the tickets that truly gate it; a ticket with none can start at once. The run takes any ticket whose blockers are all done, and builds several side by side, each in a git worktree of its own, so a false edge delays work and a missing one breaks it. Done when the edges form no cycle and every ticket is reachable.

3. **Write one file a ticket**, `<NN>-<slug>.md`, numbered from `01` in an order where blockers come first, in the format below. Describe behaviour, never file paths or code, in the prose and in the criteria; the one place paths go is the `**Touches:**` line below. State the two fields from what you learnt exploring the code, while you still know it. Done when every acceptance criterion is something an agent can check by running a command or reading the code.

4. **Hold the checkpoint.** This is the one place the run stops for the person. Show them, in this order:
   - the spec's path, and the seams;
   - the tickets as a table: number, title, blocked by, what it delivers (the mod prints the blast radius under it by itself, and the waves it would build the tickets in);
   - the verification commands;
   - every file this session changed outside `.scratch/` (the glossary, ADRs), which the run commits on its feature branch when it starts.

   Then tell them: they may change the spec and the ticket files by hand or by asking you, and they approve by typing `/ship resume <feature>`, which opens the issue if the run has none, creates the branch and builds every ticket unattended. End your turn there. Approval is that command, typed by the person: build nothing yourself.

   As your turn ends the mod reads the ticket files. If it hands you a list of things to put right (a broken graph, a ticket with no `**Touches:**`, no `**Outward actions:**` or no criterion), fix the files, or tell the person why one stands as it is, and show the checkpoint again.

## A wide refactor is the exception

One mechanical change whose blast radius crosses the whole codebase (a renamed column, a retyped shared symbol) cannot land green as a slice. Sequence it as expand–contract: a ticket that adds the new form beside the old; one ticket a batch of call sites moved over, each blocked by the expand; a last ticket that removes the old form, blocked by every batch.

## The ticket format

```
# <NN>: <Title>

**What to build:** The behaviour this ticket makes work, end to end, from the person's side.

**Blocked by:** 01, 03

**Status:** ready

**Touches:** src/cart/total.ts, src/cart/, docs/cart.md
**Outward actions:** installs the npm package `zod`; deletes the generated folder `dist/`

- [ ] An acceptance criterion
- [ ] Another
```

- `**Touches:**` holds the paths, relative to the repo's root, that the ticket expects to change, separated by commas. A path ending in `/` is a directory. No globs. It is an estimate, not a limit, and the one exception to the rule that a ticket names no file path. It also decides what is built side by side: two tickets are built at once only when neither's paths are the other's or under them, and a ticket with no `**Touches:**` is built alone. So name the files, not a folder above them, and never leave the line out.
- `**Outward actions:**` holds `None`, or what the ticket expects to do that reaches outside the working tree or is hard to reverse, in plain words, separated by semicolons. Look for, for example: installing or removing a dependency, deleting files the repo does not track or that are generated, publishing, changing configuration outside the repo, a network call with an effect, a migration. These are examples, not a list to pick from. Never list the run's own push and pull request.

- `**Blocked by:**` holds ticket numbers, or `None (can start immediately)`.
- `**Status:**` is `ready` on every ticket you write. The run moves it to `in-progress`, `done`, `blocked` or `too-large`.
- Add a line `**Model:** <model>` only to a ticket that needs the strongest reasoning, naming the strong model from your first instructions. Every other ticket is built on the run's default.
