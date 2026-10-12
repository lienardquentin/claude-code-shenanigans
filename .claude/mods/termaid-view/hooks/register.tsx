import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import { card } from './kit/card'
import { code } from './kit/code'
import { actionLabel } from './kit/action-label'
import { pagination } from './kit/pagination'
import { tonedText } from './kit/toned-text'
import { styledLines, styledWidth } from './kit/styled-lines'
import type { StyledSpan } from './kit/styled-lines'
import { BOOTSTRAP, NO_THEME, THEMED_SCRIPT, THEMES } from './themed'

const PANE = 'termaid-view'

type Engine = EngineInterface

// The Mermaid source of each diagram of the main conversation, in the order written, and the one the pane shows
const diagrams = atom({ plugin: 'termaid-view', key: 'diagrams' } as const, [] as string[])
const shown = atom({ plugin: 'termaid-view', key: 'shown' } as const, 0)
// Whether the Mermaid source is shown in place of the drawing; it stays as set while paging
const isSource = atom({ plugin: 'termaid-view', key: 'isSource' } as const, false)
// The termaid theme the drawings are painted in, or `none` for termaid's plain drawing
const theme = atom({ plugin: 'termaid-view', key: 'theme' } as const, NO_THEME as string)
// Whether a reply's diagrams are drawn in the transcript too, in place of their Mermaid block
const isInline = atom({ plugin: 'termaid-view', key: 'isInline' } as const, true)

// The columns of a transcript row a drawing does not have: the reply's indent each side
const INLINE_INDENT = 2

// The one place termaid's version is fixed: the code `uvx` fetches and runs changes only when this does
const TERMAID_VERSION = '0.5.0'
const RENDER_TIMEOUT_MS = 60_000

// What is known of a diagram at a width, in a theme: drawn (the text, and in a theme its lines run by run with
// their colors), or failed (kept so it is not retried on every redraw). Keyed by width, theme and source. One with
// no result yet is being drawn, or about to be.
type Result = { status: 'drawn'; text: string; lines?: StyledSpan[][] } | { status: 'failed'; reason: string }
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

const CUT_OFF = 'The diagram is wider than the pane: the right part is cut off.'

// The engine's clock, in milliseconds; 0 when it cannot say (then no call is taken for a timeout by its duration)
const now = ($: Engine): Promise<number> => $.clock.now().catch(() => 0)

const keyOf = (source: string, width: number, painted: string): string => `${width}\u0000${painted}\u0000${source}`

const isTheme = (value: string): boolean => (THEMES as readonly string[]).includes(value)

// The lines the themed script printed, or nothing when its output is not that
const linesOf = (stdout: string): StyledSpan[][] | undefined => {
  try {
    const { lines } = JSON.parse(stdout) as { lines?: unknown }
    const isLines =
      Array.isArray(lines) &&
      lines.every(line => Array.isArray(line) && line.every(span => typeof (span as { text?: unknown } | null)?.text === 'string'))

    return isLines ? (lines as StyledSpan[][]) : undefined
  } catch {
    return undefined
  }
}

const render = async ($: Engine, source: string, width: number, painted: string): Promise<void> => {
  const key = keyOf(source, width, painted)
  inFlight.add(key)

  try {
    let result: Result
    const startedAt = await now($)
    // Piped, Python on Windows writes in the ANSI code page, which has no box-drawing characters
    const env = { PYTHONIOENCODING: 'utf-8' }
    try {
      // A theme is painted through termaid's Python API (see `themed.ts`); the plain drawing is its command line's
      const run = isTheme(painted)
        ? await $.process.run(['uvx', '--from', `termaid[rich]==${TERMAID_VERSION}`, 'python', '-c', BOOTSTRAP], {
            stdin: JSON.stringify({ script: THEMED_SCRIPT, source, theme: painted, width }),
            timeoutMs: RENDER_TIMEOUT_MS,
            env,
          })
        : await $.process.run(['uvx', `termaid==${TERMAID_VERSION}`, '--width', String(width)], {
            stdin: source,
            timeoutMs: RENDER_TIMEOUT_MS,
            env,
          })
      if (run.exitCode === 0 && isTheme(painted)) {
        const lines = linesOf(run.stdout)
        result =
          lines === undefined
            ? { status: 'failed', reason: `The drawing in the ${painted} theme could not be read.` }
            : { status: 'drawn', text: lines.map(line => line.map(span => span.text).join('')).join('\n'), lines }
      } else if (run.exitCode === 0) {
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

// A reply as what stands around its diagrams and the diagrams themselves, in the order written; `raw` is the
// diagram's whole fenced block
type Part = { kind: 'text'; text: string } | { kind: 'diagram'; source: string; raw: string }

const partsOf = (text: string): Part[] => {
  const whole = text.replace(/\r\n?/g, '\n')
  const parts: Part[] = []
  let from = 0

  for (const match of whole.matchAll(FENCE)) {
    const at = match.index ?? 0
    if (at > from) parts.push({ kind: 'text', text: whole.slice(from, at) })
    parts.push({ kind: 'diagram', source: (match[2] ?? '').replace(/\n$/, ''), raw: match[0] })
    from = at + match[0].length
  }
  if (from < whole.length) parts.push({ kind: 'text', text: whole.slice(from) })

  return parts
}

const diagramsOf = (text: string): string[] => partsOf(text).flatMap(part => (part.kind === 'diagram' ? [part.source] : []))

// Starts the render of a diagram nothing is known of, once: drawing is pure, so the work begins after the hook
// that asked has returned
const ask = ($: Engine, source: string, width: number, painted: string): void => {
  const key = keyOf(source, width, painted)
  if (inFlight.has(key)) return
  inFlight.add(key)
  setTimeout(() => void render($, source, width, painted), 0)
}

// A drawing's lines run by run: a theme's as termaid painted them, the plain drawing's as they are
const linesFor = (drawn: { text: string; lines?: StyledSpan[][] }): StyledSpan[][] =>
  drawn.lines ?? drawn.text.split('\n').map(line => [{ text: line }])

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

  // A reply's diagrams drawn where it wrote them: each Mermaid block termaid has drawn is replaced by its drawing,
  // in the pane's theme. One not drawn yet, or that cannot be, stays the block the reply wrote.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || !/mermaid/i.test(e.props.text)) return next(e)
    const parts = partsOf(e.props.text)
    if (!parts.some(part => part.kind === 'diagram') || !(await read($, isInline))) return next(e)

    const { Box, Markdown } = $.ui.resolve(e)
    const stored = await read($, theme)
    const painted = isTheme(stored) ? stored : NO_THEME
    const width = Math.max((e.viewport?.columns ?? 80) - 2 * INLINE_INDENT, 1)
    const all = await read($, results)

    // The reply as pieces: its text (with the blocks that stay as written), and the drawings
    const pieces: (string | StyledSpan[][])[] = []
    let text = ''
    for (const part of parts) {
      if (part.kind === 'text') {
        text += part.text
        continue
      }
      const known = all[keyOf(part.source, width, painted)]
      if (known === undefined) ask($, part.source, width, painted)
      if (known?.status !== 'drawn') {
        text += part.raw
        continue
      }
      if (text.trim() !== '') pieces.push(text)
      text = ''
      pieces.push(linesFor(known))
    }
    if (text.trim() !== '') pieces.push(text)
    if (!pieces.some(piece => typeof piece !== 'string')) return next(e)

    // What opens the reply is the engine's own drawing of it (its bullet, its indent); the rest lines up under it
    const [first, ...rest] = pieces
    const opening = typeof first === 'string' ? await next({ ...e, props: { ...e.props, text: first } }) : undefined
    const under = typeof first === 'string' ? rest : pieces

    return (
      <Box flexDirection="column">
        {opening}
        {under.map((piece, index) => (
          <Box key={`piece-${index}`} paddingLeft={INLINE_INDENT} marginTop={index === 0 && opening === undefined ? 0 : 1}>
            {typeof piece === 'string' ? <Markdown text={piece.trim()} /> : styledLines({ lines: piece, width })}
          </Box>
        ))}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Button, Select } = $.ui.resolve(e)
    const notice = (text: string): RenderElement => tonedText({ text, tone: 'neutral', wrap: true })
    const list = await read($, diagrams)
    const at = Math.min(await read($, shown), Math.max(list.length - 1, 0))
    const current = list[at]
    const paneColumns = e.props.bodyColumns ?? 80
    // The card spends 2 columns on its border and 2 on its padding: the drawing has the rest
    const width = Math.max(paneColumns - 4, 1)
    const isTerminal = e.surface === 'terminal'
    const stored = await read($, theme)
    const painted = isTheme(stored) ? stored : NO_THEME
    const known = current === undefined || !isTerminal ? undefined : (await read($, results))[keyOf(current, width, painted)]

    // Only the diagram shown is rendered, and only when nothing is known of it at this width in this theme
    if (current !== undefined && isTerminal && known === undefined) ask($, current, width, painted)

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
    } else if (known.lines !== undefined) {
      // A themed drawing: its lines in the colors termaid's theme gave them, cut at the pane's width
      body = [...(styledWidth(known.lines) > width ? [notice(CUT_OFF)] : []), styledLines({ lines: known.lines, width })]
    } else {
      const lines = known.text.split('\n')
      const isWide = lines.some(line => [...line].length > width)
      body = [
        ...(isWide ? [notice(CUT_OFF)] : []),
        code({ source: isWide ? lines.map(line => [...line].slice(0, width).join('')).join('\n') : known.text }),
      ]
    }

    // Only the terminal can show a drawing, so only there is there a view to switch to
    const showsSource = await read($, isSource)
    const showsInline = await read($, isInline)
    const controls: RenderElement[] =
      current === undefined
        ? []
        : [
            ...(isTerminal
              ? [
                  <Button key="toggle-source" onPress={() => update($, isSource, value => !value)}>
                    {actionLabel({ text: showsSource ? 'Show drawing' : 'Show source' })}
                  </Button>,
                  // A pick of anything but `none` or a theme termaid has changes nothing
                  <Select
                    key="theme"
                    label="Theme"
                    options={[NO_THEME, ...THEMES].map(value => ({ value }))}
                    value={painted}
                    onSelect={value => {
                      if (value === NO_THEME || isTheme(value)) void update($, theme, () => value)
                    }}
                  />,
                  <Button key="toggle-inline" onPress={() => update($, isInline, value => !value)}>
                    {actionLabel({ text: showsInline ? 'Hide in chat' : 'Show in chat' })}
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
