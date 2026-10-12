import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import { card } from './kit/card'
import { code } from './kit/code'
import { actionLabel } from './kit/action-label'
import { pagination } from './kit/pagination'
import { tonedText } from './kit/toned-text'

const PANE = 'termaid-view'

type Engine = EngineInterface

// The Mermaid source of each diagram of the main conversation, in the order written, and the one the pane shows
const diagrams = atom({ plugin: 'termaid-view', key: 'diagrams' } as const, [] as string[])
const shown = atom({ plugin: 'termaid-view', key: 'shown' } as const, 0)
// Whether the Mermaid source is shown in place of the drawing; it stays as set while paging
const isSource = atom({ plugin: 'termaid-view', key: 'isSource' } as const, false)

// The one place termaid's version is fixed: the code `uvx` fetches and runs changes only when this does
const TERMAID_VERSION = '0.5.0'
const RENDER_TIMEOUT_MS = 60_000

// What is known of a diagram at a width: drawn (the lines), or failed (kept so it is not retried on every redraw).
// Keyed by width and source. One with no result yet is being drawn, or about to be.
type Result = { status: 'drawn'; text: string } | { status: 'failed'; reason: string }
const results = atom({ plugin: 'termaid-view', key: 'results' } as const, {} as Record<string, Result>)

// Keys being rendered right now, so two redraws never start two processes
const inFlight = new Set<string>()

// How often, and how far apart, a result the host would not take is written again
const STORE_ATTEMPTS = 40
const STORE_RETRY_MS = 50

// How a failure is told apart. The mod only prints the install command: it never runs it.
const UV_INSTALL = 'winget install --id astral-sh.uv (Windows) or curl -LsSf https://astral.sh/uv/install.sh | sh'
const TIMED_OUT = /tim(e|ed)[ -]?out/i
const NOT_STARTED = /ENOENT|not found|cannot start|could not start|failed to (start|spawn)|no such file/i
const DOWNLOAD_FAILED = /failed to (fetch|download)|error sending request|dns error|tcp connect error|network is unreachable/i

// The engine's clock, in milliseconds; 0 when it cannot say (then no call is taken for a timeout by its duration)
const now = ($: Engine): Promise<number> => $.clock.now().catch(() => 0)

const keyOf = (source: string, width: number): string => `${width}\u0000${source}`

const render = async ($: Engine, source: string, width: number): Promise<void> => {
  const key = keyOf(source, width)
  inFlight.add(key)

  try {
    let result: Result
    const startedAt = await now($)
    try {
      const run = await $.process.run(['uvx', `termaid==${TERMAID_VERSION}`, '--width', String(width)], {
        stdin: source,
        timeoutMs: RENDER_TIMEOUT_MS,
        // Piped, Python on Windows writes in the ANSI code page, which has no box-drawing characters
        env: { PYTHONIOENCODING: 'utf-8' },
      })
      if (run.exitCode === 0) {
        result = { status: 'drawn', text: run.stdout.replace(/\r\n?/g, '\n').replace(/\n+$/, '') }
      } else {
        // termaid's own message: standard error, or standard output when that is empty
        const message = run.stderr.trim() !== '' ? run.stderr.trim() : run.stdout.trim()
        result = {
          status: 'failed',
          reason: DOWNLOAD_FAILED.test(message)
            ? 'termaid could not be downloaded. Check the connection, then reopen the pane to try again.'
            : message !== ''
              ? message
              : `termaid failed (exit code ${run.exitCode}) without a message.`,
        }
      }
    } catch (error) {
      // The call rejects when the command cannot start or is still running at the timeout
      // (the message is not a documented contract, so the time the call took is read too)
      const message = error instanceof Error ? error.message : String(error)
      const isTimeout = TIMED_OUT.test(message) || (await now($)) - startedAt >= RENDER_TIMEOUT_MS
      result = {
        status: 'failed',
        reason: isTimeout
          ? `The render timed out after ${RENDER_TIMEOUT_MS / 1000} seconds.`
          : NOT_STARTED.test(message)
            ? `uv is missing, so termaid cannot run. Install it with: ${UV_INSTALL}`
            : `termaid could not be run: ${message !== '' ? message : 'the host refused the call'}`,
      }
    }

    // The host refuses a write made while the `ui.render` that asked for this render is still being dispatched
    // (drawing is pure), and a quick termaid can be done by then: the write is tried again until that draw is over
    for (let attempt = 1; ; attempt++) {
      try {
        await update($, results, all => ({ ...all, [key]: result }))
        break
      } catch (error) {
        if (attempt === STORE_ATTEMPTS) throw error
        await new Promise<void>(resolve => setTimeout(resolve, STORE_RETRY_MS))
      }
    }
  } catch (error) {
    // Nothing is known of the diagram, so the next draw of the pane renders it again
    $.ui.log(`render not kept: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' })
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
    // Reopening the pane tries again what failed
    await update($, results, all => Object.fromEntries(Object.entries(all).filter(([, result]) => result.status === 'drawn')))
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
    const { Button } = $.ui.resolve(e)
    const notice = (text: string): RenderElement => tonedText({ text, tone: 'neutral', wrap: true })
    const list = await read($, diagrams)
    const at = Math.min(await read($, shown), Math.max(list.length - 1, 0))
    const current = list[at]
    const paneColumns = e.props.bodyColumns ?? 80
    // The card spends 2 columns on its border and 2 on its padding: the drawing has the rest
    const width = Math.max(paneColumns - 4, 1)
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
        notice("No Mermaid diagram in this conversation yet. This pane shows the diagrams in Claude's replies, the most recent first."),
      ]
    } else if (!isTerminal) {
      body = [notice('Drawing the diagram needs the terminal. Its Mermaid source is shown.'), code({ source: current, plain: true })]
    } else if (await read($, isSource)) {
      body = [code({ source: current })]
    } else if (known === undefined) {
      body = [notice('rendering…')]
    } else if (known.status === 'failed') {
      body = [notice(known.reason), code({ source: current })]
    } else {
      const lines = known.text.split('\n')
      const isWide = lines.some(line => [...line].length > width)
      body = [
        ...(isWide ? [notice('The diagram is wider than the pane: the right part is cut off.')] : []),
        code({ source: isWide ? lines.map(line => [...line].slice(0, width).join('')).join('\n') : known.text }),
      ]
    }

    // Only the terminal can show a drawing, so only there is there a view to switch to
    const showsSource = await read($, isSource)
    const controls: RenderElement[] =
      current === undefined
        ? []
        : [
            ...(isTerminal
              ? [
                  <Button key="toggle-source" onPress={() => update($, isSource, value => !value)}>
                    {actionLabel({ text: showsSource ? 'Show drawing' : 'Show source' })}
                  </Button>,
                ]
              : []),
            // Paging stays inside the list: the pager draws no button that would leave it
            pagination({
              key: 'page',
              current: at + 1,
              pageCount: list.length,
              Button,
              onPrevious: () => update($, shown, () => Math.max(0, at - 1)),
              onNext: () => update($, shown, () => Math.min(list.length - 1, at + 1)),
            }),
          ]

    return card({
      width: paneColumns,
      title: 'Mermaid diagrams',
      meta: current === undefined ? undefined : `${at + 1} of ${list.length}`,
      children: [...body, ...controls],
    })
  })
}
