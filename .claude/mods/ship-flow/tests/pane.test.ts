import { describe, expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { answerRepo, spec, ticket } from './repo'

type Engine = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]
type Repo = ReturnType<typeof answerRepo>

const SURFACES = ['terminal', 'desktop'] as const

const CART = '.scratch/checkout/issues/01-cart.md'
const PAY = '.scratch/checkout/issues/02-pay.md'
const RECORD = '.scratch/checkout/run.json'

const checkout = () => ({
  '.scratch/checkout/spec.md': spec(['npm test']),
  [CART]: ticket('01', 'A cart holds items', ['**Blocked by:** None', '**Status:** ready']),
  [PAY]: ticket('02', 'A cart is paid', ['**Blocked by:** 01', '**Status:** ready', '**Model:** opus']),
})

const record = (fields: Record<string, unknown>) =>
  JSON.stringify({ feature: 'checkout', branch: 'ship/checkout', attempts: {}, ...fields })

const mountPane = ($: Engine, surface: (typeof SURFACES)[number]) =>
  $.ui.mount({ plugin: 'ship-flow', surface, component: 'Pane', props: { bodyColumns: 100 } as never, requestId: 'ship-flow' })

const ship = async ($: Engine, args: string) => (await $.command.run({ command: 'ship', args } as never)).text ?? ''

const ends = async ($: Engine, repo: Repo, agentId: string) => {
  repo.change(' M src/cart.ts\n')
  await $.turn.complete({ answer: 'Built.', durationMs: 1, isAborted: false, turnId: 't1', agentId, reason: 'answer' } as never)
}

// The pane can be placed: what the engine answers a mod that opens one
const answerOpen = (on: On) => {
  const opened: string[] = []

  on('ui.open', (_, e) => {
    opened.push(e.id)

    return { value: { isPlaced: true } } as never
  })

  return opened
}

for (const surface of SURFACES) {
  describe(`the pane, on the ${surface}`, () => {
    test('says there is no run, and how to start one, in a repo with none', async ($, on) => {
      answerRepo(on, { files: {} })

      const pane = await mountPane($, surface)

      expect(await pane.find({ text: /No run in this repo\. Start one with \/ship <idea> or \/ship #<issue>\./ })).toBeDefined()
      expect(await pane.find({ key: 'refresh' })).toBeDefined()
    })

    test('shows a run as a card: its feature, how many tickets are done, and each ticket with its state and note', async ($, on) => {
      answerRepo(on, { files: { ...checkout(), [CART]: ticket('01', 'A cart holds items', ['**Blocked by:** None', '**Status:** done']) } })

      const pane = await mountPane($, surface)

      expect(await pane.find({ text: /checkout/ })).toBeDefined()
      expect(await pane.find({ text: /1 of 2 done/ })).toBeDefined()
      expect(await pane.find({ text: 'A cart holds items' })).toBeDefined()
      expect(await pane.find({ text: /^done$/ })).toBeDefined()
      expect(await pane.find({ text: /^ready$/ })).toBeDefined()
      expect(await pane.find({ text: 'blocked by 01 · model opus · takeable now' })).toBeDefined()
    })

    test('tells the surface to wrap a long title, and the whole reason of a failed ticket, and to cut the number and the state', async ($, on) => {
      const title = 'A cart holds items of every kind, however many there are, and keeps them until the shopper pays or leaves, even across sessions, devices and browsers, and even when the shopper signs in again much later on a different machine with a different account'
      const reason = '`npm test` failed: 14 specs ran, 3 failed in src/cart/very/deeply/nested/path/to/the/cart-total.spec.ts and the run stopped'

      answerRepo(on, {
        files: {
          ...checkout(),
          [CART]: ticket('01', title, ['**Blocked by:** None', '**Status:** in-progress']),
          [RECORD]: record({ phase: 'unattended', ticket: 1, attempts: { '01': 2 }, failure: { ticket: 1, reason } }),
        },
      })

      const pane = await mountPane($, surface)

      const wrapOf = async (text: string | RegExp) => (await pane.find({ type: 'Text', text }))?.props.wrap

      expect(await wrapOf(title)).toBe('wrap')
      expect(await wrapOf(new RegExp(`failed: ${reason.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))).toBe('wrap')
      expect(await wrapOf(/^01$/)).toBe('truncate-end')
      expect(await wrapOf(/^in-progress$/)).toBe('truncate-end')
    })

    test('says where a run stands, and what it last read of the quota', async ($, on) => {
      answerRepo(on, {
        files: {
          ...checkout(),
          [RECORD]: record({
            phase: 'paused',
            pause: 'the 5-hour quota window is at 92%: the run goes on by itself at 22:11 UTC',
            usage: { at: 1, quota: [{ kind: 'five_hour', percentUsed: 92 }, { kind: 'seven_day', percentUsed: 27 }] },
          }),
        },
      })

      const pane = await mountPane($, surface)

      expect(await pane.find({ text: /paused: the 5-hour quota window is at 92%/ })).toBeDefined()
      expect(await pane.find({ text: /5h 92%/ })).toBeDefined()
      expect(await pane.find({ text: /week 27%/ })).toBeDefined()
    })

    test('shows the pull request of a run that has ended, and no Resume for it', async ($, on) => {
      answerRepo(on, {
        files: {
          ...checkout(),
          [CART]: ticket('01', 'A cart holds items', ['**Blocked by:** None', '**Status:** done']),
          [PAY]: ticket('02', 'A cart is paid', ['**Blocked by:** 01', '**Status:** done']),
          [RECORD]: record({ phase: 'ended', pause: 'the pull request is open: https://github.com/dev/repo/pull/7' }),
        },
      })

      const pane = await mountPane($, surface)

      expect(await pane.find({ text: /ended: the pull request is open: https:\/\/github\.com\/dev\/repo\/pull\/7/ })).toBeDefined()
      expect(await pane.findAll({ key: 'resume-checkout' })).toEqual([])
    })

    test('shows what is wrong with a ticket folder that cannot be run, and no Resume for it', async ($, on) => {
      answerRepo(on, { files: { ...checkout(), [CART]: ticket('01', 'A cart holds items', ['**Blocked by:** 07', '**Status:** ready']) } })

      const pane = await mountPane($, surface)

      expect(await pane.find({ text: 'The ticket folder cannot be run:' })).toBeDefined()
      expect(await pane.find({ text: '01 is blocked by 07, which does not exist' })).toBeDefined()
      expect(await pane.findAll({ key: 'resume-checkout' })).toEqual([])
    })

    test('Resume takes the run up as /ship resume does, and the pane then shows the ticket being built', async ($, on) => {
      const repo = answerRepo(on, { files: checkout() })
      const pane = await mountPane($, surface)

      await pane.press({ key: 'resume-checkout' })

      expect(repo.spawned.map(agent => agent.description)).toEqual(['Build ticket 01'])
      expect(repo.logged).toEqual(['checkout: building 01 A cart holds items on sonnet, on branch checkout-feature.'])
      expect(await pane.find({ text: /^building 01$/ })).toBeDefined()
      expect(await pane.find({ text: /^in-progress$/ })).toBeDefined()
      expect(await pane.findAll({ key: 'resume-checkout' })).toEqual([])
    })

    test('redraws by itself as the run moves: a ticket done, the next one started', async ($, on) => {
      const repo = answerRepo(on, { files: checkout() })

      await ship($, 'resume')

      const pane = await mountPane($, surface)

      expect(await pane.find({ text: /0 of 2 done/ })).toBeDefined()

      await ends($, repo, 'agent-1')

      expect(await pane.find({ text: /1 of 2 done/ })).toBeDefined()
      expect(await pane.find({ text: /^building 02$/ })).toBeDefined()
    })

    test('shows the blast radius its tickets declare: a Reach column, a mark, the totals and every outward action', async ($, on) => {
      answerRepo(on, {
        files: {
          ...checkout(),
          [CART]: ticket('01', 'A cart holds items', ['**Blocked by:** None', '**Status:** ready', '**Touches:** src/cart.ts, src/pay.ts, ~/.claude/x.json', '**Outward actions:** installs `zod`']),
          [PAY]: ticket('02', 'A cart is paid', ['**Blocked by:** 01', '**Status:** ready', '**Touches:** src/pay.ts', '**Outward actions:** None']),
          [RECORD]: record({ phase: 'attended', branch: 'main', source: 'issue', issue: 12 }),
        },
      })

      const pane = await mountPane($, surface)

      expect(await pane.find({ text: 'Reach' })).toBeDefined()
      expect(await pane.find({ text: '▲ 2 files · 0 dependents · 0 tests' })).toBeDefined()
      expect(await pane.find({ text: '1 file · 0 dependents · 0 tests' })).toBeDefined()
      expect(await pane.find({ text: 'Blast radius (an estimate): 2 files · 0 dependents · 0 tests' })).toBeDefined()
      expect(await pane.find({ text: '▲ 01 changes `~/.claude/x.json` outside the repo' })).toBeDefined()
      expect(await pane.find({ text: '▲ 01 installs `zod`' })).toBeDefined()
    })

    test('counts the dependents and the tests among them, and the run once for a file two tickets share', async ($, on) => {
      answerRepo(on, {
        files: {
          ...checkout(),
          [CART]: ticket('01', 'A cart holds items', ['**Blocked by:** None', '**Status:** ready', '**Touches:** src/cart.ts']),
          [PAY]: ticket('02', 'A cart is paid', ['**Blocked by:** 01', '**Status:** ready', '**Touches:** src/cart.ts, src/new.ts']),
          [RECORD]: record({ phase: 'attended', branch: 'main', source: 'issue', issue: 12 }),
        },
        tracked: ['src/cart.ts', 'src/pay.ts', 'src/cart.test.ts', 'README.md'],
        imports: { 'src/pay.ts': ["import { cart } from './cart'"], 'src/cart.test.ts': ["import { cart } from './cart.ts'"] },
      })

      const pane = await mountPane($, surface)

      expect(await pane.find({ text: '1 file · 2 dependents · 1 test' })).toBeDefined()
      expect(await pane.find({ text: '2 files · 2 dependents · 1 test' })).toBeDefined()
      expect(await pane.find({ text: 'Blast radius (an estimate): 2 files · 2 dependents · 1 test' })).toBeDefined()
    })

    test('searches the repo once for two draws at the same commit, and again after Refresh', async ($, on) => {
      const repo = answerRepo(on, {
        files: {
          ...checkout(),
          [CART]: ticket('01', 'A cart holds items', ['**Blocked by:** None', '**Status:** ready', '**Touches:** src/cart.ts']),
        },
        tracked: ['src/cart.ts'],
      })
      const searches = () => repo.ran.filter(line => line.startsWith('git grep')).length

      const pane = await mountPane($, surface)

      expect(searches()).toBe(1)

      // The run writing its record draws the pane again, at the same commit
      await pane.press({ key: 'resume-checkout' })
      expect(await pane.find({ text: /^building 01$/ })).toBeDefined()
      expect(searches()).toBe(1)

      await pane.press({ key: 'refresh' })
      expect(searches()).toBe(2)
    })

    test('shows the declared files and says the dependents could not be read when git fails', async ($, on) => {
      const repo = answerRepo(on, {
        files: {
          ...checkout(),
          [CART]: ticket('01', 'A cart holds items', ['**Blocked by:** None', '**Status:** ready', '**Touches:** src/cart.ts']),
          [RECORD]: record({ phase: 'attended', branch: 'main', source: 'issue', issue: 12 }),
        },
      })

      repo.gitReads.fails = true

      const pane = await mountPane($, surface)

      expect(await pane.find({ text: '1 file' })).toBeDefined()
      expect(await pane.find({ text: /dependents could not be read/ })).toBeDefined()
      expect(await pane.find({ key: 'resume-checkout', text: /Approve and build/ })).toBeDefined()
    })

    test('says not declared for a ticket without the fields, and the run can still be approved', async ($, on) => {
      answerRepo(on, { files: { ...checkout(), [RECORD]: record({ phase: 'attended', branch: 'main', source: 'issue', issue: 12 }) } })

      const pane = await mountPane($, surface)

      expect(await pane.find({ text: /^not declared$/ })).toBeDefined()
      expect(await pane.find({ text: 'Blast radius (an estimate): not declared' })).toBeDefined()
      expect(await pane.find({ key: 'resume-checkout', text: /Approve and build/ })).toBeDefined()
    })

    test('shows no radius on the card of a run that has ended', async ($, on) => {
      answerRepo(on, {
        files: {
          ...checkout(),
          [CART]: ticket('01', 'A cart holds items', ['**Blocked by:** None', '**Status:** done', '**Touches:** src/cart.ts', '**Outward actions:** installs `zod`']),
          [PAY]: ticket('02', 'A cart is paid', ['**Blocked by:** 01', '**Status:** done']),
          [RECORD]: record({ phase: 'ended', pause: 'the pull request is open: https://github.com/dev/repo/pull/7' }),
        },
      })

      const pane = await mountPane($, surface)

      expect(await pane.findAll({ text: 'Reach' })).toEqual([])
      expect(await pane.findAll({ text: /Blast radius/ })).toEqual([])
      expect(await pane.findAll({ text: /installs `zod`/ })).toEqual([])
    })

    test('a run before its checkpoint offers to approve it', async ($, on) => {
      answerRepo(on, { files: { ...checkout(), [RECORD]: record({ phase: 'attended', branch: 'main', source: 'issue', issue: 12 }) } })

      const pane = await mountPane($, surface)

      expect(await pane.find({ text: /with you, before the checkpoint/ })).toBeDefined()
      expect(await pane.find({ key: 'resume-checkout', text: /Approve and build/ })).toBeDefined()
    })
  })
}

describe('/ship pane', () => {
  test('opens the pane', async ($, on) => {
    answerRepo(on, { files: {} })

    const opened = answerOpen(on)

    expect(await ship($, 'pane')).toBe('The ship-flow pane is open.')
    expect(opened).toEqual(['ship-flow'])
  })

  test('the pane opens too when a run is taken up', async ($, on) => {
    answerRepo(on, { files: checkout() })

    const opened = answerOpen(on)

    await ship($, 'resume')

    expect(opened).toEqual(['ship-flow'])
  })

  test('/ship status opens nothing', async ($, on) => {
    answerRepo(on, { files: checkout() })

    const opened = answerOpen(on)

    await ship($, 'status')

    expect(opened).toEqual([])
  })
})
