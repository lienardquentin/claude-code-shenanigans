import { describe, expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { answerRepo, spec, ticket } from './repo'

type Engine = Parameters<TestBody>[0]
type Repo = ReturnType<typeof answerRepo>

const CART = '.scratch/checkout/issues/01-cart.md'
const PAY = '.scratch/checkout/issues/02-pay.md'
const TAX = '.scratch/checkout/issues/03-tax.md'
const RECORD = '.scratch/checkout/run.json'
const TREE = '/home/dev/repo/.scratch/checkout/trees/01'

const checkout = () => ({
  '.scratch/checkout/spec.md': spec(['npm test']),
  [CART]: ticket('01', 'A cart holds items', ['**Blocked by:** None', '**Status:** ready']),
  [PAY]: ticket('02', 'A cart is paid', ['**Blocked by:** 01', '**Status:** ready']),
})

const ship = async ($: Engine, args: string) => (await $.command.run({ command: 'ship', args } as never)).text ?? ''

const ends = async ($: Engine, repo: Repo, agentId: string, { reason = 'answer', changes = ' M src/cart.ts\n' } = {}) => {
  repo.change(changes)
  repo.ran.length = 0
  await $.turn.complete({ answer: 'Built.', durationMs: 1, isAborted: reason === 'aborted', turnId: 't1', agentId, reason } as never)
}

const checks = async ($: Engine, agentId: string, tool: string, input: unknown) =>
  (await $.tool.check({ tool, input, agentId, tool_use_id: 'call-1' } as never)).decision

describe('/ship with a word that is no command', () => {
  test('starts no run from one bare word, and says what the commands are', async ($, on) => {
    const repo = answerRepo(on, { files: {} })
    const said = await ship($, 'resum')

    expect(said.split('\n')[0]).toBe('`/ship resum` is no command of ship-flow, and one word is no idea to start a run from.')
    expect(said).toContain('/ship resume [feature]')
    expect(repo.prompts).toEqual([])
    expect(Object.keys(repo.files)).toEqual([])
  })

  test('answers /ship help with the commands, and starts no run named help', async ($, on) => {
    const repo = answerRepo(on, { files: {} })

    expect(await ship($, 'help')).toMatch(/^Usage:/)
    expect(Object.keys(repo.files)).toEqual([])
  })
})

describe('/ship stop', () => {
  test('stops a run that is building: its ticket is ready again, its worktree goes, and the run waits for the person', async ($, on) => {
    const repo = answerRepo(on, { files: checkout() })

    await ship($, 'resume')

    expect(await ship($, 'stop')).toBe(
      'checkout: stopped. Its agent at work is refused whatever it calls next, and what it had not finished is discarded. /ship resume checkout takes it up again.',
    )
    expect(repo.statusOf(CART)).toBe('ready')
    expect(repo.ran).toContain(`git worktree remove --force ${TREE}`)
    expect(repo.record('checkout')).toMatchObject({ phase: 'paused', pause: 'stopped by you', halted: ['agent-1'] })
    expect(repo.record('checkout').flights).toBeUndefined()
  })

  test('refuses whatever a stopped agent calls next, its hand-back apart, and judges none of its work', async ($, on) => {
    const repo = answerRepo(on, { files: checkout() })

    await ship($, 'resume')
    await ship($, 'stop')

    expect(await checks($, 'agent-1', 'Read', { file_path: 'src/cart.ts' })).toBe('deny')
    expect(await checks($, 'agent-1', 'Bash', { command: 'npm test' })).toBe('deny')
    // Not the run's to decide: the session's own answer stands, which the test engine gives as `ask`
    expect(await checks($, 'agent-1', 'SubagentHandback', {})).toBe('ask')

    await ends($, repo, 'agent-1')

    expect(repo.ran).toEqual([])
    expect(repo.statusOf(CART)).toBe('ready')
    expect(repo.record('checkout').halted).toBeUndefined()
    expect(repo.logged).toEqual([])
  })

  test('is undone by /ship resume, which builds the ticket anew', async ($, on) => {
    const repo = answerRepo(on, { files: checkout() })

    await ship($, 'resume')
    await ship($, 'stop')

    expect(await ship($, 'resume')).toBe('checkout: building 01 A cart holds items on sonnet.')
    expect(repo.record('checkout')).toMatchObject({ phase: 'unattended', flights: [{ ticket: 1, agentId: 'agent-2' }] })
  })

  test('stops a run that waits on the quota: its timer finds nothing to take up', async ($, on) => {
    const repo = answerRepo(on, { files: checkout(), now: Date.parse('2026-10-11T20:00:00.000Z'), quota: { short: 95, weekly: 30, resetsAt: '2026-10-11T22:10:00.000Z' } })

    await ship($, 'resume')

    expect(await ship($, 'stop')).toBe('checkout: stopped. /ship resume checkout takes it up again.')

    repo.quota.short = 3
    await repo.clock.advance(24 * 60 * 60 * 1000)

    expect(repo.spawned).toEqual([])
  })

  test('says so when there is nothing to stop', async ($, on) => {
    answerRepo(on, { files: checkout() })

    expect(await ship($, 'stop')).toBe('checkout: is not building: there is nothing to stop.')
  })
})

describe('/ship clean', () => {
  test('wants the run named: nothing it removes can be brought back', async ($, on) => {
    const repo = answerRepo(on, { files: checkout() })

    expect(await ship($, 'clean')).toBe('Name the run to clean: /ship clean <feature>. Here: checkout.')
    expect(await ship($, 'clean search')).toBe('No run named search. Here: checkout.')
    expect(repo.files[CART]).toBeDefined()
  })

  test('removes the run\'s folder, its worktrees and their branches, and leaves the run\'s own branch', async ($, on) => {
    const repo = answerRepo(on, { files: checkout(), exits: { 'npm test': 1 } })

    // The first attempt does not pass: its worktree is kept, then the run is stopped with it
    await ship($, 'resume')
    await ends($, repo, 'agent-1')
    await ship($, 'stop')
    repo.files['.scratch/checkout/trees/01/.git'] = 'gitdir: elsewhere\n'

    expect(await ship($, 'clean checkout')).toBe('checkout: its folder, 1 worktree and its branch are gone. The branch checkout-feature is left as it is.')
    expect(repo.ran).toContain(`git worktree remove --force ${TREE}`)
    expect(repo.ran).toContain('git branch -D checkout-feature--01')
    expect(repo.ran).not.toContain('git branch -D checkout-feature')
    expect(Object.keys(repo.files).filter(file => file.startsWith('.scratch/checkout/'))).toEqual([])
    expect(await ship($, 'status')).toMatch(/^No run in this repo/)
  })

  test('refuses a run that is at work', async ($, on) => {
    const repo = answerRepo(on, { files: checkout() })

    await ship($, 'resume')

    expect(await ship($, 'clean checkout')).toBe('checkout: is at work. /ship stop checkout first.')
    expect(repo.files[CART]).toBeDefined()
  })
})

describe('a ticket blocked only for what it hangs off', () => {
  const withTax = () => ({ ...checkout(), [TAX]: ticket('03', 'Tax is added', ['**Blocked by:** 02', '**Status:** ready']) })

  // 01 fails twice and is blocked; 02 hangs off it and 03 off 02
  const stuck = async ($: Engine, repo: Repo) => {
    await ship($, 'resume')
    await ends($, repo, 'agent-1')
    await ends($, repo, 'agent-2')
  }

  test('is told apart from the one that failed, in the record and in /ship status', async ($, on) => {
    const repo = answerRepo(on, { files: withTax(), exits: { 'npm test': 1 } })

    await stuck($, repo)

    expect(repo.record('checkout')).toMatchObject({ hangs: ['02', '03'] })
    expect((await ship($, 'status')).split('\n').slice(1, 4)).toEqual([
      '  01  blocked  A cart holds items  attempt 2 · failed: `npm test` failed · fix its ticket file, set it back to ready',
      '  02  blocked  A cart is paid      blocked by 01 · waits on a ticket that was not built: ready again at the next /ship resume',
      '  03  blocked  Tax is added        blocked by 02 · waits on a ticket that was not built: ready again at the next /ship resume',
    ])
  })

  test('is ready again by itself once the person set the failed one back to ready: only that one is theirs to edit', async ($, on) => {
    const repo = answerRepo(on, { files: withTax(), exits: { 'npm test': 1 } })

    await stuck($, repo)
    repo.files[CART] = ticket('01', 'A cart holds items', ['**Blocked by:** None', '**Status:** ready'])
    repo.exits['npm test'] = 0
    repo.change('')
    await ship($, 'resume')

    expect(repo.statusOf(PAY)).toBe('ready')
    expect(repo.statusOf(TAX)).toBe('ready')
    expect(repo.record('checkout').hangs).toBeUndefined()

    await ends($, repo, 'agent-3')

    expect(repo.statusOf(CART)).toBe('done')
    expect(repo.statusOf(PAY)).toBe('in-progress')
  })

  test('is blocked again at the next resume while what it hangs off is still not built', async ($, on) => {
    const repo = answerRepo(on, { files: withTax(), exits: { 'npm test': 1 } })

    await stuck($, repo)
    await ship($, 'resume')

    expect(repo.statusOf(CART)).toBe('blocked')
    expect(repo.statusOf(PAY)).toBe('blocked')
    expect(repo.record('checkout')).toMatchObject({ hangs: ['02', '03'] })
  })
})

describe('an agent that is no run\'s', () => {
  test('is found again once a run takes it: what was known of it does not outlive the record\'s next write', async ($, on) => {
    answerRepo(on, { files: checkout() })

    // Asked about before the run exists, the agent is no run's and its call is the session's to decide
    expect(await checks($, 'agent-1', 'Bash', { command: 'npm install left-pad' })).toBe('ask')

    await ship($, 'resume')

    expect(await checks($, 'agent-1', 'Bash', { command: 'npm install left-pad' })).toBe('deny')
    expect(await checks($, 'someone-else', 'Bash', { command: 'npm install left-pad' })).toBe('ask')
  })

  test('costs no reading of the run folders on its later calls, while no record is written', async ($, on) => {
    const repo = answerRepo(on, { files: checkout() })

    await ship($, 'resume')
    await checks($, 'someone-else', 'Read', { file_path: 'a.ts' })
    repo.listed.length = 0
    await checks($, 'someone-else', 'Read', { file_path: 'b.ts' })
    await checks($, 'someone-else', 'Read', { file_path: 'c.ts' })

    expect(repo.listed).toEqual([])
    // The run's own agent is looked for in its run's folder alone
    await checks($, 'agent-1', 'Read', { file_path: 'a.ts' })
    repo.listed.length = 0
    await checks($, 'agent-1', 'Read', { file_path: 'b.ts' })

    expect(repo.listed).toEqual(['.scratch/checkout/issues'])
  })
})

describe('the record of a run paused for quota', () => {
  test('is left alone by a session that starts and finds no run paused', async ($, on) => {
    const repo = answerRepo(on, { files: { ...checkout(), [RECORD]: JSON.stringify({ feature: 'checkout', branch: 'checkout-feature', phase: 'paused', pause: 'stopped by you', attempts: {} }) } })

    await $.session.start({ cwd: '/home/dev/repo' } as never)
    await repo.clock.advance(60 * 60 * 1000)

    expect(repo.spawned).toEqual([])
  })
})
