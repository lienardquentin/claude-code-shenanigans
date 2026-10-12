import { describe, expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

type Engine = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

const PANE = { bodyColumns: 100 } as const

const mountPane = ($: Engine) =>
  $.ui.mount({ plugin: 'termaid-view', surface: 'terminal', component: 'Pane', props: PANE as never, requestId: 'termaid-view' })

const termaid = async ($: Engine) => (await $.command.run({ command: 'termaid' } as never)).text ?? ''

const fence = (source: string, language = 'mermaid') => `\`\`\`${language}\n${source}\n\`\`\``

const reply = (text: string) => ({ role: 'assistant', text, toolUses: [] })

// Stands for the engine's transcript: what the main conversation holds, and what a subagent's does
const conversation = (on: On, main: ReturnType<typeof reply>[], sub: ReturnType<typeof reply>[] = []) => {
  const held = { main }

  // Stands for the engine ending a turn
  on('turn.complete', (_, e) => ({ text: e.answer }) as never)

  on('session.messages', (_, e) => ({ value: (e as { agentId?: string }).agentId === undefined ? held.main : sub }) as never)

  return held
}

// The pane can be placed; the ids it was asked to open are kept
const answerOpen = (on: On) => {
  const opened: string[] = []

  on('ui.open', (_, e) => {
    opened.push(e.id)

    return { value: { isPlaced: true } } as never
  })

  return opened
}

type Run = { argv: readonly string[]; stdin?: string; timeoutMs?: number; env?: Record<string, string> }

// Stands for `uvx`: every run is kept, and prints the box `out` makes of the input
const answerUvx = (on: On, out: (stdin: string) => string = stdin => `[ ${stdin} ]`) => {
  const runs: Run[] = []

  on('process.run', (_, e) => {
    runs.push({ argv: e.argv, stdin: e.init?.stdin, timeoutMs: e.init?.timeoutMs, env: e.init?.env })

    return { value: { exitCode: 0, stdout: out(e.init?.stdin ?? ''), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })

  return runs
}

const settle = () => new Promise<void>(resolve => setTimeout(resolve, 50))

const ends = ($: Engine, agentId?: string) =>
  $.turn.complete({ answer: 'Done.', durationMs: 1, isAborted: false, turnId: 't1', agentId, reason: 'answer' } as never)

describe('termaid-view', () => {
  test('/termaid opens the pane, and nothing else does', async ($, on) => {
    conversation(on, [reply(fence('graph TD\n  A --> B'))])
    const opened = answerOpen(on)

    await ends($)
    expect(opened).toEqual([])

    await termaid($)
    expect(opened).toEqual(['termaid-view'])
  })

  test('opens on the most recent diagram as source, with its position and the total', async ($, on) => {
    conversation(on, [
      reply(`First:\n${fence('graph TD\n  A --> B')}`),
      reply(`Second:\n${fence('sequenceDiagram\n  Alice->>Bob: Hi')}\nand\n${fence('pie\n  "a" : 1')}`),
    ])
    answerOpen(on)
    answerUvx(on)

    await termaid($)
    const pane = await mountPane($)
    await settle()

    expect(await pane.find({ text: /3 of 3/ })).toBeDefined()
    expect(await pane.find({ type: 'Code' })).toBeDefined()
    expect(await pane.find({ text: /pie/ })).toBeDefined()
    expect(await pane.find({ text: /sequenceDiagram/ })).toBeUndefined()
  })

  test('a reply with two diagrams yields two, in the order written; other languages yield none', async ($, on) => {
    conversation(on, [
      reply(`${fence('const a = 1', 'ts')}\n${fence('graph LR\n  X --> Y')}\n${fence('classDiagram\n  Animal <|-- Dog')}\n${fence('{}', 'json')}`),
    ])
    answerOpen(on)
    answerUvx(on)

    await termaid($)
    const pane = await mountPane($)
    await settle()

    expect(await pane.find({ text: /2 of 2/ })).toBeDefined()
    expect(await pane.find({ text: /classDiagram/ })).toBeDefined()
    expect(await pane.find({ text: /const a/ })).toBeUndefined()
  })

  test('a user message holding a Mermaid block is not a reply', async ($, on) => {
    conversation(on, [{ role: 'user', text: fence('graph TD\n  A --> B'), toolUses: [] } as never])
    answerOpen(on)

    await termaid($)
    const pane = await mountPane($)

    expect(await pane.find({ text: /No Mermaid diagram/ })).toBeDefined()
  })

  test('replies of a subagent yield no diagram', async ($, on) => {
    conversation(on, [reply('Nothing to draw.')], [reply(fence('graph TD\n  S --> T'))])
    answerOpen(on)

    await ends($, 'sub-1')
    await termaid($)
    const pane = await mountPane($)

    expect(await pane.find({ text: /No Mermaid diagram/ })).toBeDefined()
    expect(await pane.find({ text: /S --> T/ })).toBeUndefined()
  })

  test('a completed turn with a new diagram moves the open pane to it', async ($, on) => {
    const held = conversation(on, [reply(fence('graph TD\n  A --> B'))])
    answerOpen(on)
    answerUvx(on)

    await termaid($)
    const pane = await mountPane($)
    expect(await pane.find({ text: /1 of 1/ })).toBeDefined()

    held.main = [...held.main, reply(fence('stateDiagram-v2\n  [*] --> Idle'))]
    await ends($)
    await settle()

    expect(await pane.find({ text: /2 of 2/ })).toBeDefined()
    expect(await pane.find({ text: /stateDiagram-v2/ })).toBeDefined()
  })

  test('termaid is run without a shell, with the pinned package, the pane width and the source on stdin', async ($, on) => {
    conversation(on, [reply(fence('graph TD\n  A --> B'))])
    answerOpen(on)
    const runs = answerUvx(on)

    await termaid($)
    expect(runs).toEqual([])

    const pane = await mountPane($)
    await settle()

    expect(runs).toHaveLength(1)
    expect(runs[0]?.argv).toEqual(['uvx', expect.stringMatching(/^termaid==\d+\.\d+(\.\d+)?$/), '--width', '96'])
    expect(runs[0]?.stdin).toBe('graph TD\n  A --> B')
    expect(runs[0]?.timeoutMs).toBe(60_000)
    // Without it, Python on Windows cannot write the drawing's box characters to a pipe
    expect(runs[0]?.env).toEqual({ PYTHONIOENCODING: 'utf-8' })
    expect(await pane.find({ type: 'Code' })).toBeDefined()
    expect(await pane.find({ text: /rendering/ })).toBeUndefined()
  })

  test('a rendering line shows while termaid runs', async ($, on) => {
    conversation(on, [reply(fence('graph TD\n  A --> B'))])
    answerOpen(on)
    on('process.run', async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 300))

      return { value: { exitCode: 0, stdout: 'drawn', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
    })

    await termaid($)
    const pane = await mountPane($)
    await settle()

    expect(await pane.find({ text: /rendering…/ })).toBeDefined()

    await new Promise<void>(resolve => setTimeout(resolve, 400))
    expect(await pane.find({ text: /drawn/ })).toBeDefined()
    expect(await pane.find({ text: /rendering…/ })).toBeUndefined()
  })

  test('the same diagram at the same width is not rendered again; another width renders again', async ($, on) => {
    conversation(on, [reply(fence('graph TD\n  A --> B'))])
    answerOpen(on)
    const runs = answerUvx(on)

    await termaid($)
    const first = await mountPane($)
    await settle()
    await first.unmount()
    const again = await mountPane($)
    await settle()
    await again.unmount()
    expect(runs).toHaveLength(1)

    await $.ui.mount({ plugin: 'termaid-view', surface: 'terminal', component: 'Pane', props: { bodyColumns: 60 } as never, requestId: 'termaid-view' })
    await settle()
    expect(runs).toHaveLength(2)
    expect(runs[1]?.argv.slice(-2)).toEqual(['--width', '56'])
  })

  test('a drawing wider than the pane is clipped, with a notice', async ($, on) => {
    conversation(on, [reply(fence('graph LR\n  A --> B'))])
    answerOpen(on)
    answerUvx(on, () => `${'X'.repeat(100)}Y${'X'.repeat(20)}\nshort`)

    await termaid($)
    const pane = await mountPane($)
    await settle()

    expect(await pane.find({ text: /wider than the pane/ })).toBeDefined()
    expect(await pane.find({ text: /Y/ })).toBeUndefined()
    expect(await pane.find({ text: /short/ })).toBeDefined()
  })

  test('a drawing that fits has no notice', async ($, on) => {
    conversation(on, [reply(fence('graph LR\n  A --> B'))])
    answerOpen(on)
    answerUvx(on, () => 'X'.repeat(96))

    await termaid($)
    const pane = await mountPane($)
    await settle()

    expect(await pane.find({ text: /wider than the pane/ })).toBeUndefined()
  })

  // Stands for `uvx` failing: `answer` is what the host does for each run
  const answerWith = (on: On, answer: (stdin: string) => unknown) => {
    const runs: Run[] = []

    on('process.run', (_, e) => {
      runs.push({ argv: e.argv, stdin: e.init?.stdin, timeoutMs: e.init?.timeoutMs })

      return answer(e.init?.stdin ?? '') as never
    })

    return runs
  }

  const exited = (exitCode: number, stdout: string, stderr: string) => ({
    value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
  })

  test('a non-zero exit shows the source and termaid\'s message from standard error', async ($, on) => {
    conversation(on, [reply(fence('graph TD\n  A --> B'))])
    answerOpen(on)
    answerWith(on, () => exited(2, 'ignored', 'Parse error on line 2'))

    await termaid($)
    const pane = await mountPane($)
    await settle()

    expect(await pane.find({ text: /Parse error on line 2/ })).toBeDefined()
    expect(await pane.find({ type: 'Code' })).toBeDefined()
    expect(await pane.find({ text: /A --> B/ })).toBeDefined()
    expect(await pane.find({ text: /rendering/ })).toBeUndefined()
  })

  test('a non-zero exit with nothing on standard error shows standard output', async ($, on) => {
    conversation(on, [reply(fence('graph TD\n  A --> B'))])
    answerOpen(on)
    answerWith(on, () => exited(1, 'Unsupported diagram type', ''))

    await termaid($)
    const pane = await mountPane($)
    await settle()

    expect(await pane.find({ text: /Unsupported diagram type/ })).toBeDefined()
  })

  test('a render that passes the timeout shows the source and says it timed out', async ($, on) => {
    conversation(on, [reply(fence('graph TD\n  A --> B'))])
    answerOpen(on)
    // The call is rejected (as the engine does when the child is still running at the timeout) once the clock
    // has moved past it
    let at = 0
    on('clock.now', () => ({ value: at }) as never)
    answerWith(on, () => {
      at = 61_000
      throw new Error('killed')
    })

    await termaid($)
    const pane = await mountPane($)
    await settle()

    expect(await pane.find({ text: /timed out/ })).toBeDefined()
    expect(await pane.find({ text: /A --> B/ })).toBeDefined()
    expect(await pane.find({ text: /rendering/ })).toBeUndefined()
  })

  test('a drawing the host refuses while the pane is still being drawn is written again, and shows', async ($, on) => {
    conversation(on, [reply(fence('graph TD\n  A --> B'))])
    answerOpen(on)
    answerUvx(on)
    // Stands for the host's check: a write made while `ui.render` is being dispatched is denied
    let refusals = -1
    on('state.set', (_, e, next) => {
      const write = e as { key?: string }
      if (write.key !== 'results' || refusals < 0 || refusals >= 2) return next(e)
      refusals++

      return { deny: 'it was made while ui.render is being dispatched, and drawing is pure' } as never
    })

    await termaid($)
    refusals = 0
    const pane = await mountPane($)
    await new Promise<void>(resolve => setTimeout(resolve, 400))

    expect(refusals).toBe(2)
    expect(await pane.find({ type: 'Code' })).toBeDefined()
    expect(await pane.find({ text: /rendering/ })).toBeUndefined()
  })

  test('when uvx cannot be started the pane says uv is missing, with the install command', async ($, on) => {
    conversation(on, [reply(fence('graph TD\n  A --> B'))])
    answerOpen(on)
    const runs = answerWith(on, () => ({ deny: 'spawn uvx ENOENT' }))

    await termaid($)
    const pane = await mountPane($)
    await settle()

    expect(await pane.find({ text: /uv is missing/ })).toBeDefined()
    expect(await pane.find({ text: /astral/ })).toBeDefined()
    expect(await pane.find({ text: /A --> B/ })).toBeDefined()
    expect(runs.every(run => run.argv[0] === 'uvx')).toBe(true)
  })

  test('a rejection that reads as a timeout is told so, even when the clock cannot say', async ($, on) => {
    conversation(on, [reply(fence('graph TD\n  A --> B'))])
    answerOpen(on)
    answerWith(on, () => ({ deny: 'Command timed out' }))

    await termaid($)
    const pane = await mountPane($)
    await settle()

    expect(await pane.find({ text: /timed out after 60 seconds/ })).toBeDefined()
    expect(await pane.find({ text: /uv is missing/ })).toBeUndefined()
  })

  test('any other rejection is shown with its own message, not as a missing uv', async ($, on) => {
    conversation(on, [reply(fence('graph TD\n  A --> B'))])
    answerOpen(on)
    answerWith(on, () => ({ deny: 'denied by a hook' }))

    await termaid($)
    const pane = await mountPane($)
    await settle()

    expect(await pane.find({ text: /denied by a hook/ })).toBeDefined()
    expect(await pane.find({ text: /uv is missing/ })).toBeUndefined()
    expect(await pane.find({ text: /A --> B/ })).toBeDefined()
  })

  test('a package that could not be fetched is said to be a download failure', async ($, on) => {
    conversation(on, [reply(fence('graph TD\n  A --> B'))])
    answerOpen(on)
    answerWith(on, () => exited(2, '', 'error: Failed to fetch: https://pypi.org/simple/termaid/'))

    await termaid($)
    const pane = await mountPane($)
    await settle()

    expect(await pane.find({ text: /could not be downloaded/ })).toBeDefined()
    expect(await pane.find({ text: /A --> B/ })).toBeDefined()
  })

  test('a failure is not retried at the same width; reopening the pane tries again', async ($, on) => {
    conversation(on, [reply(fence('graph TD\n  A --> B'))])
    answerOpen(on)
    const runs = answerWith(on, () => exited(1, '', 'bad'))

    await termaid($)
    const first = await mountPane($)
    await settle()
    await first.unmount()
    const again = await mountPane($)
    await settle()
    await again.unmount()
    expect(runs).toHaveLength(1)

    await termaid($)
    const reopened = await mountPane($)
    await settle()
    expect(runs).toHaveLength(2)
    expect(await reopened.find({ text: /bad/ })).toBeDefined()
  })

  test('the failure of one diagram does not affect another', async ($, on) => {
    const held = conversation(on, [reply(fence('graph TD\n  BAD'))])
    answerOpen(on)
    answerWith(on, stdin => (stdin.includes('BAD') ? exited(1, '', 'broken') : exited(0, 'DRAWN', '')))

    await termaid($)
    const pane = await mountPane($)
    await settle()
    expect(await pane.find({ text: /broken/ })).toBeDefined()

    held.main = [...held.main, reply(fence('graph TD\n  GOOD'))]
    await ends($)
    await settle()

    expect(await pane.find({ text: /DRAWN/ })).toBeDefined()
    expect(await pane.find({ text: /broken/ })).toBeUndefined()
  })

  const mountDesktop = ($: Engine) =>
    $.ui.mount({ plugin: 'termaid-view', surface: 'desktop', component: 'Pane', props: PANE as never, requestId: 'termaid-view' })

  // Stands for `node` running the Mermaid CLI: every run is kept, and prints the picture `out` makes of what it was given
  const answerNode = (
    on: On,
    out: (given: { source: string; theme: string }) => string = given => `<svg>${given.theme}: ${given.source}</svg>`,
  ) => {
    const runs: Run[] = []

    on('process.run', (_, e) => {
      runs.push({ argv: e.argv, stdin: e.init?.stdin, timeoutMs: e.init?.timeoutMs, env: e.init?.env })
      const given = JSON.parse(e.init?.stdin ?? '{}') as { source: string; theme: string }

      return { value: { exitCode: 0, stdout: JSON.stringify({ svg: out(given) }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
    })

    return runs
  }

  test('off the terminal the diagram is drawn as a picture by the Mermaid CLI, the diagram on standard input alone', async ($, on) => {
    conversation(on, [reply(fence('graph LR\n  A --> B'))])
    answerOpen(on)
    const runs = answerNode(on)

    await termaid($)
    const pane = await mountDesktop($)
    await settle()

    expect(runs).toHaveLength(1)
    expect(runs[0]?.argv[0]).toBe('node')
    expect(runs[0]?.argv.join(' ')).not.toMatch(/A --> B/)
    expect(JSON.parse(runs[0]?.stdin ?? '{}')).toMatchObject({
      // Laid out in the default direction, as in the terminal
      source: 'graph TD\n  A --> B',
      theme: 'default',
      background: 'white',
      version: expect.stringMatching(/^\d+\.\d+\.\d+$/),
    })
    expect(await pane.find({ type: 'Svg' })).toMatchObject({
      props: { source: '<svg>default: graph TD\n  A --> B</svg>', alt: 'Mermaid diagram: graph LR' },
    })
    expect(await pane.find({ text: /A --> B/ })).toBeUndefined()
  })

  test('off the terminal a diagram Mermaid cannot draw is shown as source with the reason', async ($, on) => {
    conversation(on, [reply(fence('graph TD\n  A --> B'))])
    answerOpen(on)
    answerWith(on, () => ({ value: { exitCode: 1, stdout: '', stderr: 'NO_BROWSER', isStdoutTruncated: false, isStderrTruncated: false } }))

    await termaid($)
    const pane = await mountDesktop($)
    await settle()

    expect(await pane.find({ type: 'Svg' })).toBeUndefined()
    expect(await pane.find({ text: /No Edge, Chrome or Chromium/ })).toBeDefined()
    expect(await pane.find({ text: /A --> B/ })).toBeDefined()
  })

  test('off the terminal Mermaid\'s own message is the reason, without the browser\'s stack under it', async ($, on) => {
    conversation(on, [reply(fence('graph TD\n  A --> B'))])
    answerOpen(on)
    const stderr = 'Error: Parse error on line 2:\nExpecting NODE_STRING, got LINK\nParser.parseError (https://x.invalid/mermaid.mjs:1561:21)\n    at parse (file:///x.mjs:1:1)'
    answerWith(on, () => ({ value: { exitCode: 1, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false } }))

    await termaid($)
    const pane = await mountDesktop($)
    await settle()

    expect(await pane.find({ text: /Parse error on line 2:\nExpecting NODE_STRING, got LINK$/ })).toBeDefined()
    expect(await pane.find({ text: /parseError/ })).toBeUndefined()
  })

  test('off the terminal a picture too long for the app is shown as source with the reason', async ($, on) => {
    conversation(on, [reply(fence('graph TD\n  A --> B'))])
    answerOpen(on)
    answerNode(on, () => `<svg>${'x'.repeat(131072)}</svg>`)

    await termaid($)
    const pane = await mountDesktop($)
    await settle()

    expect(await pane.find({ type: 'Svg' })).toBeUndefined()
    expect(await pane.find({ text: /too large to show/ })).toBeDefined()
    expect(await pane.find({ text: /A --> B/ })).toBeDefined()
  })

  test('off the terminal a command the host refuses is said as the reason', async ($, on) => {
    conversation(on, [reply(fence('graph TD\n  A --> B'))])
    answerOpen(on)
    answerWith(on, () => ({ deny: 'not available here' }))

    await termaid($)
    const pane = await mountDesktop($)
    await settle()

    expect(await pane.find({ text: /Mermaid could not be run: .*not available here/ })).toBeDefined()
    expect(await pane.find({ text: /A --> B/ })).toBeDefined()
  })

  const three = (on: On) => {
    conversation(on, [reply(fence('graph TD\n  ONE --> B')), reply(fence('graph TD\n  TWO --> B')), reply(fence('graph TD\n  THREE --> B'))])
    answerOpen(on)

    return answerUvx(on, stdin => `drawn ${/\w+(?= -->)/.exec(stdin)?.[0] ?? ''}`)
  }

  test('previous and next walk through the diagrams and stop at the ends', async ($, on) => {
    three(on)

    await termaid($)
    const pane = await mountPane($)
    await settle()

    expect(await pane.find({ text: /3 of 3/ })).toBeDefined()
    expect(await pane.find({ key: 'page-next' })).toBeUndefined()

    await pane.press({ key: 'page-previous' })
    await settle()
    expect(await pane.find({ text: /2 of 3/ })).toBeDefined()
    expect(await pane.find({ text: /TWO/ })).toBeDefined()

    await pane.press({ key: 'page-previous' })
    await settle()
    expect(await pane.find({ text: /1 of 3/ })).toBeDefined()
    expect(await pane.find({ key: 'page-previous' })).toBeUndefined()

    await pane.press({ key: 'page-next' })
    await settle()
    expect(await pane.find({ text: /2 of 3/ })).toBeDefined()
  })

  test('paging to a diagram never shown renders it once; paging back renders nothing', async ($, on) => {
    const runs = three(on)

    await termaid($)
    const pane = await mountPane($)
    await settle()
    expect(runs).toHaveLength(1)

    await pane.press({ key: 'page-previous' })
    await settle()
    expect(runs).toHaveLength(2)

    await pane.press({ key: 'page-next' })
    await settle()
    await pane.press({ key: 'page-previous' })
    await settle()
    expect(runs).toHaveLength(2)
  })

  test('a new diagram at the end of a turn moves the pane to it, whatever was shown', async ($, on) => {
    const held = conversation(on, [reply(fence('graph TD\n  ONE --> B')), reply(fence('graph TD\n  TWO --> B'))])
    answerOpen(on)
    answerUvx(on)

    await termaid($)
    const pane = await mountPane($)
    await settle()
    await pane.press({ key: 'page-previous' })
    await settle()
    expect(await pane.find({ text: /1 of 2/ })).toBeDefined()

    held.main = [...held.main, reply(fence('graph TD\n  NEW --> B'))]
    await ends($)
    await settle()

    expect(await pane.find({ text: /3 of 3/ })).toBeDefined()
    expect(await pane.find({ text: /NEW/ })).toBeDefined()
  })

  test('Show source swaps the drawing for the source and back, with no process run, and stays while paging', async ($, on) => {
    const runs = three(on)

    await termaid($)
    const pane = await mountPane($)
    await settle()
    expect(await pane.find({ text: /drawn THREE/ })).toBeDefined()
    expect(await pane.find({ text: /Show source/ })).toBeDefined()
    expect(runs).toHaveLength(1)

    await pane.press({ key: 'toggle-source' })
    await settle()
    expect(await pane.find({ text: /THREE --> B/ })).toBeDefined()
    expect(await pane.find({ text: /drawn THREE/ })).toBeUndefined()
    expect(await pane.find({ text: /Show drawing/ })).toBeDefined()
    expect(runs).toHaveLength(1)

    await pane.press({ key: 'page-previous' })
    await settle()
    expect(await pane.find({ text: /TWO --> B/ })).toBeDefined()
    expect(await pane.find({ text: /Show drawing/ })).toBeDefined()

    await pane.press({ key: 'toggle-source' })
    await settle()
    expect(await pane.find({ text: /drawn TWO/ })).toBeDefined()
    expect(await pane.find({ text: /Show source/ })).toBeDefined()
  })

  test('off the terminal paging and the source toggle work on the pictures', async ($, on) => {
    conversation(on, [reply(fence('graph TD\n  ONE --> B')), reply(fence('graph TD\n  TWO --> B')), reply(fence('graph TD\n  THREE --> B'))])
    answerOpen(on)
    answerNode(on)

    await termaid($)
    const pane = await mountDesktop($)
    await settle()

    await pane.press({ key: 'page-previous' })
    await settle()
    expect(await pane.find({ text: /2 of 3/ })).toBeDefined()
    expect(await pane.find({ type: 'Svg' })).toMatchObject({ props: { source: expect.stringMatching(/TWO --> B/) } })

    await pane.press({ key: 'toggle-source' })
    await settle()
    expect(await pane.find({ type: 'Svg' })).toBeUndefined()
    expect(await pane.find({ text: /TWO --> B/ })).toBeDefined()
  })

  // Stands for `uvx`: the plain command line prints `plain`, the themed script prints `themed` for the theme asked
  const answerThemes = (on: On, themed: (theme: string) => string) => {
    const runs: Run[] = []

    on('process.run', (_, e) => {
      runs.push({ argv: e.argv, stdin: e.init?.stdin, timeoutMs: e.init?.timeoutMs, env: e.init?.env })
      const stdout = e.argv.includes('python') ? themed((JSON.parse(e.init?.stdin ?? '{}') as { theme: string }).theme) : 'plain drawing'

      return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
    })

    return runs
  }

  // A color as termaid's theme gives it: data the mod is handed, which it never writes itself
  const raw = (digits: string) => `#${digits}`

  test('picking a theme draws the diagram through termaid\'s Python API, in the colors it answers', async ($, on) => {
    conversation(on, [reply(fence('graph TD\n  A --> B'))])
    answerOpen(on)
    const runs = answerThemes(on, theme =>
      JSON.stringify({
        lines: [
          [{ text: 'box', color: raw('88c0d0'), background: raw('3b4252'), bold: true }, { text: ' ' }, { text: theme, color: 'cyan', italic: true }],
          [],
        ],
      }),
    )

    await termaid($)
    const pane = await mountPane($)
    await settle()
    expect(await pane.find({ text: /plain drawing/ })).toBeDefined()
    expect(runs).toHaveLength(1)

    await pane.select({ key: 'theme', value: 'nord' })
    await settle()

    expect(runs).toHaveLength(2)
    expect(runs[1]?.argv).toEqual(['uvx', '--from', expect.stringMatching(/^termaid\[rich\]==\d+\.\d+(\.\d+)?$/), 'python', '-c', expect.any(String)])
    expect(runs[1]?.env).toEqual({ PYTHONIOENCODING: 'utf-8' })
    expect(JSON.parse(runs[1]?.stdin ?? '{}')).toMatchObject({ source: 'graph TD\n  A --> B', theme: 'nord', width: 96 })
    expect(await pane.find({ text: /plain drawing/ })).toBeUndefined()
    expect(await pane.find({ type: 'Text', text: /^box$/ })).toMatchObject({
      props: { color: raw('88c0d0'), backgroundColor: raw('3b4252'), bold: true },
    })
    expect(await pane.find({ type: 'Text', text: /^nord$/ })).toMatchObject({ props: { color: 'cyan', italic: true } })

    // Back to no theme: the plain drawing is known already, so nothing runs
    await pane.select({ key: 'theme', value: 'none' })
    await settle()
    expect(runs).toHaveLength(2)
    expect(await pane.find({ text: /plain drawing/ })).toBeDefined()
  })

  test('the theme stays while paging, and a pick that is no theme changes nothing', async ($, on) => {
    conversation(on, [reply(fence('graph TD\n  ONE --> B')), reply(fence('graph TD\n  TWO --> B')), reply(fence('graph TD\n  THREE --> B'))])
    answerOpen(on)
    const runs: Run[] = []
    on('process.run', (_, e) => {
      runs.push({ argv: e.argv, stdin: e.init?.stdin })
      const asked = e.argv.includes('python') ? (JSON.parse(e.init?.stdin ?? '{}') as { source: string; theme: string }) : undefined
      const stdout = asked === undefined ? 'plain' : JSON.stringify({ lines: [[{ text: `${asked.theme} ${asked.source.slice(asked.source.indexOf('  ') + 2)}` }]] })

      return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
    })

    await termaid($)
    const pane = await mountPane($)
    await settle()
    await pane.select({ key: 'theme', value: 'dracula' })
    await settle()
    expect(await pane.find({ text: /dracula THREE --> B/ })).toBeDefined()

    await pane.press({ key: 'page-previous' })
    await settle()
    expect(await pane.find({ text: /dracula TWO --> B/ })).toBeDefined()

    const before = runs.length
    await pane.select({ key: 'theme', value: 'no-such-theme' })
    await settle()
    expect(runs).toHaveLength(before)
    expect(await pane.find({ text: /dracula TWO --> B/ })).toBeDefined()
  })

  test('a themed drawing wider than the pane is cut, with a notice', async ($, on) => {
    conversation(on, [reply(fence('graph TD\n  A --> B'))])
    answerOpen(on)
    answerThemes(on, () => JSON.stringify({ lines: [[{ text: 'x'.repeat(90) }, { text: 'y'.repeat(20) }]] }))

    await termaid($)
    const pane = await mountPane($)
    await settle()
    await pane.select({ key: 'theme', value: 'mono' })
    await settle()

    expect(await pane.find({ text: /wider than the pane/ })).toBeDefined()
    expect(await pane.find({ text: /x{90}y{6}$/ })).toBeDefined()
    expect(await pane.find({ text: /y{7}/ })).toBeUndefined()
  })

  test('a themed answer that is not a drawing shows the source and says it could not be read', async ($, on) => {
    conversation(on, [reply(fence('graph TD\n  A --> B'))])
    answerOpen(on)
    answerThemes(on, () => 'Traceback: not json')

    await termaid($)
    const pane = await mountPane($)
    await settle()
    await pane.select({ key: 'theme', value: 'amber' })
    await settle()

    expect(await pane.find({ text: /amber theme could not be read/ })).toBeDefined()
    expect(await pane.find({ text: /A --> B/ })).toBeDefined()
  })

  test('a themed render that fails shows termaid\'s reason', async ($, on) => {
    conversation(on, [reply(fence('graph TD\n  A --> B'))])
    answerOpen(on)
    on('process.run', (_, e) =>
      ({
        value: e.argv.includes('python')
          ? { exitCode: 1, stdout: '', stderr: 'termaid drew nothing for this diagram.', isStdoutTruncated: false, isStderrTruncated: false }
          : { exitCode: 0, stdout: 'plain', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
      }) as never,
    )

    await termaid($)
    const pane = await mountPane($)
    await settle()
    await pane.select({ key: 'theme', value: 'terra' })
    await settle()

    expect(await pane.find({ text: /drew nothing/ })).toBeDefined()
  })

  test('the default theme of the options is drawn until another is picked in the pane', { options: { defaultTheme: 'nord' } }, async ($, on) => {
    conversation(on, [reply(fence('graph TD\n  A --> B'))])
    answerOpen(on)
    const runs = answerThemes(on, theme => JSON.stringify({ lines: [[{ text: `themed ${theme}` }]] }))

    await termaid($)
    const pane = await mountPane($)
    await settle()

    expect(runs).toHaveLength(1)
    expect(JSON.parse(runs[0]?.stdin ?? '{}')).toMatchObject({ theme: 'nord' })
    expect(await pane.find({ text: /themed nord/ })).toBeDefined()

    await pane.select({ key: 'theme', value: 'none' })
    await settle()
    expect(await pane.find({ text: /plain drawing/ })).toBeDefined()
  })

  test('off the terminal the themes are Mermaid\'s own, and a pick draws the picture again in it', async ($, on) => {
    conversation(on, [reply(fence('graph TD\n  A --> B'))])
    answerOpen(on)
    const runs = answerNode(on)

    await termaid($)
    const pane = await mountDesktop($)
    await settle()

    expect(await pane.find({ key: 'theme' })).toMatchObject({
      props: { value: 'default', options: [{ value: 'default' }, { value: 'neutral' }, { value: 'forest' }, { value: 'dark' }] },
    })

    await pane.select({ key: 'theme', value: 'dark' })
    await settle()
    expect(runs).toHaveLength(2)
    expect(JSON.parse(runs[1]?.stdin ?? '{}')).toMatchObject({ theme: 'dark', background: 'black' })
    expect(await pane.find({ type: 'Svg' })).toMatchObject({ props: { source: expect.stringMatching(/^<svg>dark: / ) } })
  })

  test('on mobile, which draws no select, the picture is drawn with no theme or direction to pick', async ($, on) => {
    conversation(on, [reply(fence('graph TD\n  A --> B'))])
    answerOpen(on)
    answerNode(on)

    await termaid($)
    const pane = await $.ui.mount({ plugin: 'termaid-view', surface: 'mobile', component: 'Pane', props: PANE as never, requestId: 'termaid-view' })
    await settle()

    expect(await pane.find({ type: 'Svg' })).toBeDefined()
    expect(await pane.find({ key: 'theme' })).toBeUndefined()
    expect(await pane.find({ key: 'direction' })).toBeUndefined()
  })

  // A reply's row in the transcript, as the terminal draws it
  const mountReply = ($: Engine, text: string, surface: 'terminal' | 'desktop' = 'terminal') =>
    $.ui.mount({
      plugin: 'termaid-view',
      surface,
      component: 'AssistantMessage',
      props: { text, isFirstOfReply: true } as never,
      requestId: 'message-1',
    })

  // Stands for the engine's own drawing of a reply: its text, marked so a test can tell it from the mod's
  const answerReply = (on: On) =>
    on('ui.render', { component: 'AssistantMessage' } as never, (_, e) => ({
      type: 'Text',
      props: {},
      children: [`engine: ${(e as { props: { text: string } }).props.text}`],
    }) as never)

  test('a reply\'s diagram is drawn in the transcript in place of its block, the text around it kept', async ($, on) => {
    answerReply(on)
    const runs = answerUvx(on, stdin => `drawn ${/\w+(?= -->)/.exec(stdin)?.[0] ?? ''}`)
    const text = `Before.\n\n${fence('graph TD\n  ONE --> B')}\n\nAfter.`

    const row = await mountReply($, text)
    await settle()

    expect(runs).toHaveLength(1)
    expect(runs[0]?.argv).toEqual(['uvx', expect.stringMatching(/^termaid==/), '--width', '76'])
    expect(await row.find({ text: /^drawn ONE$/ })).toBeDefined()
    // What opens the reply is still the engine's drawing, of the text before the diagram alone
    expect(await row.find({ text: /^engine: Before\.\s*$/ })).toBeDefined()
    expect(await row.find({ type: 'Markdown' })).toMatchObject({ props: { text: 'After.' } })
    expect(await row.find({ text: /ONE --> B/ })).toBeUndefined()
  })

  test('a reply with no Mermaid block is left to the engine and runs nothing', async ($, on) => {
    answerReply(on)
    const runs = answerUvx(on)

    const plain = await mountReply($, 'Just words, and ```js\ncode\n```.')
    await settle()

    expect(await plain.find({ text: /^engine: Just words/ })).toBeDefined()
    expect(runs).toEqual([])
  })

  test('off the terminal a reply\'s diagram is drawn in the transcript as a picture, the text around it kept', async ($, on) => {
    answerReply(on)
    const runs = answerNode(on)

    const row = await mountReply($, `Before.\n\n${fence('graph TD\n  ONE --> B')}\n\nAfter.`, 'desktop')
    await settle()

    expect(runs).toHaveLength(1)
    expect(runs[0]?.argv[0]).toBe('node')
    expect(await row.find({ type: 'Svg' })).toMatchObject({ props: { source: expect.stringMatching(/ONE --> B/), alt: 'Mermaid diagram: graph TD' } })
    expect(await row.find({ text: /^engine: Before\.\s*$/ })).toBeDefined()
    expect(await row.find({ type: 'Markdown' })).toMatchObject({ props: { text: 'After.' } })
  })

  test('a diagram termaid cannot draw stays the block the reply wrote', async ($, on) => {
    answerReply(on)
    answerWith(on, () => ({ value: { exitCode: 1, stdout: '', stderr: 'Parse error', isStdoutTruncated: false, isStderrTruncated: false } }))

    const row = await mountReply($, fence('graph TD\n  A --> B'))
    await settle()

    expect(await row.find({ text: /engine: [\s\S]*A --> B/ })).toBeDefined()
    expect(await row.find({ text: /Parse error/ })).toBeUndefined()
  })

  test('the transcript draws in the pane\'s theme, and "Hide in chat" gives the reply back to the engine', async ($, on) => {
    conversation(on, [reply(fence('graph TD\n  A --> B'))])
    answerOpen(on)
    answerReply(on)
    answerThemes(on, theme => JSON.stringify({ lines: [[{ text: `themed ${theme}`, color: 'cyan' }]] }))

    await termaid($)
    const pane = await mountPane($)
    const row = await mountReply($, fence('graph TD\n  A --> B'))
    await settle()
    expect(await row.find({ text: /^plain drawing$/ })).toBeDefined()

    await pane.select({ key: 'theme', value: 'nord' })
    await settle()
    expect(await row.find({ type: 'Text', text: /^themed nord$/ })).toMatchObject({ children: [{ props: { color: 'cyan' } }] })

    await pane.press({ key: 'toggle-inline' })
    await settle()
    expect(await row.find({ text: /themed nord/ })).toBeUndefined()
    expect(await row.find({ text: /engine: [\s\S]*A --> B/ })).toBeDefined()
    expect(await pane.find({ text: /Show in chat/ })).toBeDefined()
  })

  const LINKED = 'flowchart LR\n  A[Parse] --> B[Draw]\n  click A href "src/parse.ts#L50"\n  click B "diff:src/draw.ts"'

  // Stands for `uvx` drawing a diagram with linked nodes, and for `git diff`
  const answerLinked = (on: On, diff = '') => {
    const runs: Run[] = []

    on('process.run', (_, e) => {
      runs.push({ argv: e.argv, stdin: e.init?.stdin })
      const asked = e.argv[0] === 'git' ? undefined : (JSON.parse(e.init?.stdin ?? '{}') as { links: Record<string, string> })
      const stdout =
        asked === undefined
          ? diff
          : JSON.stringify({ lines: [[{ text: '[ Parse ]', link: asked.links.A }, { text: ' --> ' }, { text: '[ Draw ]', link: asked.links.B }]] })

      return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
    })

    return runs
  }

  const file = (lines: number) => Array.from({ length: lines }, (_, index) => `line ${index + 1}`).join('\n')

  test('a diagram with linked nodes is drawn through the Python API, even with no theme, its nodes buttons', async ($, on) => {
    conversation(on, [reply(fence(LINKED))])
    answerOpen(on)
    const runs = answerLinked(on)

    await termaid($)
    const pane = await mountPane($)
    await settle()

    expect(runs).toHaveLength(1)
    expect(runs[0]?.argv).toContain('python')
    expect(JSON.parse(runs[0]?.stdin ?? '{}')).toMatchObject({ theme: 'none', links: { A: 'src/parse.ts#L50', B: 'diff:src/draw.ts' } })
    expect(await pane.find({ key: 'node-0-0' })).toBeDefined()
    expect(await pane.find({ key: 'node-0-2' })).toBeDefined()
    expect(await pane.find({ text: /press it/ })).toBeDefined()
  })

  test('pressing a node linked to a file shows it from just above its line, and pages through it', async ($, on) => {
    conversation(on, [reply(fence(LINKED))])
    answerOpen(on)
    answerLinked(on)
    const read: string[] = []
    on('fs.read', (_, e) => {
      read.push((e as { path: string }).path)

      return { value: file(100) } as never
    })

    await termaid($)
    const pane = await mountPane($)
    await settle()
    await pane.press({ key: 'node-0-0' })
    await settle()

    // The host resolves the path against the working directory
    expect(read).toEqual([expect.stringMatching(/(^|[\\/])src[\\/]parse\.ts$/)])
    expect(await pane.find({ type: 'Code' })).toMatchObject({ props: { path: 'src/parse.ts', startLine: 47 } })
    expect(await pane.find({ text: /lines 47-86 of 100/ })).toBeDefined()
    expect(await pane.find({ text: /^line 47\n/ })).toBeDefined()
    expect(await pane.find({ text: /Parse \]/ })).toBeUndefined()

    await pane.press({ key: 'lines-next' })
    await settle()
    expect(await pane.find({ text: /lines 87-100 of 100/ })).toBeDefined()
    expect(await pane.find({ key: 'lines-next' })).toBeUndefined()

    await pane.press({ key: 'lines-previous' })
    await settle()
    await pane.press({ key: 'back' })
    await settle()
    expect(await pane.find({ type: 'Code' })).toBeUndefined()
    expect(await pane.find({ key: 'node-0-0' })).toBeDefined()
  })

  test('pressing a node linked to a diff shows the uncommitted changes of its file, or says there are none', async ($, on) => {
    conversation(on, [reply(fence(LINKED))])
    answerOpen(on)
    const held = { diff: 'diff --git a/src/draw.ts b/src/draw.ts\nindex 1..2\n--- a/src/draw.ts\n+++ b/src/draw.ts\n@@ -1 +1 @@\n-old\n+new\n' }
    const runs: Run[] = []
    on('process.run', (_, e) => {
      runs.push({ argv: e.argv })
      const stdout = e.argv[0] === 'git' ? held.diff : JSON.stringify({ lines: [[{ text: '[ Draw ]', link: 'diff:src/draw.ts' }]] })

      return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
    })

    await termaid($)
    const pane = await mountPane($)
    await settle()
    await pane.press({ key: 'node-0-0' })
    await settle()

    expect(runs[1]?.argv).toEqual(['git', 'diff', 'HEAD', '--', 'src/draw.ts'])
    expect(await pane.find({ type: 'Code' })).toMatchObject({ props: { format: 'diff', source: '@@ -1 +1 @@\n-old\n+new' } })

    held.diff = ''
    await pane.press({ key: 'back' })
    await settle()
    await pane.press({ key: 'node-0-0' })
    await settle()
    expect(await pane.find({ text: /no uncommitted change/ })).toBeDefined()
  })

  test('a link out of the project reads nothing and runs nothing', async ($, on) => {
    conversation(on, [reply(fence('flowchart LR\n  A --> B\n  click A "../../secrets.txt"\n  click B "diff:/etc/passwd"'))])
    answerOpen(on)
    const runs = answerLinked(on)
    const read: string[] = []
    on('fs.read', (_, e) => {
      read.push((e as { path: string }).path)

      return { value: 'secret' } as never
    })

    await termaid($)
    const pane = await mountPane($)
    await settle()
    await pane.press({ key: 'node-0-0' })
    await settle()
    expect(await pane.find({ text: /not a file of this project/ })).toBeDefined()

    await pane.press({ key: 'back' })
    await settle()
    await pane.press({ key: 'node-0-2' })
    await settle()
    expect(await pane.find({ text: /not a file of this project/ })).toBeDefined()
    expect(read).toEqual([])
    expect(runs.filter(run => run.argv[0] === 'git')).toEqual([])
  })

  test('a linked node pressed in the chat opens the pane on its code', async ($, on) => {
    conversation(on, [reply(fence(LINKED))])
    const openedPanes = answerOpen(on)
    answerReply(on)
    answerLinked(on)
    on('fs.read', () => ({ value: file(100) }) as never)

    const row = await mountReply($, fence(LINKED))
    await settle()
    await row.press({ key: 'node-0-0-0' })
    await settle()

    expect(openedPanes).toEqual(['termaid-view'])
    const pane = await mountPane($)
    await settle()
    expect(await pane.find({ type: 'Code' })).toMatchObject({ props: { path: 'src/parse.ts', startLine: 47 } })
    expect(await pane.find({ text: /lines 47-86 of 100/ })).toBeDefined()
  })

  test('Claude is told how to link a node', async ($, on) => {
    on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'Hello', scope: 'shared' }] }) as never)

    const composed = await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as never)

    expect(composed.sections.map(section => section.id)).toEqual(['intro', 'termaid-view:links'])
    expect(composed.sections[1]?.text).toMatch(/click A href/)
  })

  test('picking a direction in the pane lays a flowchart out that way, in the chat too; other diagrams have none', async ($, on) => {
    conversation(on, [reply(fence('sequenceDiagram\n  Alice->>Bob: Hi')), reply(fence('graph TD\n  A --> B'))])
    answerOpen(on)
    answerReply(on)
    const runs = answerUvx(on, stdin => `drawn ${stdin.split('\n')[0]}`)

    await termaid($)
    const pane = await mountPane($)
    const row = await mountReply($, fence('graph TD\n  A --> B'))
    await settle()
    expect(await pane.find({ text: /drawn graph TD/ })).toBeDefined()

    await pane.select({ key: 'direction', value: 'LR' })
    await settle()
    expect(runs.some(run => run.stdin === 'graph LR\n  A --> B')).toBe(true)
    expect(await pane.find({ text: /drawn graph LR/ })).toBeDefined()
    expect(await row.find({ text: /drawn graph LR/ })).toBeDefined()

    // The source shown stays the one the reply wrote
    await pane.press({ key: 'toggle-source' })
    await settle()
    expect(await pane.find({ text: /graph TD/ })).toBeDefined()

    await pane.select({ key: 'direction', value: 'sideways' })
    await pane.press({ key: 'toggle-source' })
    await settle()
    expect(await pane.find({ text: /drawn graph LR/ })).toBeDefined()

    await pane.press({ key: 'page-previous' })
    await settle()
    expect(await pane.find({ key: 'direction' })).toBeUndefined()
  })

  test('a flowchart is laid out top-down until its button in the chat turns it: each direction, then as written', async ($, on) => {
    answerReply(on)
    answerUvx(on, stdin => `drawn ${stdin.split('\n')[0]}`)

    const row = await mountReply($, fence('flowchart LR\n  A --> B'))
    await settle()
    expect(await row.find({ text: /^drawn flowchart TD$/ })).toBeDefined()
    expect(await row.find({ key: 'direction-0' })).toMatchObject({ text: 'Direction: TD' })

    for (const way of ['LR', 'BT']) {
      await row.press({ key: 'direction-0' })
      await settle()
      expect(await row.find({ text: new RegExp(`^drawn flowchart ${way}$`) })).toBeDefined()
    }

    await row.press({ key: 'direction-0' })
    await settle()
    expect(await row.find({ text: /^drawn flowchart LR$/ })).toBeDefined()
    expect(await row.find({ key: 'direction-0' })).toMatchObject({ text: 'Direction: as written' })

    await row.unmount()
    const other = await mountReply($, fence('pie\n  "a" : 1'))
    await settle()
    expect(await other.find({ key: 'direction-0' })).toBeUndefined()
  })

  test('the default direction of the options lays flowcharts out, and "as written" leaves them alone', { options: { defaultDirection: 'as written' } }, async ($, on) => {
    conversation(on, [reply(fence('graph LR\n  A --> B'))])
    answerOpen(on)
    const runs = answerUvx(on)

    await termaid($)
    await mountPane($)
    await settle()

    expect(runs[0]?.stdin).toBe('graph LR\n  A --> B')
  })

  test('a session with no diagram opens on an empty state', async ($, on) => {
    conversation(on, [reply('Just words.')])
    answerOpen(on)

    await termaid($)
    const pane = await mountPane($)

    expect(await pane.find({ text: /No Mermaid diagram in this conversation yet/ })).toBeDefined()
    expect(await pane.find({ type: 'Code' })).toBeUndefined()
  })
})
