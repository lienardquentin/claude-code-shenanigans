import { atom, read, update } from 'claude-code'
import type { Register, RenderElement } from 'claude-code'

import { parseDiagram } from './diagram'
import { drawDiagram } from './draw'
import { badge } from './kit/badge'
import { card } from './kit/card'
import { code } from './kit/code'

const PANE = 'mermaid-view'

// The Mermaid source the pane shows: the viewer's own, kept in this session
const source = atom({ plugin: 'mermaid-view', key: 'source' } as const, '')

// What the card holds: the drawing, or a note saying why there is none. The source is shown beside a note about it,
// so the reader can see what could not be read.
const content = (text: string): RenderElement[] => {
  if (text === '') return [badge({ label: 'No diagram yet: run /mermaid-view with a flowchart', tone: 'neutral' })]

  const parsed = parseDiagram(text)

  if (!parsed.ok) {
    return [
      badge({ label: `Could not read this diagram at: ${parsed.line}`, tone: 'warning' }),
      code({ source: text, plain: true }),
    ]
  }

  if (parsed.diagram.nodes.length === 0) return [badge({ label: 'This diagram has no nodes', tone: 'warning' })]

  return [code({ source: drawDiagram(parsed.diagram).join('\n'), plain: true })]
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
    if (e.args.trim() !== '') await update($, source, () => e.args.trim())
    await $.ui.open({ id: PANE, title: 'Mermaid diagram' })

    return { text: 'Mermaid diagram pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) =>
    card({
      width: e.props.bodyColumns ?? 80,
      title: 'Mermaid diagram',
      children: content(await read($, source)),
    }),
  )
}
