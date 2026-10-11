import { describe, expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { answerRepo, spec, ticket } from './repo'

type Engine = Parameters<TestBody>[0]
type Repo = ReturnType<typeof answerRepo>

const CART = '.scratch/checkout/issues/01-cart.md'
const PAY = '.scratch/checkout/issues/02-pay.md'

const NOW = Date.parse('2026-10-11T20:00:00.000Z')
const RESET = '2026-10-11T22:10:00.000Z'
// A minute past the reset, when the run looks again
const WAIT_MS = Date.parse('2026-10-11T22:11:00.000Z') - NOW

const files = () => ({
  '.scratch/checkout/spec.md': spec(['npm test']),
  [CART]: ticket('01', 'A cart holds items', ['**Blocked by:** None', '**Status:** ready']),
  [PAY]: ticket('02', 'A cart is paid', ['**Blocked by:** 01', '**Status:** ready']),
})

const repoAt = (on: Parameters<TestBody>[1], short: number, weekly = 30) =>
  answerRepo(on, { files: files(), now: NOW, quota: { short, weekly, resetsAt: RESET } })

const ship = async ($: Engine, args: string) => (await $.command.run({ command: 'ship', args } as never)).text ?? ''

const ends = async ($: Engine, repo: Repo, agentId: string) => {
  repo.change(' M src/cart.ts\n')
  await $.turn.complete({ answer: 'Built.', durationMs: 1, isAborted: false, turnId: 't1', agentId, reason: 'answer' } as never)
}

describe('a run near the end of the 5-hour quota window', () => {
  test('finishes the ticket in flight, then starts no other: it pauses and says when it goes on', async ($, on) => {
    const repo = repoAt(on, 60)

    await ship($, 'resume')
    repo.quota.short = 92
    await ends($, repo, 'agent-1')

    expect(repo.statusOf(CART)).toBe('done')
    expect(repo.statusOf(PAY)).toBe('ready')
    expect(repo.spawned).toHaveLength(1)
    expect(repo.logged).toEqual([
      'checkout: 01 A cart holds items is done (abc1234); paused: the 5-hour quota window is at 92%: the run goes on by itself at 22:11 UTC.',
    ])
    expect(repo.record('checkout')).toMatchObject({
      phase: 'paused',
      pause: 'the 5-hour quota window is at 92%: the run goes on by itself at 22:11 UTC',
      resumeAt: NOW + WAIT_MS,
    })
  })

  test('sends one desktop notification, and /ship status says why it is paused and until when', async ($, on) => {
    const repo = repoAt(on, 60)

    await ship($, 'resume')
    repo.quota.short = 92
    await ends($, repo, 'agent-1')

    expect(repo.notified).toEqual(['checkout is paused: the 5-hour quota window is at 92%: the run goes on by itself at 22:11 UTC.'])
    expect((await ship($, 'status')).split('\n')[0]).toBe(
      'checkout: 1 of 2 tickets done, 1 takeable now · paused: the 5-hour quota window is at 92%: the run goes on by itself at 22:11 UTC',
    )
  })

  test('goes on by itself once the window has reset, with no input', async ($, on) => {
    const repo = repoAt(on, 60)

    await ship($, 'resume')
    repo.quota.short = 92
    await ends($, repo, 'agent-1')
    await repo.clock.advance(WAIT_MS - 1)

    expect(repo.spawned).toHaveLength(1)

    repo.quota.short = 3
    await repo.clock.advance(1)

    expect(repo.spawned.map(agent => agent.description)).toEqual(['Build ticket 01', 'Build ticket 02'])
    expect(repo.statusOf(PAY)).toBe('in-progress')
    expect(repo.logged[1]).toBe(
      'checkout: the quota window has reset; building 02 A cart is paid on sonnet, on branch checkout-feature.',
    )
    expect(repo.record('checkout').resumeAt).toBeUndefined()
  })

  test('pauses again when the window is still over its threshold as it looks again', async ($, on) => {
    const repo = repoAt(on, 60)

    await ship($, 'resume')
    repo.quota.short = 92
    await ends($, repo, 'agent-1')
    repo.quota.resetsAt = '2026-10-12T03:10:00.000Z'
    await repo.clock.advance(WAIT_MS)

    expect(repo.spawned).toHaveLength(1)
    expect(repo.record('checkout')).toMatchObject({ phase: 'paused', resumeAt: Date.parse('2026-10-12T03:11:00.000Z') })
  })

  test('is not started a second time by its timer when the person resumed it meanwhile', async ($, on) => {
    const repo = repoAt(on, 60)

    await ship($, 'resume')
    repo.quota.short = 92
    await ends($, repo, 'agent-1')
    repo.quota.short = 3
    await ship($, 'resume')
    await repo.clock.advance(WAIT_MS)

    expect(repo.spawned.map(agent => agent.description)).toEqual(['Build ticket 01', 'Build ticket 02'])
  })

  test('does not start its first ticket either: /ship resume pauses it', async ($, on) => {
    const repo = repoAt(on, 95)

    expect(await ship($, 'resume')).toBe(
      'checkout: paused: the 5-hour quota window is at 95%: the run goes on by itself at 22:11 UTC.',
    )
    expect(repo.spawned).toEqual([])
    expect(repo.statusOf(CART)).toBe('ready')
  })

  test('holds a retry too, and the implementer that takes it later is still told what failed', async ($, on) => {
    const repo = answerRepo(on, { files: files(), now: NOW, quota: { short: 60, weekly: 30, resetsAt: RESET }, exits: { 'npm test': 1 } })

    await ship($, 'resume')
    repo.quota.short = 92
    await ends($, repo, 'agent-1')

    expect(repo.statusOf(CART)).toBe('ready')
    expect(repo.spawned).toHaveLength(1)

    repo.quota.short = 3
    await repo.clock.advance(WAIT_MS)

    expect(repo.spawned[1]?.prompt).toMatch(/A first attempt at this ticket was discarded: `npm test` failed/)
    expect(repo.record('checkout')).toMatchObject({ ticket: 1, attempts: { '01': 2 } })
  })
})

describe('a run near the end of the weekly quota window', () => {
  test('stops building and does not wait: it goes on to its end with what it has', async ($, on) => {
    const repo = repoAt(on, 20, 50)

    await ship($, 'resume')
    repo.quota.weekly = 93
    await ends($, repo, 'agent-1')
    await repo.clock.advance(7 * 24 * 60 * 60 * 1000)

    expect(repo.statusOf(PAY)).toBe('ready')
    expect(repo.spawned.map(agent => agent.description)).toEqual(['Build ticket 01', 'Review checkout'])
    expect(repo.logged).toEqual([
      'checkout: 01 A cart holds items is done (abc1234); the weekly quota window is at 93%, so the building stops: 1 of 2 done; reviewing the branch on opus.',
    ])
    expect(repo.record('checkout')).toMatchObject({ phase: 'finishing', stage: 'review' })
    expect(repo.record('checkout').resumeAt).toBeUndefined()
  })
})

describe('the mod\'s settings', () => {
  test(
    'set the model tickets are built on and the threshold the run pauses at',
    { options: { implementerModel: 'haiku', shortWindowPercent: 50 } },
    async ($, on) => {
      const repo = repoAt(on, 20)

      expect(await ship($, 'resume')).toMatch(/building 01 A cart holds items on haiku/)

      repo.quota.short = 55
      await ends($, repo, 'agent-1')

      expect(repo.record('checkout')).toMatchObject({ phase: 'paused' })
      expect(repo.spawned).toHaveLength(1)
    },
  )

  test('leave a ticket that names its own model on that model', { options: { implementerModel: 'haiku' } }, async ($, on) => {
    const repo = answerRepo(on, {
      files: { ...files(), [CART]: ticket('01', 'A cart holds items', ['**Blocked by:** None', '**Status:** ready', '**Model:** opus']) },
    })

    await ship($, 'resume')
    await ends($, repo, 'agent-1')

    expect(repo.spawned.map(agent => agent.model)).toEqual(['opus', 'haiku'])
  })
})
