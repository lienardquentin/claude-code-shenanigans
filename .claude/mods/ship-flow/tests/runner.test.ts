import { describe, expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { answerRepo, spec, ticket } from './repo'

type Engine = Parameters<TestBody>[0]
type Repo = ReturnType<typeof answerRepo>

const CART = '.scratch/checkout/issues/01-cart.md'
const PAY = '.scratch/checkout/issues/02-pay.md'
const TAX = '.scratch/checkout/issues/03-tax.md'
const RECORD = '.scratch/checkout/run.json'
// The worktree the first ticket is built in
const TREE = '/home/dev/repo/.scratch/checkout/trees/01'

const checkout = (commands: readonly string[] = ['npm test', 'npm run typecheck']) => ({
  '.scratch/checkout/spec.md': spec(commands),
  [CART]: ticket('01', 'A cart holds items', ['**Blocked by:** None', '**Status:** ready']),
  [PAY]: ticket('02', 'A cart is paid', ['**Blocked by:** 01', '**Status:** ready']),
})

// A third ticket that hangs off nothing: the run can take it whatever happens to the other two
const withTax = () => ({
  ...checkout(),
  [TAX]: ticket('03', 'Tax is added', ['**Blocked by:** None', '**Status:** ready']),
})

const ship = async ($: Engine, args: string) => (await $.command.run({ command: 'ship', args } as never)).text ?? ''

// The implementer's turn ends, having left `changes` in the working tree
const ends = async ($: Engine, repo: Repo, agentId: string, { reason = 'answer', changes = ' M src/cart.ts\n' } = {}) => {
  repo.change(changes)
  repo.ran.length = 0
  await $.turn.complete({ answer: 'Built.', durationMs: 1, isAborted: reason === 'aborted', turnId: 't1', agentId, reason } as never)
}

// What a sandboxed session puts in front of a command before the run is asked about it
const SANDBOXED =
  "export HTTP_PROXY='http://1-a:x@127.0.0.1:57577' NO_PROXY='localhost,127.0.0.1,::1'; curl() { command curl --suppress-connect-headers \"$@\"; }\n"

const checks = async ($: Engine, agentId: string, tool: string, input: unknown) =>
  (await $.tool.check({ tool, input, agentId, tool_use_id: 'call-1' } as never)).decision

describe('/ship resume', () => {
  test('refuses a spec with no verification commands and a broken graph, with each reason', async ($, on) => {
    const repo = answerRepo(on, {
      files: {
        '.scratch/checkout/spec.md': spec(),
        [CART]: ticket('01', 'A cart holds items', ['**Blocked by:** 07', '**Status:** ready']),
      },
    })

    expect((await ship($, 'resume')).split('\n')).toEqual([
      'checkout: cannot be run',
      '  01 is blocked by 07, which does not exist',
      '  the spec has no Verification section naming the commands to run',
    ])
    expect(repo.spawned).toEqual([])
  })

  test('starts on uncommitted changes all the same: nothing of the run is built or discarded in the repo\'s own working tree', async ($, on) => {
    const repo = answerRepo(on, { files: checkout(), porcelain: ' M src/cart.ts\n' })

    expect(await ship($, 'resume')).toBe('checkout: building 01 A cart holds items on sonnet.')
    expect(repo.ran).not.toContain('git reset --hard HEAD')
    expect(repo.ran).not.toContain('git clean -fd')
    expect(repo.statusOf(CART)).toBe('in-progress')
  })

  test('refuses to start while the run files are not ignored by git', async ($, on) => {
    const repo = answerRepo(on, { files: checkout(), isIgnored: false })

    expect(await ship($, 'resume')).toMatch(/\.scratch\/ is not ignored by git/)
    expect(repo.spawned).toEqual([])
  })

  test('asks which run when a repo has several, and takes the one named', async ($, on) => {
    const repo = answerRepo(on, {
      files: {
        ...checkout(),
        '.scratch/search/spec.md': spec(['npm test']),
        '.scratch/search/issues/01-index.md': ticket('01', 'Pages are indexed', ['**Blocked by:** None', '**Status:** ready']),
      },
    })

    expect(await ship($, 'resume')).toMatch(/Several runs here: checkout, search/)
    expect(await ship($, 'resume search')).toMatch(/search: building 01 Pages are indexed/)
    expect(repo.spawned).toHaveLength(1)
  })

  test('starts the implementer of the first takeable ticket, with pointers to the spec and the ticket', async ($, on) => {
    const repo = answerRepo(on, { files: checkout() })

    expect(await ship($, 'resume')).toBe('checkout: building 01 A cart holds items on sonnet.')
    expect(repo.spawned).toEqual([
      {
        subagentType: 'ship-flow:implementer',
        description: 'Build ticket 01',
        model: 'sonnet',
        prompt: 'Build the ticket /home/dev/repo/.scratch/checkout/issues/01-cart.md of the spec /home/dev/repo/.scratch/checkout/spec.md.',
        cwd: TREE,
      },
    ])
    expect(repo.statusOf(CART)).toBe('in-progress')
    expect(repo.statusOf(PAY)).toBe('ready')
  })

  test('builds the ticket in a worktree of its own, on a branch cut from the run\'s', async ($, on) => {
    const repo = answerRepo(on, { files: checkout() })

    await ship($, 'resume')

    expect(repo.ran).toContain(`git worktree add -B checkout-feature--01 ${TREE} checkout-feature`)
  })

  test('runs the spec\'s setup commands in the fresh worktree before the implementer starts', async ($, on) => {
    const repo = answerRepo(on, {
      files: { ...checkout(), '.scratch/checkout/spec.md': `${spec(['npm test'])}\n## Setup\n\n\`\`\`\nnpm ci\n\`\`\`\n` },
    })

    await ship($, 'resume')

    expect(repo.ran).toContain('01> sh -c npm ci')
    expect(repo.spawned).toHaveLength(1)
  })

  test('starts no implementer in a worktree that could not be made or set up, and waits for the person', async ($, on) => {
    const repo = answerRepo(on, { files: checkout() })

    repo.landing.failsToPlant = true

    expect(await ship($, 'resume')).toBe(
      'checkout: 01 A cart holds items was not started: its worktree could not be made: fatal: could not create work tree dir.',
    )
    expect(repo.spawned).toEqual([])
    expect(repo.statusOf(CART)).toBe('ready')
    expect(repo.record('checkout')).toMatchObject({ phase: 'paused', pause: 'its worktree could not be made: fatal: could not create work tree dir' })
    expect(repo.record('checkout').flights).toBeUndefined()
  })

  test('records the run: its feature, branch, phase, the ticket in flight, its agent, attempt and the usage it read', async ($, on) => {
    const repo = answerRepo(on, { files: checkout() })

    await ship($, 'resume')

    const usage = {
      at: 1000,
      contextPercent: 12,
      quota: [{ kind: 'five_hour', percentUsed: 40, resetsAt: '2026-10-11T20:00:00.000Z' }],
    }

    expect(repo.record('checkout')).toEqual({
      feature: 'checkout',
      branch: 'checkout-feature',
      phase: 'unattended',
      flights: [{ ticket: 1, tree: '.scratch/checkout/trees/01', branch: 'checkout-feature--01', startedAt: 1000, agentId: 'agent-1' }],
      attempts: { '01': 1 },
      startUsage: usage,
      usage,
    })
  })

  test('builds a ticket on the model it names', async ($, on) => {
    const repo = answerRepo(on, {
      files: {
        ...checkout(),
        [CART]: ticket('01', 'A cart holds items', ['**Blocked by:** None', '**Status:** ready', '**Model:** opus']),
      },
    })

    await ship($, 'resume')

    expect(repo.spawned[0]?.model).toBe('opus')
  })

  test('says how the run stands when no ticket can be taken', async ($, on) => {
    answerRepo(on, {
      files: {
        ...checkout(),
        [CART]: ticket('01', 'A cart holds items', ['**Blocked by:** None', '**Status:** blocked']),
      },
    })

    expect(await ship($, 'resume')).toBe(
      'checkout: no ticket left to take: 0 of 2 done, 2 blocked; nothing was built: there is no pull request to open.',
    )
  })

  test('takes up a run that was cut off mid-ticket: the ticket\'s worktree is removed and it is built anew', async ($, on) => {
    const repo = answerRepo(on, {
      files: {
        ...checkout(),
        [CART]: ticket('01', 'A cart holds items', ['**Blocked by:** None', '**Status:** in-progress']),
        [RECORD]: JSON.stringify({
          feature: 'checkout',
          branch: 'checkout-feature',
          phase: 'unattended',
          flights: [{ ticket: 1, tree: '.scratch/checkout/trees/01', branch: 'checkout-feature--01', agentId: 'gone' }],
          attempts: { '01': 2 },
        }),
      },
    })

    expect(await ship($, 'resume')).toMatch(/building 01 A cart holds items/)
    expect(repo.ran.slice(0, repo.ran.indexOf(`git worktree add -B checkout-feature--01 ${TREE} checkout-feature`))).toEqual(
      expect.arrayContaining([`git worktree remove --force ${TREE}`, 'git branch -D checkout-feature--01']),
    )
    // The repo's own working tree is the person's: nothing of it is discarded
    expect(repo.ran).not.toContain('git reset --hard HEAD')
    expect(repo.statusOf(CART)).toBe('in-progress')
    expect(repo.record('checkout')).toMatchObject({ flights: [{ ticket: 1, agentId: 'agent-1' }], attempts: { '01': 1 } })
  })

  test('does not start a second implementer while one is building', async ($, on) => {
    const repo = answerRepo(on, { files: checkout() })

    await ship($, 'resume')

    expect(await ship($, 'resume')).toBe('checkout: ticket 01 is being built now.')
    expect(repo.spawned).toHaveLength(1)
  })
})

describe('when an implementer has finished', () => {
  test('the run runs each verification command itself, commits once, marks the ticket done and takes the next', async ($, on) => {
    const repo = answerRepo(on, { files: checkout() })

    await ship($, 'resume')
    await ends($, repo, 'agent-1')

    expect(repo.ran.slice(0, 10)).toEqual([
      '01> sh -c npm test',
      '01> sh -c npm run typecheck',
      '01> git status --porcelain',
      '01> git add -A',
      '01> git commit -m checkout: A cart holds items',
      '01> git diff --name-only HEAD~1 HEAD',
      'git merge-base --is-ancestor checkout-feature checkout-feature--01',
      'git rev-parse --abbrev-ref HEAD',
      'git merge --ff-only checkout-feature--01',
      '01> git rev-parse --short HEAD',
    ])
    expect(repo.statusOf(CART)).toBe('done')
    expect(repo.statusOf(PAY)).toBe('in-progress')
    expect(repo.spawned.map(agent => agent.description)).toEqual(['Build ticket 01', 'Build ticket 02'])
    expect(repo.record('checkout')).toMatchObject({ phase: 'unattended', flights: [{ ticket: 2, agentId: 'agent-2' }], attempts: { '01': 1, '02': 1 } })
  })

  test('a ticket that has landed leaves no worktree and no branch behind', async ($, on) => {
    const repo = answerRepo(on, { files: checkout() })

    await ship($, 'resume')
    await ends($, repo, 'agent-1')

    expect(repo.ran).toContain(`git worktree remove --force ${TREE}`)
    expect(repo.ran).toContain('git branch -D checkout-feature--01')
  })

  test('the run\'s branch is moved all the same when the person has checked out another', async ($, on) => {
    const repo = answerRepo(on, { files: checkout() })

    await ship($, 'resume')
    repo.switchTo('main')
    await ends($, repo, 'agent-1')

    expect(repo.ran).toContain('git fetch . checkout-feature--01:checkout-feature')
    expect(repo.ran).not.toContain('git merge --ff-only checkout-feature--01')
    expect(repo.statusOf(CART)).toBe('done')
  })

  test('the transcript gets one line a ticket, and the building ends when every ticket is done', async ($, on) => {
    const repo = answerRepo(on, { files: checkout() })

    await ship($, 'resume')
    await ends($, repo, 'agent-1')
    await ends($, repo, 'agent-2')

    expect(repo.logged).toEqual([
      'checkout: 01 A cart holds items is done (abc1234); building 02 A cart is paid on sonnet.',
      'checkout: 02 A cart is paid is done (abc1235); no ticket left to take: 2 of 2 done; reviewing the branch on opus.',
    ])
    expect(repo.record('checkout')).toMatchObject({ phase: 'finishing', commits: { '01': 'abc1234', '02': 'abc1235' } })
    expect(repo.spawned.map(agent => agent.description)).toEqual(['Build ticket 01', 'Build ticket 02', 'Review checkout'])
  })

  test('work that does not pass is kept in its worktree, and the ticket tried once more by an implementer told to put it right', async ($, on) => {
    const repo = answerRepo(on, { files: checkout(), exits: { 'npm run typecheck': 2 } })

    await ship($, 'resume')
    await ends($, repo, 'agent-1')

    expect(repo.ran.slice(0, 2)).toEqual(['01> sh -c npm test', '01> sh -c npm run typecheck'])
    // The worktree is neither removed nor made again: the second implementer finds the first one's work there
    expect(repo.ran).not.toContain(`git worktree remove --force ${TREE}`)
    expect(repo.ran.some(line => line.startsWith('git worktree add'))).toBe(false)
    expect(repo.ran).not.toContain('git merge --ff-only checkout-feature--01')
    expect(repo.statusOf(CART)).toBe('in-progress')
    expect(repo.spawned[1]?.cwd).toBe(TREE)
    expect(repo.spawned[1]?.prompt.split('\n')).toEqual([
      'Build the ticket /home/dev/repo/.scratch/checkout/issues/01-cart.md of the spec /home/dev/repo/.scratch/checkout/spec.md.',
      '',
      'A first attempt at this ticket did not pass: `npm run typecheck` failed. Its work is still in your worktree: read it with git status, git diff and git log before anything else, then put right what failed rather than starting over.',
      'What the failure said:',
      '',
      'expected 2 but got 3',
    ])
    expect(repo.record('checkout')).toMatchObject({ flights: [{ ticket: 1, agentId: 'agent-2' }], attempts: { '01': 2 } })
    expect(repo.logged).toEqual([
      'checkout: 01 A cart holds items failed (`npm run typecheck` failed): its work is kept, for one more attempt to put right; repairing 01 A cart holds items on sonnet.',
    ])
  })

  test('work that still does not pass on the retry goes with its worktree, and the ticket is blocked', async ($, on) => {
    const repo = answerRepo(on, { files: checkout(), exits: { 'npm test': 1 } })

    await ship($, 'resume')
    await ends($, repo, 'agent-1')
    await ends($, repo, 'agent-2')

    expect(repo.ran).toContain(`git worktree remove --force ${TREE}`)
    expect(repo.statusOf(CART)).toBe('blocked')
    expect(repo.record('checkout').failures).toEqual({ '01': { reason: '`npm test` failed', output: 'expected 2 but got 3' } })
  })

  test('an attempt with nothing to keep is discarded, and the retry builds anew', async ($, on) => {
    const repo = answerRepo(on, { files: checkout() })

    await ship($, 'resume')
    await ends($, repo, 'agent-1', { reason: 'aborted' })

    expect(repo.ran[0]).toBe(`git worktree remove --force ${TREE}`)
    expect(repo.ran).toContain(`git worktree add -B checkout-feature--01 ${TREE} checkout-feature`)
    expect(repo.spawned[1]?.prompt).toContain("A first attempt at this ticket was discarded: the implementer's turn ended with aborted. Nothing of it is left in your worktree.")
    expect(repo.logged[0]).toMatch(/and its changes were discarded: it is tried once more; building 01/)
  })

  test('a retry that passes is committed like any other, and the run goes on', async ($, on) => {
    const repo = answerRepo(on, { files: checkout(), exits: { 'npm test': 1 } })

    await ship($, 'resume')
    await ends($, repo, 'agent-1')
    repo.exits['npm test'] = 0
    await ends($, repo, 'agent-2')

    expect(repo.statusOf(CART)).toBe('done')
    expect(repo.statusOf(PAY)).toBe('in-progress')
  })

  test('a second failure blocks the ticket and those that hang off it, and the run goes on with the rest', async ($, on) => {
    const repo = answerRepo(on, { files: withTax(), exits: { 'npm test': 1 } })

    await ship($, 'resume')
    await ends($, repo, 'agent-1')
    await ends($, repo, 'agent-2')

    expect(repo.statusOf(CART)).toBe('blocked')
    expect(repo.statusOf(PAY)).toBe('blocked')
    expect(repo.statusOf(TAX)).toBe('in-progress')
    expect(repo.spawned.map(agent => agent.description)).toEqual(['Build ticket 01', 'Build ticket 01', 'Build ticket 03'])
    expect(repo.record('checkout')).toMatchObject({ flights: [{ ticket: 3 }], failures: { '01': { reason: '`npm test` failed' } } })
    expect(repo.logged[1]).toBe(
      'checkout: 01 A cart holds items failed again (`npm test` failed) and is marked blocked; building 03 Tax is added on sonnet.',
    )
  })

  test('the run ends on what could not be built, and says how to go on', async ($, on) => {
    const repo = answerRepo(on, { files: checkout(), exits: { 'npm test': 1 } })

    await ship($, 'resume')
    await ends($, repo, 'agent-1')
    await ends($, repo, 'agent-2')

    expect(repo.logged[1]).toBe(
      'checkout: 01 A cart holds items failed again (`npm test` failed) and is marked blocked; no ticket left to take: 0 of 2 done, 2 blocked; nothing was built: there is no pull request to open.',
    )
    expect(repo.record('checkout')).toMatchObject({
      phase: 'paused',
      pause: 'nothing was built: there is no pull request to open',
      reasons: { '01': '`npm test` failed' },
    })
  })

  test('a ticket the person set back to ready gets both its attempts again', async ($, on) => {
    const repo = answerRepo(on, { files: checkout(), exits: { 'npm test': 1 } })

    await ship($, 'resume')
    await ends($, repo, 'agent-1')
    await ends($, repo, 'agent-2')
    repo.files[CART] = ticket('01', 'A cart holds items', ['**Blocked by:** None', '**Status:** ready'])
    repo.files[PAY] = ticket('02', 'A cart is paid', ['**Blocked by:** 01', '**Status:** ready'])
    repo.change('')
    await ship($, 'resume')

    expect(repo.record('checkout')).toMatchObject({ flights: [{ ticket: 1, agentId: 'agent-3' }], attempts: { '01': 1 } })
    expect(repo.record('checkout').failures).toBeUndefined()
  })

  test('an implementer that changed nothing, or whose turn was cut short, has not built the ticket', async ($, on) => {
    const repo = answerRepo(on, { files: checkout() })

    await ship($, 'resume')
    await ends($, repo, 'agent-1', { changes: '' })

    expect(repo.record('checkout')).toMatchObject({ failures: { '01': { reason: 'the implementer changed nothing' } } })

    await ends($, repo, 'agent-2', { reason: 'aborted' })

    expect(repo.ran[0]).toBe(`git worktree remove --force ${TREE}`)
    expect(repo.statusOf(CART)).toBe('blocked')
    expect(repo.record('checkout')).toMatchObject({ failures: { '01': { reason: "the implementer's turn ended with aborted" } } })
  })

  test('the end of any other agent\'s turn changes nothing', async ($, on) => {
    const repo = answerRepo(on, { files: checkout() })

    await ship($, 'resume')
    await ends($, repo, 'someone-else')

    expect(repo.ran).toEqual([])
    expect(repo.statusOf(CART)).toBe('in-progress')
    expect(repo.logged).toEqual([])
  })

  test('/ship status says what the run is building, and which attempt a ticket is on', async ($, on) => {
    const repo = answerRepo(on, { files: checkout(), exits: { 'npm test': 1 } })

    await ship($, 'resume')
    await ends($, repo, 'agent-1')

    expect((await ship($, 'status')).split('\n')).toEqual([
      'checkout: 0 of 2 tickets done, 0 takeable now · building 01',
      '  01  in-progress  A cart holds items  attempt 2 · failed: `npm test` failed',
      '  02  ready        A cart is paid      blocked by 01',
      '  Blast radius (an estimate): not declared',
    ])

    await ends($, repo, 'agent-2')

    expect((await ship($, 'status')).split('\n')[0]).toBe(
      'checkout: 0 of 2 tickets done, 0 takeable now · paused: nothing was built: there is no pull request to open',
    )
  })
})

// Three tickets that hang off nothing: 01 and 02 declare files apart from each other's, 03 a file under 01's folder
const apart = () => ({
  '.scratch/checkout/spec.md': spec(['npm test']),
  [CART]: ticket('01', 'A cart holds items', ['**Blocked by:** None', '**Status:** ready', '**Touches:** src/cart/']),
  [PAY]: ticket('02', 'A cart is paid', ['**Blocked by:** None', '**Status:** ready', '**Touches:** src/pay.ts']),
  [TAX]: ticket('03', 'Tax is added', ['**Blocked by:** None', '**Status:** ready', '**Touches:** src/cart/tax.ts']),
})

describe('tickets that can be built side by side', () => {
  test('are started together, each in its own worktree, when what they touch does not overlap', async ($, on) => {
    const repo = answerRepo(on, { files: apart() })

    expect(await ship($, 'resume')).toBe('checkout: building 01 A cart holds items on sonnet; building 02 A cart is paid on sonnet.')
    expect(repo.spawned.map(agent => agent.cwd)).toEqual([TREE, '/home/dev/repo/.scratch/checkout/trees/02'])
    expect(repo.statusOf(CART)).toBe('in-progress')
    expect(repo.statusOf(PAY)).toBe('in-progress')
    // 03 touches a file under 01's folder: it waits for 01
    expect(repo.statusOf(TAX)).toBe('ready')
    expect(repo.record('checkout')).toMatchObject({
      flights: [
        { ticket: 1, agentId: 'agent-1', branch: 'checkout-feature--01' },
        { ticket: 2, agentId: 'agent-2', branch: 'checkout-feature--02' },
      ],
      attempts: { '01': 1, '02': 1 },
    })
  })

  test('the end of one takes the ticket it made room for, while the other goes on', async ($, on) => {
    const repo = answerRepo(on, { files: apart() })

    await ship($, 'resume')
    await ends($, repo, 'agent-1')

    expect(repo.logged).toEqual(['checkout: 01 A cart holds items is done (abc1234); building 03 Tax is added on sonnet.'])
    expect(repo.statusOf(PAY)).toBe('in-progress')
    expect(repo.record('checkout')).toMatchObject({ flights: [{ ticket: 2, agentId: 'agent-2' }, { ticket: 3, agentId: 'agent-3' }] })
  })

  test('the building ends only when the last of them has ended', async ($, on) => {
    const repo = answerRepo(on, {
      files: { ...apart(), [TAX]: ticket('03', 'Tax is added', ['**Blocked by:** None', '**Status:** done']) },
    })

    await ship($, 'resume')
    await ends($, repo, 'agent-1')

    expect(repo.logged).toEqual(['checkout: 01 A cart holds items is done (abc1234); 02 still being built.'])
    expect(repo.record('checkout')).toMatchObject({ phase: 'unattended' })

    await ends($, repo, 'agent-2')

    expect(repo.logged[1]).toBe('checkout: 02 A cart is paid is done (abc1235); no ticket left to take: 3 of 3 done; reviewing the branch on opus.')
  })

  test('a commit that finds the run\'s branch moved is brought up to it and verified again before it lands', async ($, on) => {
    const repo = answerRepo(on, { files: apart() })

    await ship($, 'resume')
    await ends($, repo, 'agent-1')
    repo.landing.isBehind = true
    await ends($, repo, 'agent-2')

    expect(repo.ran.filter(line => line.startsWith('02> '))).toEqual([
      '02> sh -c npm test',
      '02> git status --porcelain',
      '02> git add -A',
      '02> git commit -m checkout: A cart is paid',
      '02> git diff --name-only HEAD~1 HEAD',
      '02> git rebase checkout-feature',
      '02> sh -c npm test',
      '02> git rev-parse --short HEAD',
    ])
    expect(repo.ran.indexOf('02> git rebase checkout-feature')).toBeLessThan(repo.ran.indexOf('git merge --ff-only checkout-feature--02'))
    expect(repo.statusOf(PAY)).toBe('done')
  })

  test('a commit that conflicts with what landed beside it is built anew on the branch as it is, at no cost to the ticket\'s attempts', async ($, on) => {
    const repo = answerRepo(on, { files: apart() })

    await ship($, 'resume')
    await ends($, repo, 'agent-1')
    repo.landing.isBehind = true
    repo.landing.conflicts = true
    await ends($, repo, 'agent-2')

    expect(repo.ran).toContain('02> git rebase --abort')
    expect(repo.ran).not.toContain('git merge --ff-only checkout-feature--02')
    expect(repo.ran).toContain('git worktree remove --force /home/dev/repo/.scratch/checkout/trees/02')
    expect(repo.statusOf(PAY)).toBe('in-progress')
    // The work was sound where it was built: what failed is the estimate that let the two go side by side
    expect(repo.record('checkout')).toMatchObject({
      attempts: { '02': 1 },
      landings: { '02': 1 },
      failures: { '02': { reason: 'its changes conflict with those of a ticket built beside it' } },
    })
    expect(repo.logged.at(-1)).toMatch(/02 A cart is paid could not land \(its changes conflict with those of a ticket built beside it\): it is built anew/)
    expect(repo.spawned.at(-1)?.prompt).toMatch(/discarded: its changes conflict with those of a ticket built beside it/)
  })

  test('a ticket that keeps failing to land is charged its attempts in the end, and is blocked', async ($, on) => {
    const repo = answerRepo(on, { files: apart() })

    await ship($, 'resume')
    await ends($, repo, 'agent-1')
    repo.landing.conflicts = true

    // 02 is built four times: twice at no cost, then its two attempts
    for (const agentId of ['agent-2', 'agent-4', 'agent-5', 'agent-6']) {
      repo.landing.isBehind = true
      await ends($, repo, agentId)
    }

    expect(repo.statusOf(PAY)).toBe('blocked')
    expect(repo.record('checkout')).toMatchObject({ landings: { '02': 2 }, reasons: { '02': 'its changes conflict with those of a ticket built beside it' } })
  })

  test('one that fails is tried again without holding the others back', async ($, on) => {
    const repo = answerRepo(on, { files: apart(), exits: { 'npm test': 1 } })

    await ship($, 'resume')
    await ends($, repo, 'agent-1')

    expect(repo.statusOf(CART)).toBe('in-progress')
    expect(repo.statusOf(PAY)).toBe('in-progress')
    expect(repo.record('checkout')).toMatchObject({ flights: [{ ticket: 2, agentId: 'agent-2' }, { ticket: 1, agentId: 'agent-3' }] })
  })

  test('/ship resume and /ship status name every ticket being built', async ($, on) => {
    answerRepo(on, { files: apart() })

    await ship($, 'resume')

    expect(await ship($, 'resume')).toBe('checkout: tickets 01, 02 are being built now.')
    expect((await ship($, 'status')).split('\n')[0]).toBe('checkout: 0 of 3 tickets done, 1 takeable now · building 01, 02')
  })

  test('a quota window nearly spent starts no other ticket, and the run pauses once those being built have ended', async ($, on) => {
    const repo = answerRepo(on, { files: apart(), quota: { short: 60, weekly: 30 } })

    await ship($, 'resume')
    repo.quota.short = 92
    await ends($, repo, 'agent-1')

    expect(repo.logged[0]).toMatch(/^checkout: 01 A cart holds items is done \(abc1234\); the 5-hour quota window is at 92%.*, so no ticket is started; 02 still being built\.$/)
    expect(repo.record('checkout')).toMatchObject({ phase: 'unattended', flights: [{ ticket: 2 }] })
    expect(repo.statusOf(TAX)).toBe('ready')

    await ends($, repo, 'agent-2')

    expect(repo.record('checkout')).toMatchObject({ phase: 'paused' })
    expect(repo.spawned).toHaveLength(2)
  })

  test('are never more at once than the setting allows', { options: { parallelTickets: 1 } }, async ($, on) => {
    const repo = answerRepo(on, { files: apart() })

    expect(await ship($, 'resume')).toBe('checkout: building 01 A cart holds items on sonnet.')
    expect(repo.statusOf(PAY)).toBe('ready')
    expect(repo.spawned).toHaveLength(1)
  })

  test('a ticket that declares no files is built alone: it may touch anything', async ($, on) => {
    const repo = answerRepo(on, { files: withTax() })

    await ship($, 'resume')

    expect(repo.spawned.map(agent => agent.description)).toEqual(['Build ticket 01'])
    expect(repo.statusOf(TAX)).toBe('ready')
  })
})

describe('what the implementer may call', () => {
  test('its file tools, the git commands that read and stage, and the verification commands as written', async ($, on) => {
    answerRepo(on, { files: checkout() })
    await ship($, 'resume')

    expect(await checks($, 'agent-1', 'Edit', { file_path: 'src/cart.ts' })).toBe('allow')
    expect(await checks($, 'agent-1', 'Bash', { command: 'git diff --stat' })).toBe('allow')
    expect(await checks($, 'agent-1', 'Bash', { command: 'npm run typecheck' })).toBe('allow')
  })

  test('the hand-back of its report is left to the session: the run neither allows nor refuses it', async ($, on) => {
    answerRepo(on, { files: checkout() })
    await ship($, 'resume')

    // The session's own answer, which the test engine gives as `ask`
    expect(await checks($, 'agent-1', 'SubagentHandback', {})).toBe('ask')
  })

  test('no other command: it is refused, never asked', async ($, on) => {
    answerRepo(on, { files: checkout() })

    await ship($, 'resume')

    expect(await checks($, 'agent-1', 'Bash', { command: 'npm install left-pad' })).toBe('deny')
    expect(await checks($, 'agent-1', 'Bash', { command: 'git status && curl example.com' })).toBe('deny')
    expect(await checks($, 'agent-1', 'Bash', { command: 'git push' })).toBe('deny')
    expect(await checks($, 'agent-1', 'WebFetch', { url: 'https://example.com' })).toBe('deny')
  })

  test('a refused command does not fail the attempt: the work is verified and committed as any', async ($, on) => {
    const repo = answerRepo(on, { files: checkout() })

    await ship($, 'resume')
    await checks($, 'agent-1', 'Bash', { command: 'git -C /repo status --short; git -C /repo ls-files src' })
    await ends($, repo, 'agent-1')

    expect(repo.statusOf(CART)).toBe('done')
    expect(repo.record('checkout').failures).toBeUndefined()
  })

  test('it writes in its own worktree and its ticket file, and nowhere else: other tickets are built beside it', async ($, on) => {
    answerRepo(on, { files: checkout() })
    await ship($, 'resume')

    expect(await checks($, 'agent-1', 'Edit', { file_path: `${TREE}/src/cart.ts` })).toBe('allow')
    expect(await checks($, 'agent-1', 'Write', { file_path: '\\home\\dev\\repo\\.scratch\\checkout\\trees\\01\\src\\new.ts' })).toBe('allow')
    expect(await checks($, 'agent-1', 'Edit', { file_path: `/home/dev/repo/${CART}` })).toBe('allow')
    expect(await checks($, 'agent-1', 'Edit', { file_path: '/home/dev/repo/src/cart.ts' })).toBe('deny')
    expect(await checks($, 'agent-1', 'Write', { file_path: '/home/dev/repo/.scratch/checkout/trees/02/src/pay.ts' })).toBe('deny')
    expect(await checks($, 'agent-1', 'Edit', { file_path: `/home/dev/repo/${PAY}` })).toBe('deny')
    expect(await checks($, 'agent-1', 'Edit', { file_path: '../../../../src/cart.ts' })).toBe('deny')
    expect(await checks($, 'agent-1', 'Read', { file_path: '/home/dev/repo/src/cart.ts' })).toBe('allow')
  })

  test('a command the session\'s sandbox has put its proxy in front of is judged as the implementer wrote it', async ($, on) => {
    answerRepo(on, { files: checkout() })
    await ship($, 'resume')

    expect(await checks($, 'agent-1', 'Bash', { command: `${SANDBOXED}git rm -f tests/old.test.ts` })).toBe('allow')
    expect(await checks($, 'agent-1', 'Bash', { command: `${SANDBOXED}git push` })).toBe('deny')
  })

  test('another agent\'s calls are left to the session to decide', async ($, on) => {
    answerRepo(on, { files: checkout() })
    await ship($, 'resume')

    expect(await checks($, 'someone-else', 'Bash', { command: 'npm install left-pad' })).toBe('ask')
  })
})
