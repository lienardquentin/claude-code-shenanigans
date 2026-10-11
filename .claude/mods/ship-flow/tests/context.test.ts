import { describe, expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { answerRepo, spec, ticket } from './repo'

type Engine = Parameters<TestBody>[0]
type Repo = ReturnType<typeof answerRepo>

const CART = '.scratch/checkout/issues/01-cart.md'
const PAY = '.scratch/checkout/issues/02-pay.md'
const TAX = '.scratch/checkout/issues/03-tax.md'

const files = () => ({
  '.scratch/checkout/spec.md': spec(['npm test']),
  [CART]: ticket('01', 'A cart holds items', ['**Blocked by:** None', '**Status:** ready']),
  [PAY]: ticket('02', 'A cart is paid', ['**Blocked by:** 01', '**Status:** ready']),
  [TAX]: ticket('03', 'Tax is added', ['**Blocked by:** None', '**Status:** ready']),
})

const ship = async ($: Engine, args: string) => (await $.command.run({ command: 'ship', args } as never)).text ?? ''

// One response of an agent's turn, answered over `tokens` of context
const steps = async ($: Engine, repo: Repo, agentId: string, tokens: number) => {
  repo.step.tokens = tokens

  const response = $.turn.step({ turnId: `turn-of-${agentId}`, index: 0, model: 'claude-sonnet-5-5', messageCount: 4, agentId } as never)

  for await (const _ of response) void _
}

const ends = async ($: Engine, repo: Repo, agentId: string, reason: string) => {
  repo.change(' M src/cart.ts\n')
  repo.ran.length = 0
  await $.turn.complete({
    answer: '',
    durationMs: 1,
    isAborted: reason === 'aborted',
    turnId: `turn-of-${agentId}`,
    agentId,
    reason,
  } as never)
}

describe('an implementer that outgrows its context budget', () => {
  test('works on undisturbed while it is under the budget', async ($, on) => {
    const repo = answerRepo(on, { files: files() })

    await ship($, 'resume')
    await steps($, repo, 'agent-1', 139_000)

    expect(repo.aborted).toEqual([])
    expect(repo.record('checkout').tooLarge).toBeUndefined()
  })

  test('is stopped at the response that passes it, once', async ($, on) => {
    const repo = answerRepo(on, { files: files() })

    await ship($, 'resume')
    await steps($, repo, 'agent-1', 141_000)
    await steps($, repo, 'agent-1', 150_000)

    expect(repo.aborted).toEqual(['turn-of-agent-1'])
    expect(repo.record('checkout')).toMatchObject({ tooLarge: 141_000 })
  })

  test('leaves no commit: its work is discarded and its ticket marked too-large, not tried again', async ($, on) => {
    const repo = answerRepo(on, { files: files() })

    await ship($, 'resume')
    await steps($, repo, 'agent-1', 141_000)
    await ends($, repo, 'agent-1', 'aborted')

    expect(repo.ran.slice(0, 2)).toEqual(['git reset --hard HEAD', 'git clean -fd'])
    expect(repo.ran.some(line => line.startsWith('git commit'))).toBe(false)
    expect(repo.statusOf(CART)).toBe('too-large')
    expect(repo.spawned.filter(agent => agent.description === 'Build ticket 01')).toHaveLength(1)
  })

  test('blocks what hangs off its ticket, and the run goes on with the rest', async ($, on) => {
    const repo = answerRepo(on, { files: files() })

    await ship($, 'resume')
    await steps($, repo, 'agent-1', 141_000)
    await ends($, repo, 'agent-1', 'aborted')

    expect(repo.statusOf(PAY)).toBe('blocked')
    expect(repo.statusOf(TAX)).toBe('in-progress')
    expect(repo.logged).toEqual([
      'checkout: 01 A cart holds items was stopped at 71% of a context window and is marked too-large: split it; building 03 Tax is added on sonnet, on branch checkout-feature.',
    ])
  })

  test('/ship status says the ticket is too large and to split it', async ($, on) => {
    const repo = answerRepo(on, { files: files() })

    await ship($, 'resume')
    await steps($, repo, 'agent-1', 141_000)
    await ends($, repo, 'agent-1', 'aborted')

    expect((await ship($, 'status')).split('\n')[1]).toBe(
      '  01  too-large    A cart holds items  context 71% · too large for one context window: split it into smaller tickets',
    )
  })

  test('the fullest each implementer got is kept, ticket by ticket, for tuning the budget', async ($, on) => {
    const repo = answerRepo(on, { files: files() })

    await ship($, 'resume')
    await steps($, repo, 'agent-1', 30_000)
    await steps($, repo, 'agent-1', 90_000)
    await steps($, repo, 'agent-1', 60_000)
    await ends($, repo, 'agent-1', 'answer')
    await steps($, repo, 'agent-2', 20_000)

    expect(repo.record('checkout').peak).toEqual({ '01': 90_000, '02': 20_000 })
    expect((await ship($, 'status')).split('\n')[1]).toBe('  01  done         A cart holds items  context 45%')
  })

  test('a stop that the turn did not obey is said, not taken for a pass', async ($, on) => {
    const repo = answerRepo(on, { files: files() })

    await ship($, 'resume')
    await steps($, repo, 'agent-1', 141_000)
    await ends($, repo, 'agent-1', 'answer')

    expect(repo.logged[0]).toBe(
      'checkout: 01 A cart holds items passed its context budget and was asked to stop, but its turn ended normally.',
    )
  })

  test('keeps work it had already finished: a ticket done on its last response is committed', async ($, on) => {
    const repo = answerRepo(on, { files: files() })

    await ship($, 'resume')
    await steps($, repo, 'agent-1', 141_000)
    await ends($, repo, 'agent-1', 'answer')

    expect(repo.statusOf(CART)).toBe('done')
  })

  test('has the budget the person set', { options: { contextPercent: 40 } }, async ($, on) => {
    const repo = answerRepo(on, { files: files() })

    await ship($, 'resume')
    await steps($, repo, 'agent-1', 81_000)

    expect(repo.aborted).toEqual(['turn-of-agent-1'])
  })

  test('is the run\'s own to stop: no other agent is measured, however full its context', async ($, on) => {
    const repo = answerRepo(on, { files: files() })

    await ship($, 'resume')
    await steps($, repo, 'someone-else', 190_000)

    expect(repo.aborted).toEqual([])
  })
})
