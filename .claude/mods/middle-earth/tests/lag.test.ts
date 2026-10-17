import { describe, expect, mock, test } from 'claude-code/testing'

import { installedOf, lagText } from '../hooks/lag'

const CWD = '/proj'
const CACHE = '/home/q/.claude/plugins/cache/middle-earth'
// As the record stood on 2026-10-16: anduril copied on the 14th, bombadil gone from the marketplace since f470415
const INSTALLED = JSON.stringify({
  version: 2,
  plugins: {
    'anduril@middle-earth': [{ installPath: `${CACHE}/anduril/0.1.0` }],
    'bombadil@middle-earth': [{ installPath: `${CACHE}/bombadil/0.1.0` }],
    'middle-earth@middle-earth': [{ installPath: `${CACHE}/middle-earth/0.1.0` }],
    'status-line@status-line-mods': [{ installPath: '/elsewhere' }],
  },
})

describe('the plugins installed from the marketplace', () => {
  test('are read from the install record, and nothing else is', () => {
    expect(installedOf(INSTALLED).map(one => one.id)).toEqual(['anduril@middle-earth', 'bombadil@middle-earth', 'middle-earth@middle-earth'])
    for (const text of ['', 'not json', 'null', '[]']) expect(installedOf(text)).toEqual([])
  })

  test('that lag are said with how each is brought level', () => {
    const text = lagText([
      { plugin: 'bombadil@middle-earth', why: 'gone', installed: '' },
      { plugin: 'anduril@middle-earth', why: 'behind', installed: `${CACHE}/anduril/0.1.0` },
    ])

    expect(text).toMatch(/- bombadil@middle-earth: installed, but no longer in \.claude\/mods\. Uninstall it \(claude plugin uninstall bombadil@middle-earth\)/)
    expect(text).toMatch(/- anduril@middle-earth: its installed copy .* differs from \.claude\/mods\. \/reload-plugins reads it afresh/)
  })

  test('lag when gone from the folder, or copied from code it no longer holds, and are said once the session starts', async ($, on) => {
    const toasts: string[] = []
    const store: Record<string, unknown> = {}
    mock.clock(on, { now: 1_800_000_000_000 })

    on('store.get', (_, e) => ({ value: store[(e as unknown as { key: string }).key] }) as never)
    on('store.set', () => ({ value: undefined }) as never)
    on('store.keys', () => ({ value: [] }) as never)
    on('command.register', () => ({ value: undefined }) as never)
    on('agent.register', () => ({ value: { agent: 'middle-earth:planner' } }) as never)
    on('agent.list', () => ({ value: [] }) as never)
    on('tool.register', () => ({ value: undefined }) as never)
    on('session.start', () => ({ cwd: CWD }) as never)
    on('session.cwd', () => ({ value: CWD }) as never)
    on('ui.open', () => ({ value: { isPlaced: true } }) as never)
    on('ui.toast', (_, e) => {
      toasts.push(String((e as unknown as { text?: string }).text ?? e))

      return { value: undefined } as never
    })
    on('fs.read', (_, e) => {
      if (e.path.endsWith('/plugins/installed_plugins.json')) return { value: INSTALLED } as never
      if (e.path === `${CWD}/.claude/mods/anduril/.claude-plugin/plugin.json` || e.path === `${CWD}/.claude/mods/middle-earth/.claude-plugin/plugin.json`) return { value: '{}' } as never

      throw new Error(`ENOENT: ${e.path}`)
    })
    on('process.run', (_, e) => {
      const line = e.argv.join(' ')
      const answer = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as never

      if (line === 'git rev-parse --show-toplevel') return answer(`${CWD}\n`)
      // anduril's copy differs from its folder; middle-earth's is the same
      if (line === `diff -rq ${CACHE}/anduril/0.1.0/hooks ${CWD}/.claude/mods/anduril/hooks`) return answer('Files differ\n', 1)

      return answer('')
    })

    await $.session.start({ source: 'startup', cwd: CWD } as never)

    // middle-earth's copy is its folder's: only anduril, behind, and bombadil, gone, are said (what Claude is told of
    // each is lagText's, above)
    expect(toasts).toContain('Middle-earth: anduril, bombadil lag .claude/mods')
  })
})
