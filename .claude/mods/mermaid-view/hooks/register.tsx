import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import type { HistoryEntry } from '../types'
import { MAX_NODES, looksLikeDiagram, mermaidBlocks, parseDiagram } from './diagram'
import type { Diagram, ParseResult } from './diagram'
import { drawDiagram } from './draw'
import { actionLabel } from './kit/action-label'
import { badge } from './kit/badge'
import { card } from './kit/card'
import { code } from './kit/code'
import { picture } from './kit/picture'
import { tonedText } from './kit/toned-text'
import { diagramSvg } from './svg'
import { clipDrawing, drawingWidth, spanOfNode, windowFor } from './window'

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
const content = (
  $: Engine,
  e: Drawn,
  text: string,
  chosen: string,
  view: { width: number; offset: number; fit: boolean },
): RenderElement[] => {
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

  const { Box, Button } = $.ui.resolve(e)
  const known = diagram.nodes.some(node => node.id === chosen) ? chosen : ''
  const drawing = drawDiagram(diagram, known)

  // What is shown about the selected node, under the drawing or the picture
  const details: RenderElement[] =
    known === ''
      ? []
      : [
          badge({ label: `Selected: ${diagram.nodes.find(node => node.id === known)?.label ?? known}`, tone: 'accent' }),
          code({ source: connections(diagram, known).join('\n'), plain: true }),
          <Button key="clear-selection" onPress={() => update($, selected, () => '')}>
            {actionLabel({ text: 'Clear' })}
          </Button>,
        ]

  // The fallback view: a surface that is not the terminal (the desktop, VS Code, mobile) is given a still picture of
  // the drawing and one button per node, because a node's box cannot be known to keep its shape as native buttons
  if (e.surface !== 'terminal') {
    const { source: svg, width, height } = diagramSvg(drawing)
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
      <Box key="node-buttons" flexDirection="row" flexWrap="wrap" gap={1}>
        {diagram.nodes.map(node => (
          <Button key={`node-${node.id}`} onPress={() => toggle($, node.id)}>
            {tonedText({
              text: node.label,
              ...(node.id === known
                ? { tone: 'accent' as const, bold: true }
                : node.tone !== undefined
                  ? { tone: node.tone }
                  : {}),
            })}
          </Button>
        ))}
      </Box>,
      ...details,
    ]
  }

  // A drawing wider than the pane is shown through a window that moves by the buttons above it; the fit-width view
  // closes the nodes up first, and the window is only used for what still does not fit
  const normal = drawing
  const laid = view.fit ? drawDiagram(diagram, known, { compact: true }) : normal
  const total = drawingWidth(laid)
  const maxOffset = Math.max(0, total - view.width)
  const offset = Math.min(view.offset, maxOffset)
  const shown = total > view.width ? clipDrawing(laid, offset, view.width) : laid
  const step = Math.max(1, Math.floor(view.width / 2))

  // Pressing a node selects it, and moves the window so that the whole box shows, as far as it can
  const reveal = async (id: string): Promise<void> => {
    await toggle($, id)

    const span = spanOfNode(laid, id)
    if (span !== undefined) await update($, scrollX, current => windowFor(Math.min(current, maxOffset), view.width, span))
    // Down the pane: the engine scrolls its body to the box. A surface that cannot is no reason to fail the press.
    try {
      await $.ui.scroll({ to: { key: `node-${id}` }, in: PANE })
    } catch {
      // nothing to scroll
    }
  }

  const controls: RenderElement[] =
    total > view.width || drawingWidth(normal) > view.width || view.fit
      ? [
          <Box key="view-controls" flexDirection="row" gap={1}>
            {offset > 0 ? (
              <Button key="scroll-left" onPress={() => update($, scrollX, () => Math.max(0, offset - step))}>
                {actionLabel({ text: '◀ Left' })}
              </Button>
            ) : null}
            {offset < maxOffset ? (
              <Button key="scroll-right" onPress={() => update($, scrollX, () => Math.min(maxOffset, offset + step))}>
                {actionLabel({ text: 'Right ▶' })}
              </Button>
            ) : null}
            {drawingWidth(normal) > view.width || view.fit ? (
              <Button key="fit-width" onPress={() => update($, fit, current => !current)}>
                {actionLabel({ text: view.fit ? 'Fit width: on' : 'Fit width: off' })}
              </Button>
            ) : null}
          </Box>,
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

  return [...controls, ...rows, ...details]
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

    return card({
      width: e.props.bodyColumns ?? 80,
      title: 'Mermaid diagram',
      children: [
        ...content($, e, shown, await read($, selected), {
          // Inside the card's frame and padding
          width: Math.max(10, (e.props.bodyColumns ?? 80) - 4),
          offset: await read($, scrollX),
          fit: await read($, fit),
        }),
        ...list,
      ],
    })
  })
}
