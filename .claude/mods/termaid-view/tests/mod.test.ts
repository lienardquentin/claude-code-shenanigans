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

type Run = { argv: readonly string[]; stdin?: string; timeoutMs?: number }

// Stands for `uvx`: every run is kept, and prints the box `out` makes of the input
const answerUvx = (on: On, out: (stdin: string) => string = stdin => `[ ${stdin} ]`) => {
  const runs: Run[] = []

  on('process.run', (_, e) => {
    runs.push({ argv: e.argv, stdin: e.init?.stdin, timeoutMs: e.init?.timeoutMs })

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

  test('off the terminal no process runs, the source is shown and drawing is said to need the terminal', async ($, on) => {
    conversation(on, [reply(fence('graph TD\n  A --> B'))])
    answerOpen(on)
    const runs = answerUvx(on)

    await termaid($)
    const pane = await $.ui.mount({ plugin: 'termaid-view', surface: 'desktop', component: 'Pane', props: PANE as never, requestId: 'termaid-view' })
    await settle()

    expect(runs).toEqual([])
    expect(await pane.find({ text: /needs the terminal/ })).toBeDefined()
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

  test('off the terminal paging works and the toggle is not shown', async ($, on) => {
    three(on)

    await termaid($)
    const pane = await $.ui.mount({ plugin: 'termaid-view', surface: 'desktop', component: 'Pane', props: PANE as never, requestId: 'termaid-view' })
    await settle()

    expect(await pane.find({ key: 'toggle-source' })).toBeUndefined()
    await pane.press({ key: 'page-previous' })
    await settle()
    expect(await pane.find({ text: /2 of 3/ })).toBeDefined()
    expect(await pane.find({ text: /TWO --> B/ })).toBeDefined()
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
