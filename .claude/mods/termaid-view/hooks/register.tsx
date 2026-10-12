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
// The termaid theme picked in the pane, or `none` for termaid's plain drawing; empty until one is picked, and then
// the drawings are in the default theme of the mod's options
const theme = atom({ plugin: 'termaid-view', key: 'theme' } as const, '')
// Whether a reply's diagrams are drawn in the transcript too, in place of their Mermaid block
const isInline = atom({ plugin: 'termaid-view', key: 'isInline' } as const, true)
// The way each flowchart is laid out when the person chose one, by the diagram's source; one with no entry is laid
// out in the default direction of the mod's options
const directions = atom({ plugin: 'termaid-view', key: 'directions' } as const, {} as Record<string, string>)

// The pane's own word for the direction the diagram was written in
const AS_WRITTEN = 'as written'
// The ways a flowchart can be laid out. Right to left is left out: termaid draws its labels mirrored.
const DIRECTIONS = ['TD', 'LR', 'BT'] as const

// A flowchart's opening line, as far as its direction
const HEADER = /^([ \t]*(?:flowchart|graph)\b)(?:[ \t]+(TB|TD|BT|RL|LR)\b)?/im

// Only a flowchart is laid out in a direction of its header
const isFlowchart = (source: string): boolean => /^(flowchart|graph)\b/i.test(source.trimStart())

// The diagram laid out the way chosen for it: its header's direction replaced, or added
const directed = (source: string, direction: string | undefined): string =>
  direction !== undefined && (DIRECTIONS as readonly string[]).includes(direction) && isFlowchart(source)
    ? source.replace(HEADER, `$1 ${direction}`)
    : source


// The columns of a transcript row a drawing does not have: the reply's indent each side
const INLINE_INDENT = 2

// The one place termaid's version is fixed: the code `uvx` fetches and runs changes only when this does
const TERMAID_VERSION = '0.5.0'
const RENDER_TIMEOUT_MS = 60_000

// What a linked node opened in the pane, in place of the diagrams: a file from one of its lines, the file's
// uncommitted changes, or why neither can be shown. `link` is the target as the diagram wrote it.
type Opened =
  | { link: string; path: string; kind: 'code'; first: number; total: number; text: string }
  | { link: string; path: string; kind: 'diff'; text: string; isCut: boolean }
  | { link: string; reason: string }
const opened = atom({ plugin: 'termaid-view', key: 'opened' } as const, null as Opened | null)

// The lines of a file shown at once, and the most lines of a diff
const CODE_LINES = 40
const DIFF_LINES = 400
// The lines kept above the one a node points at
const LINES_ABOVE = 3
const DIFF_TIMEOUT_MS = 10_000

// What Claude is told, so that the diagrams it writes have nodes to press
const LINKS_HINT = {
  id: 'termaid-view:links',
  scope: 'session',
  text: [
    'When a node of a Mermaid flowchart you write stands for code in this project, link it, one line per node after',
    'the edges: `click A href "src/parse.ts#L12"` opens that file at that line, and `click A href "diff:src/parse.ts"`',
    "opens the file's uncommitted changes. Paths are relative to the project. The person presses the node to open it.",
  ].join(' '),
} as const

// What is known of a diagram at a width, in a theme: drawn (the text, and in a theme or with linked nodes its lines
// run by run with their colors and links), or failed (kept so it is not retried on every redraw). Keyed by width,
// theme and source. One with no result yet is being drawn, or about to be.
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
const LINKED = 'A node with a link opens its code or its changes here: press it.'

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

// A node's link as Mermaid writes it: `click A href "target"`, or `click A "target"`
const CLICK = /^[ \t]*click[ \t]+(\S+)[ \t]+(?:href[ \t]+)?"([^"\n]+)"/gim

// The target of each linked node of a diagram, by the node's id
const linksOf = (source: string): Record<string, string> =>
  Object.fromEntries([...source.matchAll(CLICK)].map(match => [match[1] ?? '', (match[2] ?? '').trim()]))

// Where a link leads: a file of the project and a line of it, or the file's uncommitted changes. Nothing when it
// leads out of the project (a diagram is text Claude wrote, from what it read) or names no file.
const targetOf = (link: string): { kind: 'code'; path: string; line: number } | { kind: 'diff'; path: string } | undefined => {
  const isDiff = /^diff:/i.test(link)
  const match = /^(.*?)(?:#L(\d+)(?:-L?\d+)?|:(\d+))?$/.exec(isDiff ? link.slice('diff:'.length) : link)
  const path = (match?.[1] ?? '').trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '')
  const isOutside = /^([A-Za-z]:|\/|~|-)/.test(path) || path.split('/').includes('..')
  if (path === '' || isOutside) return undefined

  return isDiff ? { kind: 'diff', path } : { kind: 'code', path, line: Math.max(Number(match?.[2] ?? match?.[3] ?? 1), 1) }
}

// Reads what a link leads to and puts it in the pane: a file from `from` (absent, from just above the line the
// link names), or its changes. Reading is done here, on a press: drawing is pure.
const show = async ($: Engine, link: string, from?: number): Promise<void> => {
  const target = targetOf(link)
  let next: Opened

  if (target === undefined) {
    next = { link, reason: `"${link}" is not a file of this project.` }
  } else if (target.kind === 'code') {
    try {
      const lines = (await $.fs.read(target.path)).replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n')
      const first = Math.min(Math.max(from ?? target.line - LINES_ABOVE, 1), Math.max(lines.length, 1))
      next = {
        link,
        path: target.path,
        kind: 'code',
        first,
        total: lines.length,
        text: lines.slice(first - 1, first - 1 + CODE_LINES).join('\n'),
      }
    } catch {
      next = { link, reason: `${target.path} could not be read.` }
    }
  } else {
    try {
      const run = await $.process.run(['git', 'diff', 'HEAD', '--', target.path], { timeoutMs: DIFF_TIMEOUT_MS })
      // The hunks alone: what stands before the first is git's own header
      const hunks = run.stdout.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n')
      const lines = hunks.slice(Math.max(hunks.findIndex(line => line.startsWith('@@')), 0))
      if (run.exitCode !== 0) next = { link, reason: run.stderr.trim() !== '' ? run.stderr.trim() : `git diff failed for ${target.path}.` }
      else if (!lines.some(line => line.startsWith('@@'))) next = { link, reason: `${target.path} has no uncommitted change.` }
      else next = { link, path: target.path, kind: 'diff', text: lines.slice(0, DIFF_LINES).join('\n'), isCut: lines.length > DIFF_LINES }
    } catch (error) {
      next = { link, reason: `git could not be run: ${error instanceof Error ? error.message : String(error)}` }
    }
  }

  await update($, opened, () => next)
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
      // A theme is painted, and linked nodes are found, through termaid's Python API (see `themed.ts`); the plain
      // drawing of a diagram with no link is its command line's
      const links = linksOf(source)
      const isScripted = isTheme(painted) || Object.keys(links).length > 0
      const run = isScripted
        ? await $.process.run(['uvx', '--from', `termaid[rich]==${TERMAID_VERSION}`, 'python', '-c', BOOTSTRAP], {
            stdin: JSON.stringify({ script: THEMED_SCRIPT, source, theme: painted, width, links }),
            timeoutMs: RENDER_TIMEOUT_MS,
            env,
          })
        : await $.process.run(['uvx', `termaid==${TERMAID_VERSION}`, '--width', String(width)], {
            stdin: source,
            timeoutMs: RENDER_TIMEOUT_MS,
            env,
          })
      if (run.exitCode === 0 && isScripted) {
        const lines = linesOf(run.stdout)
        result =
          lines === undefined
            ? { status: 'failed', reason: isTheme(painted) ? `The drawing in the ${painted} theme could not be read.` : 'The drawing could not be read.' }
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

const hasLinks = (lines: readonly (readonly StyledSpan[])[]): boolean => lines.some(line => line.some(span => span.link !== undefined))

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

export const register: Register = (on, options) => {
  // The theme of the drawings until one is picked in the pane: the mod's `defaultTheme` option
  const asked = options.defaultTheme
  const defaultTheme = typeof asked === 'string' && isTheme(asked) ? asked : NO_THEME
  // The way a flowchart is laid out until a direction is picked for it: the mod's `defaultDirection` option
  const wanted = options.defaultDirection
  const defaultDirection = wanted === AS_WRITTEN || (DIRECTIONS as readonly string[]).includes(String(wanted)) ? String(wanted) : 'TD'

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'termaid', description: "Open the pane of the session's Mermaid diagrams" })

    return next(e)
  })

  on('prompt.compose', async (_, e, next) => {
    const composed = await next(e)

    return { ...composed, sections: [...composed.sections.filter(section => section.id !== LINKS_HINT.id), LINKS_HINT] }
  })

  on('command.run', { command: 'termaid' }, async $ => {
    await update($, opened, () => null)
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

    const { Box, Button, Markdown } = $.ui.resolve(e)
    // A linked node pressed in the chat opens in the pane, which is opened for it
    const press = async (link: string): Promise<void> => {
      await show($, link)
      await $.ui.open({ id: PANE, title: 'Mermaid diagrams' })
    }
    const stored = await read($, theme)
    const painted = stored === NO_THEME || isTheme(stored) ? stored : defaultTheme
    const width = Math.max((e.viewport?.columns ?? 80) - 2 * INLINE_INDENT, 1)
    const all = await read($, results)
    const chosen = await read($, directions)

    // The reply as pieces: its text (with the blocks that stay as written), and the drawings
    const pieces: (string | { lines: StyledSpan[][]; source: string })[] = []
    let text = ''
    for (const part of parts) {
      if (part.kind === 'text') {
        text += part.text
        continue
      }
      const laidOut = directed(part.source, chosen[part.source] ?? defaultDirection)
      const known = all[keyOf(laidOut, width, painted)]
      if (known === undefined) ask($, laidOut, width, painted)
      if (known?.status !== 'drawn') {
        text += part.raw
        continue
      }
      if (text.trim() !== '') pieces.push(text)
      text = ''
      pieces.push({ lines: linesFor(known), source: part.source })
    }

    // Under a flowchart, a button that lays it out the next way: each direction in turn, then as written
    const turn = (source: string, index: number): RenderElement => {
      const ways = [...DIRECTIONS, AS_WRITTEN]
      const now = chosen[source] ?? defaultDirection
      const following = ways[(ways.indexOf(now) + 1) % ways.length] ?? AS_WRITTEN

      return (
        <Button
          key={`direction-${index}`}
          plain
          dimColor
          onPress={() => update($, directions, all => ({ ...all, [source]: following }))}
        >{`Direction: ${now}`}</Button>
      )
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
          <Box
            key={`piece-${index}`}
            flexDirection="column"
            paddingLeft={INLINE_INDENT}
            marginTop={index === 0 && opening === undefined ? 0 : 1}
          >
            {typeof piece === 'string' ? (
              <Markdown text={piece.trim()} />
            ) : (
              styledLines({ lines: piece.lines, width, key: `node-${index}`, Button, onLinkPress: press })
            )}
            {typeof piece !== 'string' && isFlowchart(piece.source) ? turn(piece.source, index) : null}
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

    // What a linked node opened stands in place of the diagrams until the person goes back
    const open = await read($, opened)
    if (open !== null) {
      const back = (
        <Button key="back" onPress={() => update($, opened, () => null)}>
          {actionLabel({ text: 'Back to the diagram' })}
        </Button>
      )
      if ('reason' in open) return card({ width: paneColumns, title: open.link, children: [notice(open.reason), back] })
      if (open.kind === 'diff') {
        return card({
          width: paneColumns,
          title: open.path,
          meta: 'uncommitted changes',
          children: [
            ...(open.isCut ? [notice(`Only the first ${DIFF_LINES} lines of the changes are shown.`)] : []),
            code({ source: open.text, diff: true, plain: !isTerminal }),
            back,
          ],
        })
      }

      const last = Math.min(open.first + CODE_LINES - 1, open.total)

      return card({
        width: paneColumns,
        title: open.path,
        meta: `lines ${open.first}-${last} of ${open.total}`,
        children: [
          code({ source: open.text, path: open.path, startLine: open.first, plain: !isTerminal }),
          back,
          // The pager only says which way there are more lines: its page numbers are not shown
          pagination({
            key: 'lines',
            current: open.first > 1 ? 2 : 1,
            pageCount: (open.first > 1 ? 2 : 1) + (last < open.total ? 1 : 0),
            Button,
            onPrevious: () => show($, open.link, Math.max(open.first - CODE_LINES, 1)),
            onNext: () => show($, open.link, open.first + CODE_LINES),
          }),
        ],
      })
    }

    const stored = await read($, theme)
    const painted = stored === NO_THEME || isTheme(stored) ? stored : defaultTheme
    // The diagram as it is drawn: laid out the way chosen for it, when one was
    const way = current === undefined ? undefined : ((await read($, directions))[current] ?? defaultDirection)
    const laidOut = current === undefined ? undefined : directed(current, way)
    const known = laidOut === undefined || !isTerminal ? undefined : (await read($, results))[keyOf(laidOut, width, painted)]

    // Only the diagram shown is rendered, and only when nothing is known of it at this width in this theme
    if (laidOut !== undefined && isTerminal && known === undefined) ask($, laidOut, width, painted)

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
      // A themed drawing, or one with linked nodes: its lines in the colors termaid's theme gave them, cut at the
      // pane's width, a linked node a button that opens what it points at
      body = [
        ...(styledWidth(known.lines) > width ? [notice(CUT_OFF)] : []),
        styledLines({ lines: known.lines, width, key: 'node', Button, onLinkPress: link => show($, link) }),
        ...(hasLinks(known.lines) ? [notice(LINKED)] : []),
      ]
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
                  // Only a flowchart has a direction; a pick of anything else changes nothing
                  ...(isFlowchart(current)
                    ? [
                        <Select
                          key="direction"
                          label="Direction"
                          options={[...DIRECTIONS, AS_WRITTEN].map(value => ({ value }))}
                          value={way !== undefined && (DIRECTIONS as readonly string[]).includes(way) ? way : AS_WRITTEN}
                          onSelect={value => {
                            if (value === AS_WRITTEN || (DIRECTIONS as readonly string[]).includes(value)) {
                              void update($, directions, all => ({ ...all, [current]: value }))
                            }
                          }}
                        />,
                      ]
                    : []),
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
