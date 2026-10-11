import { describe, expect, test } from 'claude-code/testing'

import { IMPLEMENTER_PROMPT } from '../hooks/runner'
import { NOT_DECLARED, blockOf, radiusOf, reachText, rowText, runRadiusOf } from '../hooks/radius'
import { parseTicket } from '../hooks/tickets'

const ticket = (number: string, lines: readonly string[]) =>
  parseTicket(`${number}-a-ticket.md`, [`# ${number}: Ticket ${number}`, '', ...lines].join('\n'))

describe('a ticket radius', () => {
  test('counts the files it declares, once each', () => {
    const radius = radiusOf(ticket('01', ['**Touches:** a.ts, b.ts, a.ts']))

    expect(radius.files).toEqual(['a.ts', 'b.ts'])
    expect(reachText(radius)).toBe('2 files')
    expect(reachText(radiusOf(ticket('02', ['**Touches:** a.ts'])))).toBe('1 file')
  })

  test('is not declared without a Touches line, and has no files', () => {
    const radius = radiusOf(ticket('01', ['**Status:** ready']))

    expect(reachText(radius)).toBe(NOT_DECLARED)
    expect(radius.files).toEqual([])
  })

  test('shows a path that leaves the repo as an outward action, not as a file', () => {
    const radius = radiusOf(
      ticket('01', ['**Touches:** a.ts, /etc/hosts, ~/.claude/settings.json, ../other/x.ts, C:\\x.txt', '**Outward actions:** installs `zod`']),
    )

    expect(radius.files).toEqual(['a.ts'])
    expect(radius.outward).toEqual([
      'changes `/etc/hosts` outside the repo',
      'changes `~/.claude/settings.json` outside the repo',
      'changes `../other/x.ts` outside the repo',
      'changes `C:\\x.txt` outside the repo',
      'installs `zod`',
    ])
  })

  test('marks its row when it has outward actions', () => {
    expect(rowText(radiusOf(ticket('01', ['**Touches:** a.ts', '**Outward actions:** deletes `dist/`'])))).toBe('1 file ▲')
    expect(rowText(radiusOf(ticket('02', ['**Touches:** a.ts', '**Outward actions:** None'])))).toBe('1 file')
    expect(rowText(radiusOf(ticket('03', ['**Outward actions:** deletes `dist/`'])))).toBe('not declared ▲')
  })
})

describe('a run radius', () => {
  const tickets = [
    ticket('02', ['**Touches:** b.ts, c.ts', '**Outward actions:** publishes the package']),
    ticket('01', ['**Touches:** a.ts, b.ts', '**Outward actions:** installs `zod`; deletes `dist/`']),
    ticket('03', ['**Status:** ready']),
  ]

  test('counts a file two tickets declare once', () => {
    expect(runRadiusOf(tickets).files).toEqual(['a.ts', 'b.ts', 'c.ts'])
  })

  test('words its totals, then every outward action in full by ticket number', () => {
    expect(blockOf(tickets)).toEqual({
      totals: 'Blast radius (an estimate): 3 files',
      outward: ['01 installs `zod`', '01 deletes `dist/`', '02 publishes the package'],
    })
  })

  test('says not declared when no ticket declares its files', () => {
    expect(blockOf([ticket('01', ['**Status:** ready'])])).toEqual({
      totals: `Blast radius (an estimate): ${NOT_DECLARED}`,
      outward: [],
    })
  })
})

describe("the implementer's prompt", () => {
  test('says the declared files are the estimate the person approved, not a constraint', () => {
    expect(IMPLEMENTER_PROMPT).toContain('`**Touches:**` line is the estimate the person approved, not a constraint')
  })
})
