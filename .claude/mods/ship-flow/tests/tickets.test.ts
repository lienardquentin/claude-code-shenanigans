import { describe, expect, test } from 'claude-code/testing'

import {
  blockedBy,
  frontier,
  lintOf,
  outsideOf,
  overlaps,
  parseTicket,
  problemsOf,
  scheduleLines,
  scheduleOf,
  takeable,
  withStatus,
} from '../hooks/tickets'
import type { Ticket } from '../hooks/tickets'

const file = (number: string, lines: readonly string[]) =>
  parseTicket(`${number}-a-ticket.md`, [`# ${number}: Ticket ${number}`, '', ...lines].join('\n'))

const ticket = (number: number, status: string, blockers: readonly number[] = []): Ticket => ({
  file: `0${number}-a-ticket.md`,
  number,
  title: `Ticket ${number}`,
  status,
  blockers,
  criteria: [],
})

const touching = (number: number, touches: readonly string[], blockers: readonly number[] = []): Ticket => ({
  ...ticket(number, 'ready', blockers),
  touches,
  outward: [],
  criteria: [{ text: 'It works', isDone: false }],
})

describe('what is worth putting right in tickets that can run', () => {
  test('is nothing for a ticket that names its files, its outward actions and a criterion', () => {
    expect(lintOf([touching(1, ['src/cart.ts'])])).toEqual([])
  })

  test('is each thing a ticket leaves out, in ticket order', () => {
    expect(lintOf([ticket(2, 'ready'), { ...touching(1, ['src/cart/', 'docs/']), criteria: [] }])).toEqual([
      '01 names only folders in Touches (src/cart/, docs/): name the files, or no ticket under them is built beside it',
      '01 has no acceptance criterion: nothing says when it is built',
      '02 declares no Touches: it is built alone, beside no other ticket',
      '02 declares no Outward actions: write None when it has none',
      '02 has no acceptance criterion: nothing says when it is built',
    ])
  })
})

describe('the schedule of a run, as an estimate', () => {
  test('takes side by side the tickets that neither wait on each other nor overlap, wave after wave', () => {
    const tickets = [
      touching(1, ['src/cart.ts']),
      touching(2, ['src/pay.ts']),
      touching(3, ['src/tax.ts'], [1]),
      touching(4, ['src/cart.ts'], [1, 2]),
      touching(5, ['src/ship.ts'], [3]),
    ]

    expect(scheduleOf(tickets, 3)).toEqual({ waves: [[1, 2], [3, 4], [5]], chain: [1, 3, 5] })
    expect(scheduleLines(tickets, 3)).toEqual([
      'Schedule (an estimate): 5 tickets in 3 waves, up to 3 side by side: 01, 02 · 03, 04 · 05',
      'Longest chain: 01 → 03 → 05',
    ])
  })

  test('says so when no two tickets go together, and counts only what is left to build', () => {
    const tickets = [{ ...touching(1, ['src/cart.ts']), status: 'done' }, touching(2, ['src/cart.ts'], [1]), touching(3, ['src/cart.ts'])]

    expect(scheduleLines(tickets, 3)).toEqual([
      'Schedule (an estimate): 2 tickets in 2 waves, up to 3 side by side: 02 · 03',
      'No two tickets are built side by side: their Touches overlap, or each waits on the one before.',
    ])
  })

  test('is not shown for a single ticket', () => {
    expect(scheduleLines([touching(1, ['src/cart.ts'])], 3)).toEqual([])
  })
})

test('the files a ticket changed outside its estimate are those under none of its Touches', () => {
  expect(outsideOf(touching(1, ['src/cart/', 'docs/cart.md']), ['src/cart/total.ts', 'docs/cart.md', 'src/price.ts'])).toEqual(['src/price.ts'])
  expect(outsideOf(ticket(1, 'ready'), ['src/price.ts'])).toEqual([])
})

describe('a ticket file', () => {
  test('is read into its number, title, status, blockers and criteria', () => {
    expect(
      parseTicket(
        '02-build-one-ticket.md',
        [
          '# 02: `/ship resume` builds one ticket',
          '',
          '**What to build:** One ticket, blocked by nothing the text says here.',
          '',
          '**Blocked by:** 01',
          '',
          '**Status:** ready',
          '',
          '- [x] The first criterion',
          '- [ ] The second criterion',
        ].join('\n'),
      ),
    ).toEqual({
      file: '02-build-one-ticket.md',
      number: 2,
      title: '`/ship resume` builds one ticket',
      status: 'ready',
      blockers: [1],
      criteria: [
        { text: 'The first criterion', isDone: true },
        { text: 'The second criterion', isDone: false },
      ],
    })
  })

  test('with no blockers says so in words, and with several lists them', () => {
    expect(file('01', ['**Blocked by:** None (can start immediately)', '**Status:** ready']).blockers).toEqual([])
    expect(file('08', ['**Blocked by:** 04, 07', '**Status:** ready']).blockers).toEqual([4, 7])
  })

  test('may name its own model', () => {
    expect(file('02', ['**Blocked by:** 01', '**Status:** ready', '**Model:** opus']).model).toBe('opus')
    expect(file('03', ['**Blocked by:** 02', '**Status:** ready']).model).toBeUndefined()
  })

  test('declares nothing of its reach without the Touches and Outward actions lines', () => {
    const read = file('01', ['**Status:** ready'])

    expect(read.touches).toBeUndefined()
    expect(read.outward).toBeUndefined()
  })

  test('reads one touched path, or several with stray spaces', () => {
    expect(file('01', ['**Touches:** src/a.ts']).touches).toEqual(['src/a.ts'])
    expect(file('01', ['**Touches:**   src/a.ts ,src/b/ ,  docs/c.md  ,']).touches).toEqual(['src/a.ts', 'src/b/', 'docs/c.md'])
  })

  test('reads outward actions: None as declared and empty, one, or several with stray spaces', () => {
    expect(file('01', ['**Outward actions:** None']).outward).toEqual([])
    expect(file('01', ['**Outward actions:** installs the npm package `zod`']).outward).toEqual(['installs the npm package `zod`'])
    expect(file('01', ['**Outward actions:**  installs `zod` ;deletes `dist/` ; ']).outward).toEqual(['installs `zod`', 'deletes `dist/`'])
  })

  test('declares each field apart', () => {
    const read = file('01', ['**Touches:** a.ts'])

    expect(read.touches).toEqual(['a.ts'])
    expect(read.outward).toBeUndefined()
  })

  test('takes its number from its file name when its heading has none', () => {
    const read = parseTicket('05-too-large.md', '# A ticket that outgrows its budget\n\n**Status:** done')

    expect(read.number).toBe(5)
    expect(read.title).toBe('A ticket that outgrows its budget')
  })

  test('has its status line rewritten, and nothing else', () => {
    const text = '# 03: Walk\n\n**Blocked by:** 02\n\n**Status:** ready\n\n- [ ] One\n'

    expect(withStatus(text, 'in-progress')).toBe('# 03: Walk\n\n**Blocked by:** 02\n\n**Status:** in-progress\n\n- [ ] One\n')
  })
})

describe('a ticket graph', () => {
  test('has no problems when every ticket has a known status and known blockers', () => {
    expect(problemsOf([ticket(1, 'done'), ticket(2, 'ready', [1]), ticket(3, 'too-large', [1])])).toEqual([])
  })

  test('reports a missing status, and one that is not a state', () => {
    const missing = file('01', ['**Blocked by:** None'])

    expect(problemsOf([missing, ticket(2, 'ready-for-agent')])).toEqual([
      { number: 1, reason: 'has no Status line' },
      { number: 2, reason: 'has the status "ready-for-agent", which is not one of ready, in-progress, done, blocked, too-large' },
    ])
  })

  test('reports a blocker that does not exist, and a ticket blocked by itself', () => {
    expect(problemsOf([ticket(1, 'ready', [1]), ticket(2, 'ready', [9])])).toEqual([
      { number: 1, reason: 'is blocked by itself' },
      { number: 2, reason: 'is blocked by 09, which does not exist' },
    ])
  })

  test('reports a cycle once, on each ticket in it', () => {
    expect(problemsOf([ticket(1, 'ready', [3]), ticket(2, 'ready', [1]), ticket(3, 'ready', [2]), ticket(4, 'ready', [3])])).toEqual([
      { number: 1, reason: 'is in a cycle: 01 → 03 → 02 → 01' },
      { number: 2, reason: 'is in a cycle: 01 → 03 → 02 → 01' },
      { number: 3, reason: 'is in a cycle: 01 → 03 → 02 → 01' },
    ])
  })

  test('reports two tickets with the same number, and a file with no number', () => {
    const unnumbered = parseTicket('notes.md', '# Notes\n\n**Status:** ready')

    expect(problemsOf([ticket(1, 'ready'), { ...ticket(1, 'ready'), file: '01-again.md' }, unnumbered])).toEqual([
      { number: 1, reason: 'is the number of two files: 01-a-ticket.md and 01-again.md' },
      { file: 'notes.md', reason: 'has no ticket number in its name or its heading' },
    ])
  })

  test('has as its frontier the ready tickets whose blockers are all done', () => {
    const tickets = [
      ticket(1, 'done'),
      ticket(2, 'ready', [1]),
      ticket(3, 'ready', [2]),
      ticket(4, 'ready'),
      ticket(5, 'in-progress', [1]),
      ticket(6, 'blocked', [1]),
    ]

    expect(frontier(tickets).map(t => t.number)).toEqual([2, 4])
  })

  test('marks as blocked every ready ticket that hangs off a blocked or too-large one', () => {
    const tickets = [
      ticket(1, 'blocked'),
      ticket(2, 'ready', [1]),
      ticket(3, 'ready', [2]),
      ticket(4, 'too-large'),
      ticket(5, 'done', [4]),
      ticket(6, 'ready', [5, 4]),
      ticket(7, 'ready'),
    ]

    expect(blockedBy(tickets).map(t => t.number)).toEqual([2, 3, 6])
  })
})

describe('the tickets a run builds side by side', () => {
  const touching = (number: number, touches?: readonly string[], status = 'ready'): Ticket => ({
    ...ticket(number, status),
    ...(touches ? { touches } : {}),
  })

  test('overlap when they declare the same file, or one a folder the other is under', () => {
    expect(overlaps(touching(1, ['src/cart.ts']), touching(2, ['docs/cart.md', 'src/cart.ts']))).toBe(true)
    expect(overlaps(touching(1, ['src/cart/']), touching(2, ['src/cart/total.ts']))).toBe(true)
    expect(overlaps(touching(1, ['src\\cart\\total.ts']), touching(2, ['src/cart/']))).toBe(true)
    expect(overlaps(touching(1, ['src/cart.ts']), touching(2, ['src/cart.test.ts', 'src/pay/']))).toBe(false)
    expect(overlaps(touching(1, ['src/cart']), touching(2, ['src/cart-total.ts']))).toBe(false)
  })

  test('overlap whenever one of them declares nothing: it may touch anything', () => {
    expect(overlaps(touching(1), touching(2, ['src/pay.ts']))).toBe(true)
    expect(overlaps(touching(1, []), touching(2, ['src/pay.ts']))).toBe(true)
  })

  test('are those of the frontier that overlap neither each other nor a ticket being built, in ticket order', () => {
    const tickets = [
      touching(1, ['src/cart/'], 'in-progress'),
      touching(2, ['src/cart/total.ts']),
      touching(3, ['src/pay.ts']),
      touching(4, ['src/pay.ts', 'src/tax.ts']),
      touching(5, ['docs/']),
      { ...touching(6, ['src/search.ts']), blockers: [3] },
    ]

    expect(takeable(tickets, [1], 8).map(t => t.number)).toEqual([3, 5])
  })

  test('are as many as the run has room for, counting those being built', () => {
    const tickets = [touching(1, ['a.ts'], 'in-progress'), touching(2, ['b.ts']), touching(3, ['c.ts']), touching(4, ['d.ts'])]

    expect(takeable(tickets, [1], 3).map(t => t.number)).toEqual([2, 3])
    expect(takeable(tickets, [1], 1)).toEqual([])
  })

  test('are the first of the frontier alone when it declares nothing', () => {
    expect(takeable([touching(1), touching(2, ['b.ts'])], [], 3).map(t => t.number)).toEqual([1])
  })
})
