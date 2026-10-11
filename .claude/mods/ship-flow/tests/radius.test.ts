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

describe('a ticket radius with the repo read', () => {
  const tracked = ['src/cart/total.ts', 'src/cart/index.ts', 'src/cart/tax.ts', 'src/pay.ts', 'src/pay.test.ts', 'tests/e2e.ts', 'lib/util.py']
  const reading = (imports: Record<string, string>) => ({
    tracked,
    imports: Object.entries(imports).map(([file, line]) => ({ file, line })),
  })
  const of = (touches: string, imports: Record<string, string> = {}) => radiusOf(ticket('01', [`**Touches:** ${touches}`]), reading(imports))

  test('counts a tracked file as one, a new file as one with no dependents', () => {
    const radius = of('src/pay.ts, src/new.ts', { 'tests/e2e.ts': "import './new'" })

    expect(radius.files).toEqual(['src/pay.ts', 'src/new.ts'])
    expect(radius.dependents).toEqual([])
    expect(reachText(radius)).toBe('2 files · 0 dependents · 0 tests')
  })

  test('counts a directory as every tracked file under it, or as one new entry when none is tracked', () => {
    expect(of('src/cart/').files).toEqual(['src/cart/total.ts', 'src/cart/index.ts', 'src/cart/tax.ts'])
    expect(of('docs/').files).toEqual(['docs/'])
  })

  test('finds a dependent through a relative specifier, with the extension or without, and through an index file', () => {
    expect(of('src/cart/total.ts', { 'src/pay.ts': "import { t } from './cart/total'" }).dependents).toEqual(['src/pay.ts'])
    expect(of('src/cart/total.ts', { 'src/pay.ts': "import { t } from './cart/total.ts'" }).dependents).toEqual(['src/pay.ts'])
    expect(of('src/cart/total.ts', { 'tests/e2e.ts': "import { t } from '../src/cart/total'" }).dependents).toEqual(['tests/e2e.ts'])
    expect(of('src/cart/index.ts', { 'src/pay.ts': "import { c } from './cart'" }).dependents).toEqual(['src/pay.ts'])
    expect(of('src/cart/total.ts', { 'src/pay.ts': "import { t } from './cart/other'" }).dependents).toEqual([])
  })

  test('finds a dependent through a bare specifier that is the tail of the touched path at a folder boundary', () => {
    expect(of('src/cart/total.ts', { 'lib/util.py': 'from cart.total import x; require("cart/total")' }).dependents).toEqual(['lib/util.py'])
    expect(of('src/cart/total.ts', { 'lib/util.py': 'import "art/total"' }).dependents).toEqual([])
  })

  test('ignores a quoted string on a line that imports nothing', () => {
    expect(of('src/cart/total.ts', { 'src/pay.ts': "const x = './cart/total'" }).dependents).toEqual([])
  })

  test('never counts a touched file as a dependent', () => {
    const radius = of('src/cart/total.ts, src/pay.ts', { 'src/pay.ts': "import { t } from './cart/total'" })

    expect(radius.dependents).toEqual([])
  })

  test('does not follow a dependent to the files that import it', () => {
    const radius = of('src/cart/total.ts', {
      'src/pay.ts': "import { t } from './cart/total'",
      'tests/e2e.ts': "import { pay } from '../src/pay'",
    })

    expect(radius.dependents).toEqual(['src/pay.ts'])
  })

  test('counts as tests the dependents named or housed like one', () => {
    const imports = (file: string) => `import { t } from '${file.includes('/') ? '..' : '.'}/cart/total'`
    const radius = radiusOf(
      ticket('01', ['**Touches:** src/cart/total.ts']),
      {
        tracked: [
          'src/cart/total.ts',
          ...['a.test.ts', 'b.spec.ts', 'c_test.go', 'test_d.py', 'test/e.ts', 'tests/f.ts', '__tests__/g.ts', 'latest/h.ts', 'contest.ts'].map(file => `src/${file}`),
        ],
        imports: [
          'a.test.ts', 'b.spec.ts', 'c_test.go', 'test_d.py', 'test/e.ts', 'tests/f.ts', '__tests__/g.ts', 'latest/h.ts', 'contest.ts',
        ].map(file => ({ file: `src/${file}`, line: imports(file) })),
      },
    )

    expect(radius.dependents).toHaveLength(9)
    expect(radius.tests.map(file => file.slice(4))).toEqual(['a.test.ts', 'b.spec.ts', 'c_test.go', 'test_d.py', 'test/e.ts', 'tests/f.ts', '__tests__/g.ts'])
  })
})

describe('a run radius with the repo read', () => {
  const reading = {
    tracked: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'd.test.ts'],
    imports: [
      { file: 'c.ts', line: "import './a'" },
      { file: 'd.ts', line: "import './a'; import './b'" },
      { file: 'd.test.ts', line: "import './d'" },
      { file: 'b.ts', line: "import './a'" },
    ],
  }

  test('counts a file and a dependent once, and leaves out of the dependents every file the run touches', () => {
    const tickets = [ticket('01', ['**Touches:** a.ts']), ticket('02', ['**Touches:** a.ts, b.ts'])]
    const run = runRadiusOf(tickets, reading)

    expect(run.files).toEqual(['a.ts', 'b.ts'])
    // b.ts depends on a.ts for ticket 01, but ticket 02 changes it too
    expect(run.dependents).toEqual(['c.ts', 'd.ts'])
    expect(blockOf(tickets, reading).totals).toBe('Blast radius (an estimate): 2 files · 2 dependents · 0 tests')
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
