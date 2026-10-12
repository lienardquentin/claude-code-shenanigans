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

    await termaid($)
    const pane = await mountPane($)

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

    await termaid($)
    const pane = await mountPane($)

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

    await termaid($)
    const pane = await mountPane($)
    expect(await pane.find({ text: /1 of 1/ })).toBeDefined()

    held.main = [...held.main, reply(fence('stateDiagram-v2\n  [*] --> Idle'))]
    await ends($)

    expect(await pane.find({ text: /2 of 2/ })).toBeDefined()
    expect(await pane.find({ text: /stateDiagram-v2/ })).toBeDefined()
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
