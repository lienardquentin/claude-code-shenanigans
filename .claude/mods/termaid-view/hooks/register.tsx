import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import { card } from './kit/card'
import { code } from './kit/code'

const PANE = 'termaid-view'

type Engine = EngineInterface

// The Mermaid source of each diagram of the main conversation, in the order written, and the one the pane shows
const diagrams = atom({ plugin: 'termaid-view', key: 'diagrams' } as const, [] as string[])
const shown = atom({ plugin: 'termaid-view', key: 'shown' } as const, 0)

// The one place termaid's version is fixed: the code `uvx` fetches and runs changes only when this does
const TERMAID_VERSION = '0.5.0'
const RENDER_TIMEOUT_MS = 60_000

// What is known of a diagram at a width: being drawn, drawn (the lines), or failed (kept so it is not retried on
// every redraw). Keyed by width and source.
type Result = { status: 'rendering' } | { status: 'drawn'; text: string } | { status: 'failed'; reason: string }
const results = atom({ plugin: 'termaid-view', key: 'results' } as const, {} as Record<string, Result>)

// Keys being rendered right now, checked before the atom is written so two redraws never start two processes
const inFlight = new Set<string>()

const keyOf = (source: string, width: number): string => `${width}\u0000${source}`

const render = async ($: Engine, source: string, width: number): Promise<void> => {
  const key = keyOf(source, width)
  inFlight.add(key)

  try {
    await update($, results, all => ({ ...all, [key]: { status: 'rendering' } }))

    let result: Result
    try {
      const run = await $.process.run(['uvx', `termaid==${TERMAID_VERSION}`, '--width', String(width)], {
        stdin: source,
        timeoutMs: RENDER_TIMEOUT_MS,
      })
      result =
        run.exitCode === 0
          ? { status: 'drawn', text: run.stdout.replace(/\r\n?/g, '\n').replace(/\n+$/, '') }
          : { status: 'failed', reason: run.stderr.trim() }
    } catch (error) {
      result = { status: 'failed', reason: error instanceof Error ? error.message : String(error) }
    }

    await update($, results, all => ({ ...all, [key]: result }))
  } finally {
    inFlight.delete(key)
  }
}

// A fenced block whose info string starts with `mermaid`, closed by a fence of the same kind at least as long.
// A block never closed (a reply still being written) is not a diagram yet.
const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*mermaid\b[^\n]*\n([\s\S]*?)^ {0,3}\1[`~]*[ \t]*$/gim

const diagramsOf = (text: string): string[] =>
  [...text.replace(/\r\n?/g, '\n').matchAll(FENCE)].map(match => (match[2] ?? '').replace(/\n$/, ''))

// Every diagram of the main conversation's replies. `$.session.messages()` is the main conversation alone: a
// subagent's replies are another call's.
const findDiagrams = async ($: Engine): Promise<string[]> => {
  const messages = await $.session.messages()

  return messages.filter(message => message.role === 'assistant').flatMap(message => diagramsOf(message.text))
}

// Reads the conversation again. The pane moves to the last diagram when `follow` is set and there are more than
// before; otherwise it stays where it was, kept inside the list.
const refresh = async ($: Engine, follow: boolean): Promise<void> => {
  const before = (await read($, diagrams)).length
  const found = await findDiagrams($)

  await update($, diagrams, () => found)
  await update($, shown, current => (follow && found.length > before ? found.length - 1 : Math.min(current, Math.max(found.length - 1, 0))))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'termaid', description: "Open the pane of the session's Mermaid diagrams" })

    return next(e)
  })

  on('command.run', { command: 'termaid' }, async $ => {
    await refresh($, false)
    // Opens on the most recent diagram
    const last = Math.max((await read($, diagrams)).length - 1, 0)
    await update($, shown, () => last)
    await $.ui.open({ id: PANE, title: 'Mermaid diagrams' })

    return { text: 'Mermaid diagrams pane opened.' }
  })

  // The pane follows the conversation: a turn of the main conversation that ends with a new diagram moves it there
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) await refresh($, true)

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Text } = $.ui.resolve(e)
    const list = await read($, diagrams)
    const at = Math.min(await read($, shown), Math.max(list.length - 1, 0))
    const current = list[at]
    const width = e.props.bodyColumns ?? 80
    const isTerminal = e.surface === 'terminal'
    const known = current === undefined || !isTerminal ? undefined : (await read($, results))[keyOf(current, width)]

    // Only the diagram shown is rendered, and only when nothing is known of it at this width
    // (drawing is pure, so the work starts once this hook has returned)
    if (current !== undefined && isTerminal && known === undefined && !inFlight.has(keyOf(current, width))) {
      inFlight.add(keyOf(current, width))
      setTimeout(() => void render($, current, width), 0)
    }

    let body: RenderElement[]
    if (current === undefined) {
      body = [
        <Text key="empty" color="subtle" wrap="wrap">
          No Mermaid diagram in this conversation yet. This pane shows the diagrams in Claude's replies, the most
          recent first.
        </Text>,
      ]
    } else if (!isTerminal) {
      body = [
        <Text key="note" color="subtle" wrap="wrap">
          Drawing the diagram needs the terminal. Its Mermaid source is shown.
        </Text>,
        code({ source: current, plain: true }),
      ]
    } else if (known === undefined || known.status === 'rendering') {
      body = [
        <Text key="rendering" color="subtle">
          rendering…
        </Text>,
      ]
    } else if (known.status === 'failed') {
      body = [code({ source: current })]
    } else {
      const lines = known.text.split('\n')
      const isWide = lines.some(line => [...line].length > width)
      body = [
        ...(isWide
          ? [
              <Text key="wide" color="subtle" wrap="wrap">
                The diagram is wider than the pane: the right part is cut off.
              </Text>,
            ]
          : []),
        code({ source: isWide ? lines.map(line => [...line].slice(0, width).join('')).join('\n') : known.text }),
      ]
    }

    return card({
      width,
      title: 'Mermaid diagrams',
      meta: current === undefined ? undefined : `${at + 1} of ${list.length}`,
      children: body,
    })
  })
}
