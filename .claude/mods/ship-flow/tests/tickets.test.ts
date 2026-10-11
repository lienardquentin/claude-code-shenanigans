import { describe, expect, test } from 'claude-code/testing'

import { blockedBy, frontier, parseTicket, problemsOf, withStatus } from '../hooks/tickets'
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
