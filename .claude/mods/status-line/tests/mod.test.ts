import { describe, expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import { mock } from 'claude-code/testing'

type On = Parameters<TestBody>[1]
type Engine = Parameters<TestBody>[0]

type GitAnswer = { exitCode: number; stdout: string } | { fails: string }
type GitRun = { argv: readonly string[]; cwd?: string; timeoutMs?: number }

/** The output of `git status --porcelain=v2 --branch` on a branch, with the given entry lines. */
const statusOf = (head: string, ...entries: string[]) =>
  [`# branch.oid ${'a1b2c3d4e5f6'.padEnd(40, '0')}`, `# branch.head ${head}`, '# branch.upstream origin/main', '# branch.ab +1 -2', ...entries, ''].join('\n')

/** Stands for the session beneath the mod; a test reads back the text handed to the status call. */
const answerSession = (
  on: On,
  given: { cwd?: string; model?: string; percent?: number | undefined; columns?: number | undefined } = {},
) => {
  const clock = mock.clock(on, { now: 1000 })
  const session: { cwd: string; model: string; percent: number | undefined; columns: number | undefined } = {
    cwd: given.cwd ?? '/home/dev/claude',
    model: given.model ?? 'Opus 5.5',
    percent: 'percent' in given ? given.percent : 42,
    columns: given.columns,
  }
  // The engine's own drawing of a reply, which the mod only reads the width from
  on('ui.render', { component: 'AssistantMessage' } as never, () => ({ type: 'Text', props: {}, children: [''] }) as never)
  const shown: (string | undefined)[] = []
  // How long the next read of the usage figures takes to answer: a test holds it to overlap two redraws
  const hold: { release?: () => void; isHeld: boolean } = { isHeld: false }

  on('session.cwd', () => ({ value: session.cwd }) as never)
  on('session.model', () => ({ value: session.model }) as never)
  on('session.usage', async () => {
    if (hold.isHeld) await new Promise<void>(resolve => (hold.release = resolve))

    return {
      value: {
        startedAt: 0,
        context: { window: 200000, tokens: 0, ...(session.percent !== undefined ? { percent: session.percent } : {}) },
        rateLimits: [],
      },
    } as never
  })
  // What `git` answers: a stub that fails like a repo-less folder until a test gives it output
  const git: { answer: GitAnswer; runs: GitRun[] } = { answer: { exitCode: 128, stdout: '' }, runs: [] }

  on('process.run', (_, e) => {
    git.runs.push({ argv: e.argv, cwd: e.init?.cwd, timeoutMs: e.init?.timeoutMs })

    if ('fails' in git.answer) throw new Error(git.answer.fails)

    return { value: { exitCode: git.answer.exitCode, stdout: git.answer.stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
  on('ui.status', (_, e) => {
    shown.push(e.text)

    return { value: undefined } as never
  })
  on('session.start', () => ({ cwd: session.cwd }) as never)
  on('tool.call', () => ({ result: '', text: '' }) as never)
  on('turn.complete', (_, e) => ({ text: e.answer }) as never)

  return {
    clock,
    session,
    shown,
    hold,
    git,
    /** What a person reads under the prompt now. */
    line: () => shown.at(-1),
  }
}

// A reply drawn in a terminal of the given width: the only place the engine tells a hook how wide it is
const rendersAReply = async ($: Engine, host: Host, columns: number) => {
  host.session.columns = columns
  const row = await $.ui.mount({
    plugin: 'status-line',
    surface: 'terminal',
    component: 'AssistantMessage',
    props: { text: 'Hi', isFirstOfReply: true } as never,
    requestId: 'message-1',
    viewport: { columns, rows: 24, isFullscreen: false },
  } as never)

  await host.clock.settle()
  await row.unmount()
}

const starts = async ($: Engine) => {
  await $.session.start({ cwd: '/home/dev/claude' } as never)
}



// The redraw runs after the tool call has returned, so a test lets it finish before it reads the line
type Host = ReturnType<typeof answerSession>

const callsATool = async ($: Engine, host: Host) => {
  await $.tool.call({ tool: 'Read', file_path: 'a.ts', tool_use_id: 'call-1' } as never)
  await host.clock.settle()
}

const endsATurn = async ($: Engine, host: Host) => {
  await $.turn.complete({ answer: 'Done.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never)
  await host.clock.settle()
}

describe('the status line at session start', () => {
  test('shows the folder, the model and the context fill, in that order', async ($, on) => {
    const host = answerSession(on)

    await starts($)

    expect(host.line()).toBe('claude · Opus 5.5 · 42%')
  })

  test('takes the folder from a path written with slashes', async ($, on) => {
    const host = answerSession(on, { cwd: 'C:/Users/dev/shop' })

    await starts($)

    expect(host.line()).toBe('shop · Opus 5.5 · 42%')
  })

  test('takes the folder from a path written with backslashes, a trailing one included', async ($, on) => {
    const host = answerSession(on, { cwd: 'C:\\Users\\dev\\shop\\' })

    await starts($)

    expect(host.line()).toBe('shop · Opus 5.5 · 42%')
  })

  test('gives the model unchanged', async ($, on) => {
    const host = answerSession(on, { model: 'Sonnet 5.5 (1M context)' })

    await starts($)

    expect(host.line()).toBe('claude · Sonnet 5.5 (1M context) · 42%')
  })

  test('leaves the context fill out until the engine has a percentage, with its separator', async ($, on) => {
    const host = answerSession(on, { percent: undefined })

    await starts($)

    expect(host.line()).toBe('claude · Opus 5.5')
  })

  test('leaves out a model that is empty', async ($, on) => {
    const host = answerSession(on, { model: '' })

    await starts($)

    expect(host.line()).toBe('claude · 42%')
  })

  test('leaves out a folder that is empty', async ($, on) => {
    const host = answerSession(on, { cwd: '' })

    await starts($)

    expect(host.line()).toBe('Opus 5.5 · 42%')
  })

  test('clears the status text when no segment has anything to say', async ($, on) => {
    const host = answerSession(on, { cwd: '', model: '', percent: undefined })

    await starts($)

    expect(host.shown).toEqual([undefined])
  })
})

describe('the context fill', () => {
  for (const [percent, text] of [
    [0, '0%'],
    [59, '59%'],
    [60, '60%!'],
    [84, '84%!'],
    [85, '85%!!'],
    [100, '100%!!'],
  ] as const) {
    test(`at ${percent} reads ${text}`, async ($, on) => {
      const host = answerSession(on, { percent })

      await starts($)

      expect(host.line()).toBe(`claude · Opus 5.5 · ${text}`)
    })
  }

  test('is a whole number', async ($, on) => {
    const host = answerSession(on, { percent: 41.6 })

    await starts($)

    expect(host.line()).toBe('claude · Opus 5.5 · 42%')
  })
})

describe('the redraws', () => {
  test('follow a tool call', async ($, on) => {
    const host = answerSession(on)

    await starts($)
    host.session.percent = 61
    host.session.model = 'Haiku 5'
    await callsATool($, host)

    expect(host.line()).toBe('claude · Haiku 5 · 61%!')
  })

  test('follow the end of a turn', async ($, on) => {
    const host = answerSession(on)

    await starts($)
    host.session.percent = 90
    await endsATurn($, host)

    expect(host.line()).toBe('claude · Opus 5.5 · 90%!!')
  })

  test('come every 10 seconds, and not before', async ($, on) => {
    const host = answerSession(on)

    await starts($)
    host.session.percent = 70
    await host.clock.advance(9_999)

    expect(host.line()).toBe('claude · Opus 5.5 · 42%')

    await host.clock.advance(1)

    expect(host.line()).toBe('claude · Opus 5.5 · 70%!')

    host.session.cwd = '/home/dev/other'
    await host.clock.advance(10_000)

    expect(host.line()).toBe('other · Opus 5.5 · 70%!')
  })

  test('skip a redraw that would start while another is still running', async ($, on) => {
    const host = answerSession(on)

    await starts($)
    host.shown.length = 0
    host.hold.isHeld = true

    await $.tool.call({ tool: 'Read', file_path: 'a.ts', tool_use_id: 'call-1' } as never)
    await host.clock.settle()
    await callsATool($, host)
    host.hold.isHeld = false
    host.hold.release?.()
    await host.clock.settle()

    expect(host.shown).toEqual(['claude · Opus 5.5 · 42%'])
  })
})

describe('a narrow terminal', () => {
  // 'claude · main · Opus 5.5 · 42%' is 30 columns
  const full = async ($: Engine, columns: number | undefined, on: On, given: Parameters<typeof answerSession>[1] = {}) => {
    const host = answerSession(on, given)

    host.git.answer = { exitCode: 0, stdout: statusOf('main') }
    if (columns !== undefined) await rendersAReply($, host, columns)

    return host
  }

  for (const [columns, text] of [
    [80, 'claude · main · Opus 5.5 · 42%'],
    [30, 'claude · main · Opus 5.5 · 42%'],
    [29, 'claude · main · 42%'],
    [19, 'claude · main · 42%'],
    [18, 'claude · 42%'],
    [12, 'claude · 42%'],
    [11, '42%'],
    [3, '42%'],
    [1, '42%'],
  ] as const) {
    test(`at ${columns} columns reads ${text}`, async ($, on) => {
      const host = await full($, columns, on)

      await starts($)

      expect(host.line()).toBe(text)
    })
  }

  test('follows the width at each redraw', async ($, on) => {
    const host = await full($, 29, on)

    await starts($)
    await rendersAReply($, host, 80)
    await callsATool($, host)

    expect(host.line()).toBe('claude · main · Opus 5.5 · 42%')
  })

  test('skips a branch and a model that are already absent', async ($, on) => {
    const host = answerSession(on, { model: '' })

    await rendersAReply($, host, 8)
    await starts($)

    expect(host.line()).toBe('42%')
  })

  test('skips a model that is absent before dropping the branch', async ($, on) => {
    const host = answerSession(on, { model: '' })

    host.git.answer = { exitCode: 0, stdout: statusOf('main') }
    await rendersAReply($, host, 19)
    await starts($)

    expect(host.line()).toBe('claude · main · 42%')
  })

  test('pins the full line when the width is not known', async ($, on) => {
    const host = await full($, undefined, on)

    await starts($)

    expect(host.line()).toBe('claude · main · Opus 5.5 · 42%')
  })
})

describe('the git branch', () => {
  const branchLine = (name: string) => `claude · ${name} · Opus 5.5 · 42%`

  test('is asked once per redraw, in the session folder, with a 2-second limit', async ($, on) => {
    const host = answerSession(on)

    host.git.answer = { exitCode: 0, stdout: statusOf('main') }
    await starts($)

    expect(host.git.runs).toEqual([{ argv: ['git', 'status', '--porcelain=v2', '--branch'], cwd: '/home/dev/claude', timeoutMs: 2000 }])
  })

  test('shows the name between the folder and the model on a clean tree', async ($, on) => {
    const host = answerSession(on)

    host.git.answer = { exitCode: 0, stdout: statusOf('main') }
    await starts($)

    expect(host.line()).toBe(branchLine('main'))
  })

  test('adds * when an entry line is there', async ($, on) => {
    const host = answerSession(on)

    host.git.answer = { exitCode: 0, stdout: statusOf('main', '1 .M N... 100644 100644 100644 abc def src/a.ts') }
    await starts($)

    expect(host.line()).toBe(branchLine('main*'))
  })

  test('adds * for untracked files alone', async ($, on) => {
    const host = answerSession(on)

    host.git.answer = { exitCode: 0, stdout: statusOf('main', '? notes.md') }
    await starts($)

    expect(host.line()).toBe(branchLine('main*'))
  })

  test('shows the first 7 characters of the commit on a detached HEAD', async ($, on) => {
    const host = answerSession(on)

    host.git.answer = { exitCode: 0, stdout: statusOf('(detached)') }
    await starts($)

    expect(host.line()).toBe(branchLine('a1b2c3d'))
  })

  test('shows a name of 32 characters whole', async ($, on) => {
    const host = answerSession(on)
    const name = 'feature/'.padEnd(32, 'x')

    host.git.answer = { exitCode: 0, stdout: statusOf(name) }
    await starts($)

    expect(host.line()).toBe(branchLine(name))
  })

  test('cuts a name of 33 characters to its first 16, an ellipsis and its last 15', async ($, on) => {
    const host = answerSession(on)
    const name = `${'a'.repeat(16)}${'m'}${'z'.repeat(16)}`

    host.git.answer = { exitCode: 0, stdout: statusOf(name) }
    await starts($)

    expect(name).toHaveLength(33)
    expect(host.line()).toBe(branchLine(`${'a'.repeat(16)}…${'z'.repeat(15)}`))
  })

  test('puts * after a cut name, outside the 32', async ($, on) => {
    const host = answerSession(on)
    const name = 'b'.repeat(40)

    host.git.answer = { exitCode: 0, stdout: statusOf(name, '? x') }
    await starts($)

    expect(host.line()).toBe(branchLine(`${'b'.repeat(16)}…${'b'.repeat(15)}*`))
  })

  for (const [what, answer] of [
    ['a non-zero exit', { exitCode: 128, stdout: '' }],
    ['a timeout', { fails: 'timed out after 2000 ms' }],
    ['a process that cannot start', { fails: 'spawn git ENOENT' }],
    ['output with no branch.head header', { exitCode: 0, stdout: '# branch.oid abc\n' }],
  ] as const) {
    test(`leaves the segment out, with no doubled separator, on ${what}`, async ($, on) => {
      const host = answerSession(on)

      host.git.answer = answer
      await starts($)

      expect(host.shown).toEqual(['claude · Opus 5.5 · 42%'])
    })
  }

  test('comes back on the next redraw whose git call succeeds', async ($, on) => {
    const host = answerSession(on)

    host.git.answer = { fails: 'timed out' }
    await starts($)
    expect(host.line()).toBe('claude · Opus 5.5 · 42%')

    host.git.answer = { exitCode: 0, stdout: statusOf('main') }
    await callsATool($, host)

    expect(host.line()).toBe(branchLine('main'))
  })

  test('follows a branch switched outside the session after 10 seconds', async ($, on) => {
    const host = answerSession(on)

    host.git.answer = { exitCode: 0, stdout: statusOf('main') }
    await starts($)
    host.git.answer = { exitCode: 0, stdout: statusOf('other') }
    await host.clock.advance(10_000)

    expect(host.line()).toBe(branchLine('other'))
  })
})
