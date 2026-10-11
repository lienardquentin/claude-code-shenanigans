import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import type { HistoryEntry } from '../types'
import { MAX_NODES, looksLikeDiagram, mermaidBlocks, parseDiagram, shownLabel } from './diagram'
import type { Diagram, ParseResult } from './diagram'
import { drawDiagram, layoutDiagram } from './draw'
import { actionLabel } from './kit/action-label'
import { badge } from './kit/badge'
import { card } from './kit/card'
import { code } from './kit/code'
import { picture } from './kit/picture'
import { pixelImage } from './kit/pixel-image'
import { table } from './kit/table'
import { tonedText } from './kit/toned-text'
import { OS_NAMES, detectHost, detectOs, detectTerminal, drawsPixels, gaps, recommended, rowFor, tableFor, toneOfValue } from './guide'
import type { Env, Os } from './guide'
import { READ_ON } from './terminals'
import { rasterize } from './pixels'
import { vectorSvg } from './svg'
import { clipDrawing, clipRows, drawingWidth, rowSpanOfNode, spanOfNode, windowFor } from './window'

const PANE = 'mermaid-view'

type Engine = EngineInterface
type Drawn = Parameters<Engine['ui']['resolve']>[0]

// The Mermaid source the pane shows: the viewer's own, kept in this session
const source = atom({ plugin: 'mermaid-view', key: 'source' } as const, '')
// The node the viewer selected: also the pane's own
const selected = atom({ plugin: 'mermaid-view', key: 'selected' } as const, '')
// The diagrams seen this session, oldest first: from the command, from a file and from the replies
const history = atom({ plugin: 'mermaid-view', key: 'history' } as const, [] as HistoryEntry[])
// How far a drawing wider than the pane is moved to the left, in cells, and whether it is closed up to fit
const scrollX = atom({ plugin: 'mermaid-view', key: 'scrollX' } as const, 0)
const fit = atom({ plugin: 'mermaid-view', key: 'fit' } as const, false)
// And how far down: a drawing taller than the pane's room is moved up by this many rows
const scrollY = atom({ plugin: 'mermaid-view', key: 'scrollY' } as const, 0)
// Whether the pane shows the terminal guide in place of the diagram
const guide = atom({ plugin: 'mermaid-view', key: 'guide' } as const, false)
// The picture, by the viewer's choice: `auto` is on where the terminal is known to draw pixels and off elsewhere,
// `on` tries it in any terminal (an `Image` that cannot be drawn shows the drawing's text instead), `off` is cells
const pictureMode = atom({ plugin: 'mermaid-view', key: 'pictureMode' } as const, 'auto' as 'auto' | 'on' | 'off')

// The variables the guide reads to tell the terminal and the system. `$.env.get` takes a literal name, so each is
// asked for by name; guide.ts holds the rules that use them.
const environment = async ($: Engine): Promise<Env> => {
  const values: Record<string, string | undefined> = {
    OS: await $.env.get('OS'),
    HOME: await $.env.get('HOME'),
    TERM_PROGRAM: await $.env.get('TERM_PROGRAM'),
    WT_SESSION: await $.env.get('WT_SESSION'),
    KITTY_WINDOW_ID: await $.env.get('KITTY_WINDOW_ID'),
    WEZTERM_PANE: await $.env.get('WEZTERM_PANE'),
    ALACRITTY_WINDOW_ID: await $.env.get('ALACRITTY_WINDOW_ID'),
    GHOSTTY_RESOURCES_DIR: await $.env.get('GHOSTTY_RESOURCES_DIR'),
    ITERM_SESSION_ID: await $.env.get('ITERM_SESSION_ID'),
    KONSOLE_DBUS_SERVICE: await $.env.get('KONSOLE_DBUS_SERVICE'),
    XTERM_VERSION: await $.env.get('XTERM_VERSION'),
    TMUX: await $.env.get('TMUX'),
    STY: await $.env.get('STY'),
  }

  return name => values[name]
}

// Whether the diagram is drawn as pixels here. An environment that cannot be read is no reason to fail a draw: the
// answer is then no, and the cells are drawn.
const pixelsHere = async ($: Engine): Promise<boolean> => {
  try {
    return drawsPixels(await environment($))
  } catch {
    return false
  }
}
// The terminal guide: which terminal this is, what the research file says it can do, what it lacks and what to use
// instead on this system, and the recommended terminals and the table for each system. Everything it says about a
// terminal is that file's (see terminals.ts); nothing is guessed for a terminal it does not know.
const terminalGuide = async ($: Engine): Promise<RenderElement[]> => {
  const env = await environment($)
  const os = detectOs(env)
  const name = detectTerminal(env)
  const host = detectHost(env)
  const row = name === undefined ? undefined : rowFor(name, os)
  const hostRow = host === undefined ? undefined : rowFor(host)
  const systems: Os[] = os === undefined ? ['windows', 'macos', 'linux'] : [os]
  const where = os === undefined ? '' : ` on ${OS_NAMES[os]}`
  const parts: RenderElement[] = [badge({ label: 'Terminal guide', tone: 'info' })]

  if (row !== undefined) {
    parts.push(badge({ label: `Your terminal: ${row.name}${where}`, tone: 'accent' }))
    const missing = gaps(row, os)
    parts.push(
      code({
        source:
          missing.length === 0
            ? 'It has what the mod can use: pixel images, mouse reporting and clickable links.'
            : missing.join('\n'),
        plain: true,
      }),
    )
  } else {
    parts.push(
      badge({ label: `Your terminal: not recognised${where}`, tone: 'neutral' }),
      code({
        source:
          'The environment names no terminal the research file knows an identifier for, so nothing is claimed about ' +
          'yours. The tables below say what each terminal does.',
        plain: true,
      }),
    )
  }

  if (hostRow !== undefined) {
    parts.push(
      badge({ label: `Inside ${hostRow.name}`, tone: 'warning' }),
      code({
        source: [
          `Pixel images: ${hostRow.images.value}${hostRow.images.note !== '' ? ` (${hostRow.images.note})` : ''}`,
          `Mouse reporting: ${hostRow.mouse.value}${hostRow.mouse.note !== '' ? ` (${hostRow.mouse.note})` : ''}`,
        ].join('\n'),
        plain: true,
      }),
    )
  }

  parts.push(
    code({
      source:
        'The diagram is drawn as text, which any terminal shows. Pressing a node needs the terminal to report the ' +
        'mouse; without it, walk the diagram with Tab and Enter, or the Go to and Back to keys.',
      plain: true,
    }),
  )

  for (const system of systems) {
    const names = recommended(system).map(candidate => candidate.name)

    parts.push(
      badge({
        label: `Recommended on ${OS_NAMES[system]}: ${names.length > 0 ? names.join(', ') : 'none the research file marks for two or more'}`,
        tone: 'success',
      }),
      table({
        columns: [
          { header: 'Terminal', width: 30 },
          { header: 'Images', width: 9 },
          { header: 'Mouse', width: 9 },
          { header: 'Links', width: 9 },
        ],
        rows: tableFor(system).map(candidate => [
          `${candidate.name === row?.name && candidate.os === row.os ? '▸ ' : '  '}${candidate.name}`,
          { text: candidate.images.value, tone: toneOfValue(candidate.images.value) },
          { text: candidate.mouse.value, tone: toneOfValue(candidate.mouse.value) },
          { text: candidate.links.value, tone: toneOfValue(candidate.links.value) },
        ]),
      }),
    )
  }

  parts.push(
    code({
      source:
        `Recommended = the terminals the research file marks yes for two or more of images, mouse and links.\n` +
        `From docs/research/terminal-capabilities.md (sources read ${READ_ON}). unknown is not a claim of absence.`,
      plain: true,
    }),
  )

  return parts
}

const MAX_HISTORY = 20

// How a diagram is told apart in the list: its first node labels, or the first line of source it could not read
const titleOf = (text: string): string => {
  const parsed = parseDiagram(text)

  if (parsed.ok) {
    const labels = parsed.diagram.nodes.slice(0, 3).map(node => node.label)
    const more = parsed.diagram.nodes.length - labels.length

    return `${labels.join(', ')}${more > 0 ? ` +${more}` : ''}`
  }

  const first = Array.from(text.split('\n')[0] ?? '')

  return first.length > 30 ? `${first.slice(0, 29).join('')}…` : first.join('')
}

// Puts diagrams in the list and shows the last of them: one already there moves to the newest place, the list keeps
// the most recent few, and nothing selected carries over to a different diagram
const remember = async ($: Engine, sources: readonly string[]): Promise<void> => {
  const fresh = sources.map(text => text.trim()).filter(text => text !== '')
  const last = fresh[fresh.length - 1]
  if (last === undefined) return

  await update($, history, entries => {
    const kept = entries.filter(entry => !fresh.includes(entry.source))

    return [...kept, ...fresh.map(text => ({ source: text, title: titleOf(text) }))].slice(-MAX_HISTORY)
  })
  await update($, source, () => last)
  await update($, selected, () => '')
  await update($, scrollX, () => 0)
  await update($, scrollY, () => 0)
}

// A press on a node selects it; a press on the selected node clears the selection
const toggle = ($: Engine, id: string): Promise<void> =>
  update($, selected, current => (current === id ? '' : id))

// What the selected node connects to, by label, for the lines under the drawing
const connections = (diagram: Diagram, id: string): string[] => {
  const label = (nodeId: string): string => diagram.nodes.find(node => node.id === nodeId)?.label ?? nodeId
  const list = (ids: string[]): string => (ids.length === 0 ? 'none' : [...new Set(ids.map(label))].join(', '))

  return [
    `Leads to: ${list(diagram.edges.filter(edge => edge.from === id).map(edge => edge.to))}`,
    `Reached from: ${list(diagram.edges.filter(edge => edge.to === id).map(edge => edge.from))}`,
  ]
}

// The row of a node's box a Button stands for: the middle one carries the plain key
const ROW_KEY = ['-top', '', '-bottom'] as const

// How many lines of a file a `click` directive names are shown
const FILE_LINES = 40

// Why a diagram is not drawn, in a sentence: which kind it is, or which line of the source stopped it and what it
// holds that is not drawn
const explain = (failed: Extract<ParseResult, { ok: false }>): string => {
  const { problem } = failed

  if (problem.kind === 'type') return `${problem.what} diagrams are not drawn yet: only flowcharts are. Its source:`
  if (problem.kind === 'unsupported') {
    return `Line ${failed.number}: ${problem.what} is not drawn yet, so the diagram is not drawn. At: ${failed.line}`
  }

  return failed.line === ''
    ? 'Could not read this diagram: it is empty'
    : `Could not read this diagram at line ${failed.number}: ${failed.line}`
}

// What the card holds: the drawing, or a note saying why there is none. The source is shown beside a note about it,
// so the reader can see what could not be read.
const content = async (
  $: Engine,
  e: Drawn,
  text: string,
  chosen: string,
  view: {
    width: number
    offset: number
    rows?: number
    offsetY: number
    fit: boolean
    pixels: boolean
    canPixels: boolean
  },
): Promise<RenderElement[]> => {
  if (text === '') return [badge({ label: 'No diagram yet: run /mermaid-view with a flowchart', tone: 'neutral' })]

  const parsed = parseDiagram(text)

  if (!parsed.ok) {
    return [badge({ label: explain(parsed), tone: 'warning' }), code({ source: text, plain: true })]
  }

  const { diagram } = parsed

  if (diagram.nodes.length === 0) return [badge({ label: 'This diagram has no nodes', tone: 'warning' })]

  if (diagram.nodes.length > MAX_NODES) {
    return [
      badge({
        label: `This diagram has ${diagram.nodes.length} nodes; more than ${MAX_NODES} are not drawn. Its source:`,
        tone: 'warning',
      }),
      code({ source: text, plain: true }),
    ]
  }

  const { Box, Button, Link } = $.ui.resolve(e)
  const known = diagram.nodes.some(node => node.id === chosen) ? chosen : ''
  const { rows: drawing, geometry } = layoutDiagram(diagram, known)
  const node = diagram.nodes.find(candidate => candidate.id === known)

  // What a `click` directive of the selected node leads to. A web address is shown as a link, which the surface
  // opens as it opens any link; a file of the project is shown by its first lines. Nothing is started from here, so
  // an address a diagram names is never run: another kind of address is said not to be followed.
  const target: RenderElement[] = []

  if (node?.link !== undefined) {
    const { kind, target: where } = node.link

    if (kind === 'url') {
      target.push(
        <Box key="link" flexDirection="row" gap={1}>
          {tonedText({ text: 'Link:', tone: 'info' })}
          <Link href={where}>{where}</Link>
        </Box>,
      )
    } else if (kind === 'file') {
      try {
        const lines = String(await $.fs.read(where)).split('\n')
        const more = lines.length - FILE_LINES

        target.push(
          badge({ label: `File: ${where}`, tone: 'info' }),
          code({ source: `${lines.slice(0, FILE_LINES).join('\n')}${more > 0 ? `\n… ${more} more lines` : ''}`, plain: true }),
        )
      } catch (error) {
        target.push(
          badge({
            label: `Could not read ${where}: ${error instanceof Error ? error.message : String(error)}`,
            tone: 'warning',
          }),
        )
      }
    } else {
      target.push(
        badge({
          label: `Not followed: ${where}. Only web addresses (http, https) and files inside the project are.`,
          tone: 'warning',
        }),
      )
    }
  }

  // Moving the selection along an edge: set where the window follows in the terminal's view, below
  let moveTo = (id: string): Promise<void> => update($, selected, () => id)

  // The nodes the selected one leads to, then those that lead to it, in the order their edges are written: each is a
  // button with a hotkey (a digit for where it leads, a letter for where it is reached from), so the order is shown
  // and the walk needs no mouse
  const labelOf = (id: string): string => diagram.nodes.find(candidate => candidate.id === id)?.label ?? id
  const ends = (pick: 'to' | 'from'): string[] => {
    const other = pick === 'to' ? 'from' : 'to'

    return [
      ...new Set(
        diagram.edges.filter(edge => edge[other] === node?.id && edge[pick] !== node?.id).map(edge => edge[pick]),
      ),
    ]
  }
  const walkRow = (key: string, title: string, ids: string[], hotkeys: string): RenderElement | null =>
    ids.length === 0 ? null : (
      <Box key={key} flexDirection="row" gap={1}>
        {tonedText({ text: title, tone: 'neutral' })}
        {ids.slice(0, hotkeys.length).map((id, index) => (
          <Button
            key={`${key === 'walk-out' ? 'go' : 'back'}-${id}`}
            plain
            hotkey={hotkeys[index] as string}
            onPress={() => moveTo(id)}
          >
            {labelOf(id)}
          </Button>
        ))}
      </Box>
    )

  // What is shown about the selected node, under the drawing or the picture
  const details: RenderElement[] =
    node === undefined
      ? []
      : [
          badge({ label: `Selected: ${node.label}`, tone: 'accent' }),
          code({ source: connections(diagram, node.id).join('\n'), plain: true }),
          ...[walkRow('walk-out', 'Go to', ends('to'), '123456789'), walkRow('walk-in', 'Back to', ends('from'), 'abcde')].filter(
            (row): row is RenderElement => row !== null,
          ),
          ...target,
          <Box key="node-actions" flexDirection="row" gap={1}>
            <Button
              key="send-to-claude"
              onPress={() =>
                $.prompt.fill({
                  text: `About the "${node.label}" node of the diagram (${connections(diagram, node.id)
                    .join('; ')
                    .toLowerCase()}${node.link !== undefined ? `; it points to ${node.link.target}` : ''}): `,
                  mode: 'append',
                })
              }
            >
              {actionLabel({ text: 'Send to Claude' })}
            </Button>
            <Button key="copy-label" onPress={press => $.ui.copy({ text: node.label, surface: press.surface })}>
              {actionLabel({ text: 'Copy label' })}
            </Button>
            <Button key="clear-selection" onPress={() => update($, selected, () => '')}>
              {actionLabel({ text: 'Clear' })}
            </Button>
          </Box>,
        ]

  // One button per node: the fallback view's way to select, and the picture's
  const nodeButtons = (
    <Box key="node-buttons" flexDirection="row" flexWrap="wrap" gap={1}>
      {diagram.nodes.map(node => (
        <Button key={`node-${node.id}`} onPress={() => toggle($, node.id)}>
          {tonedText({
            text: shownLabel(node),
            ...(node.id === known
              ? { tone: 'accent' as const, bold: true }
              : node.tone !== undefined
                ? { tone: node.tone }
                : {}),
          })}
        </Button>
      ))}
    </Box>
  )

  // The fallback view: a surface that is not the terminal (the desktop, VS Code, mobile) is given a still picture of
  // the drawing and one button per node, because a node's box cannot be known to keep its shape as native buttons
  if (e.surface !== 'terminal') {
    const { source: svg, width, height } = vectorSvg(geometry)
    const still = picture({
      source: svg,
      alt: `Diagram of ${diagram.nodes.length} nodes: ${diagram.nodes.map(node => node.label).join(', ')}`,
      width,
      height,
    })

    return [
      badge({
        label: 'Fallback view: this surface cannot draw clickable nodes, so each node has a button under the picture',
        tone: 'info',
      }),
      ...(still === undefined
        ? [badge({ label: 'This diagram is too large to draw as a picture; use the node buttons', tone: 'warning' })]
        : [still]),
      nodeButtons,
      ...details,
    ]
  }

  // A terminal that draws pixels is given the drawing as a picture, which has no press of its own: the buttons of the
  // nodes stand beside it. A drawing past what an Image takes stays as cells.
  if (view.pixels) {
    const raster = rasterize(drawing)
    const alt = drawing.map(row => row.map(segment => segment.text).join('')).join('\n')
    const still = raster === undefined ? undefined : pixelImage({ ...raster, alt })

    if (still !== undefined) {
      return [
        <Button key="picture-toggle" onPress={() => update($, pictureMode, () => 'off')}>
          {actionLabel({ text: 'Picture: on' })}
        </Button>,
        still,
        nodeButtons,
        ...details,
      ]
    }
  }

  // A drawing wider than the pane is shown through a window that moves by the buttons above it; the fit-width view
  // closes the nodes up first, and the window is only used for what still does not fit
  const normal = drawing
  const laid = view.fit ? drawDiagram(diagram, known, { compact: true }) : normal
  const total = drawingWidth(laid)
  const maxOffset = Math.max(0, total - view.width)
  const offset = Math.min(view.offset, maxOffset)
  const across = total > view.width ? clipDrawing(laid, offset, view.width) : laid
  const step = Math.max(1, Math.floor(view.width / 2))

  // And down: a drawing taller than the room the pane has is shown through a window too, so that it can be moved
  // from the keyboard whatever the pane's own scrolling is doing
  const room = view.rows
  const maxOffsetY = room === undefined ? 0 : Math.max(0, laid.length - room)
  const offsetY = Math.min(view.offsetY, maxOffsetY)
  const shown = room !== undefined && laid.length > room ? clipRows(across, offsetY, room) : across
  const stepY = Math.max(1, Math.floor((room ?? 10) / 2))

  // Pressing a node selects it, and moves the window so that the whole box shows, as far as it can. Walking to a node
  // along an edge does the same, but never clears the selection.
  const reveal = async (id: string, isWalk = false): Promise<void> => {
    await (isWalk ? update($, selected, () => id) : toggle($, id))

    const span = spanOfNode(laid, id)
    if (span !== undefined) await update($, scrollX, current => windowFor(Math.min(current, maxOffset), view.width, span))

    const down = rowSpanOfNode(laid, id)
    if (down !== undefined && room !== undefined) {
      await update($, scrollY, current => windowFor(Math.min(current, maxOffsetY), room, down))
    }
    // Down the pane: the engine scrolls its body to the box. A surface that cannot is no reason to fail the press.
    try {
      await $.ui.scroll({ to: { key: `node-${id}` }, in: PANE })
    } catch {
      // nothing to scroll
    }
  }
  moveTo = id => reveal(id, true)

  // The controls: a button for each way the window can move, each with a key that works whatever part of the
  // pane is in view, and the fit-width toggle. They are there only when the drawing does not fit.
  const overflows = total > view.width || (room !== undefined && laid.length > room)
  const controls: RenderElement[] =
    overflows || drawingWidth(normal) > view.width || view.fit
      ? [
          <Box key="view-controls" flexDirection="row" gap={2}>
            {offset > 0 ? (
              <Button key="scroll-left" plain hotkey="h" onPress={() => update($, scrollX, () => Math.max(0, offset - step))}>
                ◀ Left
              </Button>
            ) : null}
            {offset < maxOffset ? (
              <Button
                key="scroll-right"
                plain
                hotkey="l"
                onPress={() => update($, scrollX, () => Math.min(maxOffset, offset + step))}
              >
                Right ▶
              </Button>
            ) : null}
            {offsetY > 0 ? (
              <Button key="scroll-up" plain hotkey="k" onPress={() => update($, scrollY, () => Math.max(0, offsetY - stepY))}>
                ▲ Up
              </Button>
            ) : null}
            {offsetY < maxOffsetY ? (
              <Button
                key="scroll-down"
                plain
                hotkey="j"
                onPress={() => update($, scrollY, () => Math.min(maxOffsetY, offsetY + stepY))}
              >
                ▼ Down
              </Button>
            ) : null}
            {drawingWidth(normal) > view.width || view.fit ? (
              <Button key="fit-width" plain hotkey="f" onPress={() => update($, fit, current => !current)}>
                {view.fit ? 'Fit width: on' : 'Fit width: off'}
              </Button>
            ) : null}
          </Box>,
          tonedText({
            text: `Showing columns ${offset + 1}-${Math.min(total, offset + view.width)} of ${total}${
              room !== undefined && laid.length > room ? `, rows ${offsetY + 1}-${Math.min(laid.length, offsetY + room)} of ${laid.length}` : ''
            }. Keys: h l move across, k j move down, f fit width.`,
            tone: 'neutral',
          }),
        ]
      : []

  // Each row of the drawing is a row of pieces; a piece of a node's box is a plain Button, so a press anywhere on the
  // box selects the node and the box keeps its shape
  const rows = shown.map((segments, index) => (
    <Box key={`row-${index}`} flexDirection="row">
      {segments.map((segment, at) => {
        // The selection is accented; a node the author marked out is in its tone; the rest is as it comes
        const label = tonedText({
          text: segment.text,
          ...(segment.hot
            ? { tone: 'accent' as const, bold: true }
            : segment.tone !== undefined
              ? { tone: segment.tone }
              : {}),
        })

        if (segment.node === undefined) return <Box key={`row-${index}-${at}`}>{label}</Box>

        const id = segment.node

        return (
          <Button key={`node-${id}${ROW_KEY[segment.row ?? 1]}`} plain onPress={() => reveal(id)}>
            {label}
          </Button>
        )
      })}
    </Box>
  ))

  // The way to the picture: back to it once it was turned off, or a try of it in a terminal not known to draw
  // pixels (what the picture cannot be drawn as is its text, so a try costs nothing). A picture that does not fit
  // an Image is not offered.
  const pictureToggle: RenderElement[] =
    !view.pixels && rasterize(drawing) !== undefined
      ? [
          <Button key="picture-toggle" onPress={() => update($, pictureMode, () => 'on')}>
            {actionLabel({ text: view.canPixels ? 'Picture: off' : 'Picture: try' })}
          </Button>,
        ]
      : []

  return [...pictureToggle, ...controls, ...rows, ...details]
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'mermaid-view',
      description: 'Shows a Mermaid flowchart in a pane',
      argumentHint: '<diagram text>',
    })

    return next(e)
  })

  // The argument is diagram text, or the path of a file: a ```mermaid block of a markdown file, each one, or the
  // whole file when it has none
  on('command.run', { command: 'mermaid-view' }, async ($, e) => {
    const argument = e.args.trim()

    if (argument !== '' && looksLikeDiagram(argument)) {
      await remember($, [argument])
    } else if (argument !== '') {
      let text: string

      try {
        text = String(await $.fs.read(argument))
      } catch (error) {
        return { text: `Could not read ${argument}: ${error instanceof Error ? error.message : String(error)}` }
      }

      const blocks = mermaidBlocks(text)
      // The first block ends as the newest, so it is the one shown
      await remember($, blocks.length > 0 ? [...blocks].reverse() : [text])
    }

    await $.ui.open({ id: PANE, title: 'Mermaid diagram' })

    return { text: 'Mermaid diagram pane opened.' }
  })

  // A diagram a reply of Claude's holds is put in the list and shown, so the pane has what was just drawn
  // Only the main loop's own answer: what a subagent hands back is its spawner's to say
  on('turn.complete', async ($, e, next) => {
    const blocks = e.agentId === undefined ? mermaidBlocks(e.answer) : []

    if (blocks.length > 0) await remember($, blocks)

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button } = $.ui.resolve(e)
    const entries = await read($, history)
    const shown = await read($, source)

    // The diagrams of the session, newest first, when there is more than one to choose between
    const list =
      entries.length > 1
        ? [
            badge({ label: 'Diagrams this session', tone: 'neutral' }),
            <Box key="history" flexDirection="column">
              {[...entries.entries()].reverse().map(([index, entry]) => (
                <Button
                  key={`history-${index}`}
                  plain
                  onPress={async () => {
                    await update($, source, () => entry.source)
                    await update($, selected, () => '')
                    await update($, scrollX, () => 0)
                    await update($, scrollY, () => 0)
                  }}
                >
                  {tonedText({
                    text: `${entry.source === shown ? '▸' : ' '} ${index + 1}. ${entry.title}`,
                    ...(entry.source === shown ? { tone: 'accent' as const } : {}),
                  })}
                </Button>
              ))}
            </Box>,
          ]
        : []

    const guided = await read($, guide)
    const mode = await read($, pictureMode)
    // A picture only where the terminal surface's Image draws pixels
    const canPixels = e.surface === 'terminal' && (await pixelsHere($))

    // The guide takes the pane's place while it is on, and a button on either puts the other back
    const toggleGuide = (
      <Button key="terminals" onPress={() => update($, guide, current => !current)}>
        {actionLabel({ text: guided ? 'Back to the diagram' : 'Terminals' })}
      </Button>
    )

    return card({
      width: e.props.bodyColumns ?? 80,
      title: guided ? 'Terminal guide' : 'Mermaid diagram',
      children: guided
        ? [toggleGuide, ...(await terminalGuide($))]
        : [
            ...(await content($, e, shown, await read($, selected), {
              // Inside the card's frame and padding
              width: Math.max(10, (e.props.bodyColumns ?? 80) - 4),
              offset: await read($, scrollX),
              ...(e.props.scroll !== undefined ? { rows: Math.max(8, e.props.scroll.bodyRows - 12) } : {}),
              offsetY: await read($, scrollY),
              fit: await read($, fit),
              pixels: e.surface === 'terminal' && (mode === 'on' || (mode === 'auto' && canPixels)),
              canPixels,
            })),
            ...list,
            toggleGuide,
          ],
    })
  })
}
