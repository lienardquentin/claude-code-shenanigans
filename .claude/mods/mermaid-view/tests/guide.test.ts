import { describe, expect, test } from 'claude-code/testing'

import {
  IDENTIFIERS,
  PIXEL_TERMINALS,
  detectHost,
  detectOs,
  detectTerminal,
  drawsPixels,
  gaps,
  recommended,
  rowFor,
  tableFor,
  toneOfValue,
} from '../hooks/guide'
import { READ_ON, TERMINALS } from '../hooks/terminals'

const envOf = (values: Record<string, string>) => (name: string) => values[name]

describe('the data of the terminal guide', () => {
  test('is the research file\'s: rows for every system, every cell a known value, and the day the sources were read', () => {
    expect(TERMINALS.length).toBeGreaterThanOrEqual(20)
    expect(new Set(TERMINALS.map(row => row.os))).toEqual(new Set(['windows', 'macos', 'linux', 'host']))
    expect(READ_ON).toMatch(/^\d{4}-\d{2}-\d{2}$/)

    for (const row of TERMINALS) {
      for (const cell of [row.images, row.mouse, row.links, row.recognise]) {
        expect(['yes', 'no', 'partial', 'unknown']).toContain(cell.value)
      }
    }
  })

  test('says Ghostty has no Windows build, as the file does, and that sixel is in Windows Terminal', () => {
    const ghostty = TERMINALS.find(row => row.os === 'windows' && row.name === 'Ghostty')
    const terminal = TERMINALS.find(row => row.os === 'windows' && row.name === 'Windows Terminal')

    expect(ghostty?.images.value).toBe('no')
    expect(ghostty?.images.note).toMatch(/no Windows build/)
    expect(terminal?.images.note).toMatch(/sixel/i)
  })

  test('keeps the qualifier of a cell: sixel in WezTerm is partial, though the cell as a whole is yes', () => {
    const wezterm = TERMINALS.find(row => row.name === 'WezTerm' && row.os === 'macos')

    expect(wezterm?.images.value).toBe('yes')
    expect(wezterm?.images.note).toMatch(/sixel `partial`/)
  })
})

describe('recognising a terminal', () => {
  test('every identifier a rule relies on is one the research file cites for that terminal, with a verified value', () => {
    for (const { terminal, text } of IDENTIFIERS) {
      // A terminal may have a row on several systems (and none of them an identifier on a system it does not run on)
      const rows = TERMINALS.filter(row => row.name === terminal || row.name.startsWith(`${terminal} `))
      const cited = rows.filter(row => ['yes', 'partial'].includes(row.recognise.value) && row.recognise.note.includes(text))

      expect(rows.length, `no row for ${terminal}`).toBeGreaterThan(0)
      expect(cited.length, `${terminal} does not cite ${text}`).toBeGreaterThan(0)
    }
  })

  test('reads the terminal from the variables it sets', () => {
    expect(detectTerminal(envOf({ WT_SESSION: 'abc' }))).toBe('Windows Terminal')
    expect(detectTerminal(envOf({ KITTY_WINDOW_ID: '1' }))).toBe('kitty')
    expect(detectTerminal(envOf({ TERM_PROGRAM: 'WezTerm' }))).toBe('WezTerm')
    expect(detectTerminal(envOf({ TERM_PROGRAM: 'ghostty' }))).toBe('Ghostty')
    expect(detectTerminal(envOf({ TERM_PROGRAM: 'vscode' }))).toBe('VS Code integrated terminal')
    expect(detectTerminal(envOf({ ITERM_SESSION_ID: 'w0t0p0' }))).toBe('iTerm2')
  })

  test('names no terminal for one the environment does not tell, and not Apple Terminal, whose identifier is unverified', () => {
    expect(detectTerminal(envOf({}))).toBeUndefined()
    expect(detectTerminal(envOf({ TERM_PROGRAM: 'Apple_Terminal' }))).toBeUndefined()
    expect(detectTerminal(envOf({ WT_SESSION: '' }))).toBeUndefined()
  })

  test('reads a multiplexer apart from the terminal under it', () => {
    const env = envOf({ WT_SESSION: 'abc', TMUX: '/tmp/tmux-1000/default,1,0' })

    expect(detectTerminal(env)).toBe('Windows Terminal')
    expect(detectHost(env)).toBe('tmux')
    expect(detectHost(envOf({ STY: '123.pts-0' }))).toBe('GNU screen')
    expect(detectHost(envOf({}))).toBeUndefined()
  })

  test('reads the system from the environment, and says none when it cannot', () => {
    expect(detectOs(envOf({ OS: 'Windows_NT' }))).toBe('windows')
    expect(detectOs(envOf({ HOME: '/Users/someone' }))).toBe('macos')
    expect(detectOs(envOf({ HOME: '/home/someone' }))).toBe('linux')
    expect(detectOs(envOf({ HOME: '/var/empty' }))).toBeUndefined()
  })
})

describe('recommending', () => {
  test('names terminals with at least two of images, mouse and links marked yes, best first', () => {
    const windows = recommended('windows').map(row => row.name)

    expect(windows.length).toBeGreaterThan(0)
    expect(windows).not.toContain('Ghostty')
    for (const row of recommended('windows')) {
      const yes = [row.images, row.mouse, row.links].filter(cell => cell.value === 'yes').length
      expect(yes).toBeGreaterThanOrEqual(2)
    }
  })

  test('each system has its own table and recommendations, and none lists a host', () => {
    for (const os of ['windows', 'macos', 'linux'] as const) {
      expect(tableFor(os).length).toBeGreaterThan(0)
      expect(recommended(os).every(row => row.os === os)).toBe(true)
    }
  })

  test('what a terminal lacks is said, with the terminals of the system that have it', () => {
    const conhost = rowFor('Windows console host (conhost)', 'windows')
    expect(conhost).toBeDefined()

    const lines = gaps(conhost as NonNullable<typeof conhost>, 'windows')

    expect(lines.some(line => /^Mouse reporting: not verified/.test(line))).toBe(true)
    expect(lines.some(line => /On Windows with it: .*Windows Terminal/.test(line))).toBe(true)
  })

  test('a terminal with all three has no gaps', () => {
    const kitty = rowFor('kitty', 'linux')
    expect(kitty).toBeDefined()

    expect(gaps(kitty as NonNullable<typeof kitty>, 'linux')).toEqual([])
  })

  test('values have their tones', () => {
    expect(toneOfValue('yes')).toBe('success')
    expect(toneOfValue('partial')).toBe('warning')
    expect(toneOfValue('no')).toBe('danger')
    expect(toneOfValue('unknown')).toBe('neutral')
  })
})

describe('where the diagram is drawn as pixels', () => {
  test('only in terminals the research file marks yes for images, and the platform names', () => {
    for (const name of PIXEL_TERMINALS) {
      const rows = TERMINALS.filter(row => row.name === name && row.os !== 'windows')

      expect(rows.length, `no row for ${name}`).toBeGreaterThan(0)
      expect(rows.every(row => row.images.value === 'yes')).toBe(true)
    }
  })

  test('kitty and Ghostty, and not inside tmux or screen, nor any other terminal', () => {
    expect(drawsPixels(envOf({ KITTY_WINDOW_ID: '1' }))).toBe(true)
    expect(drawsPixels(envOf({ TERM_PROGRAM: 'ghostty' }))).toBe(true)
    expect(drawsPixels(envOf({ KITTY_WINDOW_ID: '1', TMUX: '/tmp/t,1,0' }))).toBe(false)
    expect(drawsPixels(envOf({ KITTY_WINDOW_ID: '1', STY: '1.pts-0' }))).toBe(false)
    // sixel is something the Image does not draw, so a terminal that has only that is not named
    expect(drawsPixels(envOf({ WT_SESSION: 'x' }))).toBe(false)
    expect(drawsPixels(envOf({ TERM_PROGRAM: 'WezTerm' }))).toBe(false)
    expect(drawsPixels(envOf({}))).toBe(false)
  })
})