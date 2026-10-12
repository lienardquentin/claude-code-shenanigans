import { describe, expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import { mock } from 'claude-code/testing'

type On = Parameters<TestBody>[1]
type Engine = Parameters<TestBody>[0]

/** Stands for the session beneath the mod; a test reads back the text handed to the status call. */
const answerSession = (
  on: On,
  given: { cwd?: string; model?: string; percent?: number | undefined } = {},
) => {
  const clock = mock.clock(on, { now: 1000 })
  const session = {
    cwd: given.cwd ?? '/home/dev/claude',
    model: given.model ?? 'Opus 5.5',
    percent: 'percent' in given ? given.percent : 42,
  }
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
    /** What a person reads under the prompt now. */
    line: () => shown.at(-1),
  }
}

const starts = async ($: Engine) => {
  await $.session.start({ cwd: '/home/dev/claude' } as never)
}

const callsATool = async ($: Engine) => {
  await $.tool.call({ tool: 'Read', file_path: 'a.ts', tool_use_id: 'call-1' } as never)
}

const endsATurn = async ($: Engine) => {
  await $.turn.complete({ answer: 'Done.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never)
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
    await callsATool($)

    expect(host.line()).toBe('claude · Haiku 5 · 61%!')
  })

  test('follow the end of a turn', async ($, on) => {
    const host = answerSession(on)

    await starts($)
    host.session.percent = 90
    await endsATurn($)

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

    const first = callsATool($)

    await host.clock.settle()
    await callsATool($)
    host.hold.isHeld = false
    host.hold.release?.()
    await first

    expect(host.shown).toEqual(['claude · Opus 5.5 · 42%'])
  })
})
