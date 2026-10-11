import { describe, expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { answerRepo, spec, ticket } from './repo'

type Engine = Parameters<TestBody>[0]

const CART = '.scratch/checkout/issues/01-cart.md'
const PAY = '.scratch/checkout/issues/02-pay.md'

const checkout = (commands: readonly string[] = ['npm test', 'npm run typecheck']) => ({
  '.scratch/checkout/spec.md': spec(commands),
  [CART]: ticket('01', 'A cart holds items', ['**Blocked by:** None', '**Status:** ready']),
  [PAY]: ticket('02', 'A cart is paid', ['**Blocked by:** 01', '**Status:** ready']),
})

const ship = async ($: Engine, args: string) => (await $.command.run({ command: 'ship', args } as never)).text ?? ''

const ends = ($: Engine, agentId: string, reason = 'answer') =>
  $.turn.complete({ answer: 'Built.', durationMs: 1, isAborted: reason === 'aborted', turnId: 't1', agentId, reason } as never)

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

  test('refuses to start on uncommitted changes, which a failed ticket would discard', async ($, on) => {
    const repo = answerRepo(on, { files: checkout(), porcelain: ' M src/cart.ts\n' })

    expect(await ship($, 'resume')).toMatch(/uncommitted changes/)
    expect(repo.spawned).toEqual([])
    expect(repo.statusOf(CART)).toBe('ready')
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

    expect(await ship($, 'resume')).toBe('checkout: building 01 A cart holds items on sonnet, on branch checkout-feature.')
    expect(repo.spawned).toEqual([
      {
        subagentType: 'ship-flow:implementer',
        description: 'Build ticket 01',
        model: 'sonnet',
        prompt: 'Build the ticket .scratch/checkout/issues/01-cart.md of the spec .scratch/checkout/spec.md.',
      },
    ])
    expect(repo.statusOf(CART)).toBe('in-progress')
    expect(repo.statusOf(PAY)).toBe('ready')
  })

  test('records the run: its feature, branch, phase, ticket, agent, attempt and the usage it read', async ($, on) => {
    const repo = answerRepo(on, { files: checkout() })

    await ship($, 'resume')

    expect(repo.record('checkout')).toEqual({
      feature: 'checkout',
      branch: 'checkout-feature',
      phase: 'unattended',
      ticket: 1,
      agentId: 'agent-1',
      attempts: { '01': 1 },
      usage: {
        at: 1000,
        contextPercent: 12,
        quota: [{ kind: 'five_hour', percentUsed: 40, resetsAt: '2026-10-11T20:00:00.000Z' }],
      },
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

  test('says so when no ticket can be taken', async ($, on) => {
    answerRepo(on, {
      files: {
        ...checkout(),
        [CART]: ticket('01', 'A cart holds items', ['**Blocked by:** None', '**Status:** blocked']),
      },
    })

    expect(await ship($, 'resume')).toMatch(/no ticket can be taken now/)
  })
})

describe('when the implementer has finished', () => {
  test('the run runs each verification command itself, commits once and marks the ticket done', async ($, on) => {
    const repo = answerRepo(on, { files: checkout() })

    await ship($, 'resume')
    repo.change(' M src/cart.ts\n')
    repo.ran.length = 0
    await ends($, 'agent-1')

    expect(repo.ran).toEqual([
      'sh -c npm test',
      'sh -c npm run typecheck',
      'git status --porcelain',
      'git add -A',
      'git commit -m checkout: A cart holds items',
      'git rev-parse --short HEAD',
    ])
    expect(repo.statusOf(CART)).toBe('done')
    expect(repo.record('checkout')).toMatchObject({ phase: 'paused', attempts: { '01': 1 } })
    expect(repo.record('checkout').agentId).toBeUndefined()
  })

  test('the transcript gets exactly one line for the ticket', async ($, on) => {
    const repo = answerRepo(on, { files: checkout() })

    await ship($, 'resume')
    repo.change(' M src/cart.ts\n')
    await ends($, 'agent-1')

    expect(repo.logged).toEqual(['ship-flow: 01 A cart holds items is done (abc1234).'])
  })

  test('a failing verification command discards the work, blocks the ticket and keeps what the command said', async ($, on) => {
    const repo = answerRepo(on, { files: checkout(), exits: { 'npm run typecheck': 2 } })

    await ship($, 'resume')
    repo.change(' M src/cart.ts\n')
    repo.ran.length = 0
    await ends($, 'agent-1')

    expect(repo.ran).toEqual(['sh -c npm test', 'sh -c npm run typecheck', 'git reset --hard HEAD', 'git clean -fd'])
    expect(repo.statusOf(CART)).toBe('blocked')
    expect(repo.record('checkout')).toMatchObject({
      phase: 'paused',
      failure: { ticket: 1, reason: '`npm run typecheck` failed', output: 'expected 2 but got 3' },
    })
    expect(repo.logged).toEqual([
      'ship-flow: 01 A cart holds items failed: `npm run typecheck` failed. Its changes were discarded and it is marked blocked.',
    ])
  })

  test('an implementer that changed nothing has not built the ticket', async ($, on) => {
    const repo = answerRepo(on, { files: checkout() })

    await ship($, 'resume')
    await ends($, 'agent-1')

    expect(repo.statusOf(CART)).toBe('blocked')
    expect(repo.record('checkout')).toMatchObject({ failure: { reason: 'the implementer changed nothing' } })
  })

  test('a turn that was interrupted is a failure, and nothing is verified or committed', async ($, on) => {
    const repo = answerRepo(on, { files: checkout() })

    await ship($, 'resume')
    repo.change(' M src/cart.ts\n')
    repo.ran.length = 0
    await ends($, 'agent-1', 'aborted')

    expect(repo.ran).toEqual(['git reset --hard HEAD', 'git clean -fd'])
    expect(repo.statusOf(CART)).toBe('blocked')
  })

  test('the end of any other agent\'s turn changes nothing', async ($, on) => {
    const repo = answerRepo(on, { files: checkout() })

    await ship($, 'resume')
    repo.ran.length = 0
    await ends($, 'someone-else')

    expect(repo.ran).toEqual([])
    expect(repo.statusOf(CART)).toBe('in-progress')
    expect(repo.logged).toEqual([])
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

  test('no other command: it is refused, never asked, and the ticket has failed', async ($, on) => {
    const repo = answerRepo(on, { files: checkout() })

    await ship($, 'resume')

    expect(await checks($, 'agent-1', 'Bash', { command: 'npm install left-pad' })).toBe('deny')
    expect(await checks($, 'agent-1', 'Bash', { command: 'git status && curl example.com' })).toBe('deny')
    expect(await checks($, 'agent-1', 'Bash', { command: 'git push' })).toBe('deny')
    expect(await checks($, 'agent-1', 'WebFetch', { url: 'https://example.com' })).toBe('deny')

    repo.change(' M src/cart.ts\n')
    repo.ran.length = 0
    await ends($, 'agent-1')

    expect(repo.ran).toEqual(['git reset --hard HEAD', 'git clean -fd'])
    expect(repo.record('checkout')).toMatchObject({
      failure: { reason: 'the implementer tried a command it may not run: git push' },
    })
  })

  test('another agent\'s calls are left to the session to decide', async ($, on) => {
    answerRepo(on, { files: checkout() })
    await ship($, 'resume')

    expect(await checks($, 'someone-else', 'Bash', { command: 'npm install left-pad' })).toBe('ask')
  })
})
