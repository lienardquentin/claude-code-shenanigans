import { describe, expect, mock } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import { test } from './hook-test'

const CWD = '/proj'

/** A session with nothing under way: no run, no plan, no project file. */
const started = (body: (...args: Parameters<TestBody>) => Promise<void>): TestBody => async ($, on) => {
  mock.clock(on, { now: 1_800_000_000_000 })
  on('store.get', () => ({ value: undefined }) as never)
  on('store.set', () => ({ value: undefined }) as never)
  on('store.keys', () => ({ value: [] }) as never)
  on('env.get', () => ({ value: undefined }) as never)
  on('fs.exists', () => ({ value: false }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('agent.register', () => ({ value: { agent: 'theseus:planner' } }) as never)
  on('agent.list', () => ({ value: [] }) as never)
  on('tool.register', () => ({ value: undefined }) as never)
  on('session.start', () => ({ cwd: CWD }) as never)
  on('session.cwd', () => ({ value: CWD }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('fs.read', (_, e) => {
    throw new Error(`ENOENT: ${e.path}`)
  })
  on('process.run', (_, e) => ({ value: { exitCode: 0, stdout: e.argv.join(' ') === 'git rev-parse --show-toplevel' ? `${CWD}\n` : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as never)

  await $.session.start({ source: 'startup', cwd: CWD } as never)
  await body($, on)
}

const run = async ($: Parameters<TestBody>[0], command: string, args: string): Promise<string> => String((await $.command.run({ command, args } as never)).text)

describe('/theseus', () => {
  test(
    'alone says what is under way, and where the verbs are listed',
    started(async $ => {
      expect(await run($, 'theseus', '')).toBe('No run is under way.\n\n/theseus help lists what it does.')
    }),
  )

  test(
    'help lists every verb, each with what it does',
    started(async $ => {
      const help = await run($, 'theseus', 'help')

      for (const verb of ['plan <issue | idea>', 'build [--auto]', 'tests [<behaviour>]', 'verify', 'follow-up <pr>', 'cleanup [clean', 'issues', 'troubles', 'help']) expect(help).toContain(`/theseus ${verb}`)
    }),
  )

  test(
    'answers a verb it does not know with the help, never a guess',
    started(async $ => {
      expect(await run($, 'theseus', 'bulid --auto')).toMatch(/^\/theseus does not know bulid\.\n\nTheseus takes an issue to a reviewed pull request\./)
    }),
  )

  test(
    'hands a verb to the part that answers it',
    started(async $ => {
      expect(await run($, 'theseus', 'cleanup')).toMatch(/Looking again: the pane says what the forge answers\.$/)
    }),
  )

  test(
    'keeps the commands it had before for one release, each saying its new spelling',
    started(async $ => {
      expect(await run($, 'cleanup', '')).toMatch(/^\/cleanup is \/theseus cleanup now\.\n\n[\s\S]*Looking again/)
      expect(await run($, 'checks', '')).toMatch(/^\/checks is \/theseus verify now\./)
    }),
  )
})
