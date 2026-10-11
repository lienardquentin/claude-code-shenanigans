import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import { MAX_NODES, parseDiagram } from './diagram'
import type { Diagram, ParseResult } from './diagram'
import { drawDiagram } from './draw'
import { actionLabel } from './kit/action-label'
import { badge } from './kit/badge'
import { card } from './kit/card'
import { code } from './kit/code'
import { picture } from './kit/picture'
import { tonedText } from './kit/toned-text'
import { diagramSvg } from './svg'

const PANE = 'mermaid-view'

type Engine = EngineInterface
type Drawn = Parameters<Engine['ui']['resolve']>[0]

// The Mermaid source the pane shows: the viewer's own, kept in this session
const source = atom({ plugin: 'mermaid-view', key: 'source' } as const, '')
// The node the viewer selected: also the pane's own
const selected = atom({ plugin: 'mermaid-view', key: 'selected' } as const, '')

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
const content = ($: Engine, e: Drawn, text: string, chosen: string): RenderElement[] => {
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

  // Each row of the drawing is a row of pieces; a piece of a node's box is a plain Button, so a press anywhere on the
  // box selects the node and the box keeps its shape
  const rows = drawing.map((segments, index) => (
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
          <Button key={`node-${id}${ROW_KEY[segment.row ?? 1]}`} plain onPress={() => toggle($, id)}>
            {label}
          </Button>
        )
      })}
    </Box>
  ))

  return [...rows, ...details]
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

  on('command.run', { command: 'mermaid-view' }, async ($, e) => {
    if (e.args.trim() !== '') {
      await update($, source, () => e.args.trim())
      await update($, selected, () => '')
    }
    await $.ui.open({ id: PANE, title: 'Mermaid diagram' })

    return { text: 'Mermaid diagram pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) =>
    card({
      width: e.props.bodyColumns ?? 80,
      title: 'Mermaid diagram',
      children: content($, e, await read($, source), await read($, selected)),
    }),
  )
}
