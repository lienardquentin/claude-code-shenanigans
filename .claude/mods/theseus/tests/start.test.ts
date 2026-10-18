import { describe, expect, mock } from 'claude-code/testing'
import { test } from './hook-test'

const CWD = '/proj'

describe('the session start', () => {
  test('starts every part, and says the one whose command the host refuses', async ($, on) => {
    const toasts: string[] = []
    const tools: string[] = []
    const commands: string[] = []
    mock.clock(on, { now: 1_800_000_000_000 })

    on('store.get', () => ({ value: undefined }) as never)
    on('store.set', () => ({ value: undefined }) as never)
    on('store.keys', () => ({ value: [] }) as never)
    on('env.get', () => ({ value: undefined }) as never)
    on('fs.exists', () => ({ value: false }) as never)
    // A name the host holds, as it held /verify on 2026-10-18
    on('command.register', (_, e) => {
      const name = String((e as unknown as { name: string }).name)

      if (name === 'checks') throw new Error('$.command.register: "/checks" refused: it is the built-in /checks')
      commands.push(name)

      return { value: undefined } as never
    })
    on('agent.register', () => ({ value: { agent: 'theseus:planner' } }) as never)
    on('agent.list', () => ({ value: [] }) as never)
    on('tool.register', (_, e) => {
      tools.push(String((e as unknown as { name: string }).name))

      return { value: undefined } as never
    })
    on('session.start', () => ({ cwd: CWD }) as never)
    on('session.cwd', () => ({ value: CWD }) as never)
    on('ui.open', () => ({ value: { isPlaced: true } }) as never)
    on('ui.toast', (_, e) => {
      toasts.push(String((e as unknown as { text?: string }).text ?? e))

      return { value: undefined } as never
    })
    on('fs.read', (_, e) => {
      throw new Error(`ENOENT: ${e.path}`)
    })
    on('process.run', (_, e) => {
      const answer = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as never

      return answer(e.argv.join(' ') === 'git rev-parse --show-toplevel' ? `${CWD}\n` : '')
    })

    await $.session.start({ source: 'startup', cwd: CWD } as never)

    // the parts after verify started all the same: the build's, the cleanup's
    expect(tools).toEqual(expect.arrayContaining(['start_run', 'leftovers']))
    expect(commands).toEqual(expect.arrayContaining(['build', 'follow-up', 'cleanup', 'issues']))
    expect(toasts.filter(toast => toast.startsWith('Theseus: '))).toEqual([expect.stringMatching(/^Theseus: verify failed: /)])
  })
})
