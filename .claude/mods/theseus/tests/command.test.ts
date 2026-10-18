import { describe, expect, mock } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import { test } from './hook-test'

const CWD = '/proj'

/** A session with nothing under way: no run, no plan, no project file. */
const started = (body: (...args: Parameters<TestBody>) => Promise<void>, failing: Record<string, string> = {}): TestBody => async ($, on) => {
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
  on('process.run', (_, e) => {
    const line = e.argv.join(' ')

    return { value: { exitCode: line in failing ? 1 : 0, stdout: line === 'git rev-parse --show-toplevel' ? `${CWD}\n` : line === `git -C ${CWD} remote get-url origin` ? 'git@github.com:o/r.git\n' : '', stderr: failing[line] ?? '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })

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
      expect(await run($, 'theseus', 'cleanup')).toMatch(/Asking the forge again: the cleanup pane shows its answer\.$/)
    }),
  )

  test(
    'is the one command: the seven it replaced are gone',
    started(async $ => {
      await expect($.command.run({ command: 'cleanup', args: '' } as never)).rejects.toThrow()
    }),
  )

  test(
    'doctor says what Theseus needs here, and build starts no run while something it needs is missing',
    started(
      async $ => {
        expect(await run($, 'theseus', 'doctor')).toMatch(/^Theseus is missing one thing it needs here[\s\S]*✗ gh sign-in: not logged in\n    gh auth login --hostname github\.com/)
        expect(await run($, 'theseus', 'build --auto')).toBe('Theseus cannot start a run here: gh sign-in (gh auth login --hostname github.com). /theseus doctor lists every check.')
      },
      { 'gh auth status --hostname github.com': 'not logged in' },
    ),
  )
})
