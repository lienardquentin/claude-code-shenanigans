import { describe, expect, mock } from 'claude-code/testing'
import { test } from './hook-test'

import { installedOf, lagText } from '../hooks/lag'

const CWD = '/proj'
const CACHE = '/home/q/.claude/plugins/cache/pipeline'
// As the record stood on 2026-10-16: the recorder copied on the 14th, bombadil gone from the marketplace since f470415
const INSTALLED = JSON.stringify({
  version: 2,
  plugins: {
    'recorder@pipeline': [{ installPath: `${CACHE}/recorder/0.1.0` }],
    'bombadil@pipeline': [{ installPath: `${CACHE}/bombadil/0.1.0` }],
    'pipeline@pipeline': [{ installPath: `${CACHE}/pipeline/0.1.0` }],
    'status-line@status-line-mods': [{ installPath: '/elsewhere' }],
  },
})

describe('the plugins installed from the marketplace', () => {
  test('are read from the install record, and nothing else is', () => {
    expect(installedOf(INSTALLED).map(one => one.id)).toEqual(['recorder@pipeline', 'bombadil@pipeline', 'pipeline@pipeline'])
    for (const text of ['', 'not json', 'null', '[]']) expect(installedOf(text)).toEqual([])
  })

  test('that lag are said with how each is brought level', () => {
    const text = lagText([
      { plugin: 'bombadil@pipeline', why: 'gone', installed: '' },
      { plugin: 'recorder@pipeline', why: 'behind', installed: `${CACHE}/recorder/0.1.0` },
    ])

    expect(text).toMatch(/- bombadil@pipeline: installed, but no longer in \.claude\/mods\. Uninstall it \(claude plugin uninstall bombadil@pipeline\)/)
    expect(text).toMatch(/- recorder@pipeline: its installed copy .* differs from \.claude\/mods\. \/reload-plugins reads it afresh/)
  })

  test('lag when gone from the folder, or copied from code it no longer holds, and are said once the session starts', async ($, on) => {
    const toasts: string[] = []
    const store: Record<string, unknown> = {}
    mock.clock(on, { now: 1_800_000_000_000 })

    on('store.get', (_, e) => ({ value: store[(e as unknown as { key: string }).key] }) as never)
    on('store.set', () => ({ value: undefined }) as never)
    on('store.keys', () => ({ value: [] }) as never)
    on('command.register', () => ({ value: undefined }) as never)
    on('agent.register', () => ({ value: { agent: 'pipeline:planner' } }) as never)
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
      if (e.path === `${CWD}/.claude/mods/recorder/.claude-plugin/plugin.json` || e.path === `${CWD}/.claude/mods/pipeline/.claude-plugin/plugin.json`) return { value: '{}' } as never

      throw new Error(`ENOENT: ${e.path}`)
    })
    on('process.run', (_, e) => {
      const line = e.argv.join(' ')
      const answer = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as never

      if (line === 'git rev-parse --show-toplevel') return answer(`${CWD}\n`)
      // the recorder's copy differs from its folder; the pipeline's is the same
      if (line === `diff -rq ${CACHE}/recorder/0.1.0/hooks ${CWD}/.claude/mods/recorder/hooks`) return answer('Files differ\n', 1)

      return answer('')
    })

    await $.session.start({ source: 'startup', cwd: CWD } as never)

    // the pipeline's copy is its folder's: only the recorder, behind, and bombadil, gone, are said (what Claude is told of
    // each is lagText's, above)
    expect(toasts).toContain('Pipeline: recorder, bombadil lag .claude/mods')
  })
})
