import type { Diagram, Direction, EdgeKind, Shape, Tone } from './diagram'

const NODE_HEIGHT = 3
const LANE_START = 2

// A line cell remembers the sides a line leaves it by, in physical terms; the character is chosen from them when the
// grid is printed, so two lines that meet or cross in one cell become the right junction
const UP = 1
const RIGHT = 2
const DOWN = 4
const LEFT = 8

// The layout is made along two axes: `main` is the way the diagram flows (layer after layer) and `cross` is across
// it. A line's sides are named in those terms and become physical sides by the direction of the diagram.
const FORWARD = 1
const BACK = 2
const CROSS_UP = 4
const CROSS_DOWN = 8

const SIDES: Record<Direction, Record<number, number>> = {
  TD: { [FORWARD]: DOWN, [BACK]: UP, [CROSS_UP]: LEFT, [CROSS_DOWN]: RIGHT },
  BT: { [FORWARD]: UP, [BACK]: DOWN, [CROSS_UP]: LEFT, [CROSS_DOWN]: RIGHT },
  LR: { [FORWARD]: RIGHT, [BACK]: LEFT, [CROSS_UP]: UP, [CROSS_DOWN]: DOWN },
  RL: { [FORWARD]: LEFT, [BACK]: RIGHT, [CROSS_UP]: UP, [CROSS_DOWN]: DOWN },
}

const ARROWHEAD: Record<Direction, string> = { TD: '▼', BT: '▲', LR: '▶', RL: '◀' }

const SOLID: Record<number, string> = {
  [UP]: '│',
  [DOWN]: '│',
  [UP | DOWN]: '│',
  [RIGHT]: '─',
  [LEFT]: '─',
  [RIGHT | LEFT]: '─',
  [UP | RIGHT]: '└',
  [RIGHT | DOWN]: '┌',
  [DOWN | LEFT]: '┐',
  [UP | LEFT]: '┘',
  [UP | RIGHT | DOWN]: '├',
  [RIGHT | DOWN | LEFT]: '┬',
  [UP | DOWN | LEFT]: '┤',
  [UP | RIGHT | LEFT]: '┴',
  [UP | RIGHT | DOWN | LEFT]: '┼',
}

const THICK: Record<number, string> = {
  [UP]: '┃',
  [DOWN]: '┃',
  [UP | DOWN]: '┃',
  [RIGHT]: '━',
  [LEFT]: '━',
  [RIGHT | LEFT]: '━',
  [UP | RIGHT]: '┗',
  [RIGHT | DOWN]: '┏',
  [DOWN | LEFT]: '┓',
  [UP | LEFT]: '┛',
  [UP | RIGHT | DOWN]: '┣',
  [RIGHT | DOWN | LEFT]: '┳',
  [UP | DOWN | LEFT]: '┫',
  [UP | RIGHT | LEFT]: '┻',
  [UP | RIGHT | DOWN | LEFT]: '╋',
}

// A dotted line is dotted only where it runs straight; corners and junctions are the solid ones
const DOTTED: Record<number, string> = {
  ...SOLID,
  [UP]: '┆',
  [DOWN]: '┆',
  [UP | DOWN]: '┆',
  [RIGHT]: '┄',
  [LEFT]: '┄',
  [RIGHT | LEFT]: '┄',
}

// Which look wins where two edges share a cell
const STYLE_RANK = { dotted: 0, solid: 1, thick: 2 } as const
type Style = keyof typeof STYLE_RANK

const styleOf = (kind: EdgeKind): Style => (kind === 'thick' ? 'thick' : kind === 'dotted' ? 'dotted' : 'solid')

// `solid` is a character a node's box, an arrowhead or a label drew: a line never overwrites it. `node` and `row`
// say which node's box (and which of its three rows) a cell belongs to; `hot` marks what belongs to the selection.
type Cell = { sides: number; style?: Style; solid?: string; node?: string; row?: number; hot?: boolean; tone?: Tone }

/**
 * A run of cells on one line of the drawing that is drawn alike: a piece of a node's box (the `node` it belongs to
 * and which `row` of its box it is) or a stretch of lines and spaces, `hot` when it belongs to the selection and
 * in `tone` when the author marked its node out.
 */
export type Segment = { text: string; hot: boolean; node?: string; row?: number; tone?: Tone }

type PlacedNode = {
  id: string
  rows: string[]
  width: number
  group?: string
  tone?: Tone
  layer: number
  // Where the box starts along the main axis and across it, and how far it reaches along each
  main: number
  cross: number
  mainSize: number
  crossSize: number
}

// One run of an edge along the cross axis, in the gap between two layers (gap -1 is before the first layer). The key
// names the node whose edges it carries and in which direction: runs that share a key are one bus, on one row.
type Run = { gap: number; key: string }

/** The three rows of a node's box for its shape, and its width. */
const boxOf = (shape: Shape, label: string): { rows: string[]; width: number } => {
  const length = Array.from(label).length
  const bar = (count: number): string => '─'.repeat(count)

  switch (shape) {
    case 'rounded':
      return { rows: [`╭${bar(length + 2)}╮`, `│ ${label} │`, `╰${bar(length + 2)}╯`], width: length + 4 }
    case 'stadium':
      return { rows: [`╭${bar(length + 2)}╮`, `( ${label} )`, `╰${bar(length + 2)}╯`], width: length + 4 }
    case 'diamond':
      return { rows: [`╱${bar(length + 2)}╲`, `< ${label} >`, `╲${bar(length + 2)}╱`], width: length + 4 }
    case 'circle':
      return { rows: [` ╭${bar(length + 2)}╮ `, `(( ${label} ))`, ` ╰${bar(length + 2)}╯ `], width: length + 6 }
    default:
      return { rows: [`┌${bar(length + 2)}┐`, `│ ${label} │`, `└${bar(length + 2)}┘`], width: length + 4 }
  }
}

/** The layer of each node: its longest path from a source, the edges that close a cycle left out of the count. */
const layerOf = (diagram: Diagram): Map<string, number> => {
  const state = new Map<string, 0 | 1 | 2>()
  const finished: string[] = []
  const closing = new Set<number>()

  const visit = (id: string): void => {
    state.set(id, 1)

    diagram.edges.forEach((edge, index) => {
      if (edge.from !== id) return

      if (state.get(edge.to) === 1) closing.add(index)
      else if ((state.get(edge.to) ?? 0) === 0) visit(edge.to)
    })

    state.set(id, 2)
    finished.push(id)
  }

  for (const node of diagram.nodes) if ((state.get(node.id) ?? 0) === 0) visit(node.id)

  const layer = new Map(diagram.nodes.map(node => [node.id, 0] as const))

  for (const id of finished.reverse()) {
    diagram.edges.forEach((edge, index) => {
      if (edge.from === id && !closing.has(index)) {
        layer.set(edge.to, Math.max(layer.get(edge.to) ?? 0, (layer.get(id) ?? 0) + 1))
      }
    })
  }

  return layer
}

/**
 * Gives each run a row within its gap: the runs of one key (the edges that leave one node, or arrive at one) share a
 * row, as a tree does, and every other run has a row of its own, so two edges with no node in common are never drawn
 * as if they joined. Returns each run's row, and how many rows each gap needs.
 */
const assignRows = (runs: readonly Run[]): { rowOf: number[]; rowsIn: Map<number, number> } => {
  const keysIn = new Map<number, string[]>()

  const rowOf = runs.map(run => {
    const keys = keysIn.get(run.gap) ?? []
    if (!keys.includes(run.key)) keys.push(run.key)
    keysIn.set(run.gap, keys)

    return keys.indexOf(run.key)
  })

  return { rowOf, rowsIn: new Map([...keysIn].map(([gap, keys]) => [gap, keys.length] as const)) }
}

/**
 * Draws a diagram as lines of box-drawing characters: one box per node, the nodes of a layer side by side, an edge as
 * a line from the end of its source to an arrowhead before its target. An edge that does not join neighbouring
 * layers (it skips one, goes back up, or loops) runs along a lane beside every node, so it never crosses one. The
 * drawing comes as rows of segments; the node `selected`, and the edges that touch it, are `hot`. `compact` keeps
 * the nodes of a layer close, for a drawing that is to be as narrow as it can be.
 */
export const drawDiagram = (diagram: Diagram, selected = '', options: { compact?: boolean } = {}): Segment[][] => {
  if (diagram.nodes.length === 0) return []

  const { direction } = diagram
  const vertical = direction === 'TD' || direction === 'BT'
  const layers = layerOf(diagram)
  const layerOfNode = (id: string): number => layers.get(id) ?? 0
  const layerCount = Math.max(...layers.values()) + 1
  const nodesIn: PlacedNode[][] = Array.from({ length: layerCount }, () => [])

  for (const node of diagram.nodes) {
    const { rows, width } = boxOf(node.shape, node.label)

    nodesIn[layerOfNode(node.id)]?.push({
      id: node.id,
      rows,
      width,
      ...(node.group !== undefined ? { group: node.group } : {}),
      ...(node.tone !== undefined ? { tone: node.tone } : {}),
      layer: layerOfNode(node.id),
      main: 0,
      cross: 0,
      mainSize: vertical ? NODE_HEIGHT : width,
      crossSize: vertical ? width : NODE_HEIGHT,
    })
  }

  // Each layer below the first is ordered by where the sources of its nodes stand in the layer above, so that edges
  // between neighbouring layers cross as little as one downward pass can make them
  for (let layer = 1; layer < layerCount; layer += 1) {
    const position = new Map((nodesIn[layer - 1] ?? []).map((node, index) => [node.id, index] as const))
    const centre = (node: PlacedNode, index: number): number => {
      const sources = diagram.edges.flatMap(edge => {
        const found = edge.to === node.id ? position.get(edge.from) : undefined

        return found === undefined ? [] : [found]
      })

      return sources.length === 0 ? index : sources.reduce((sum, source) => sum + source, 0) / sources.length
    }

    nodesIn[layer] = (nodesIn[layer] ?? [])
      .map((node, index) => ({ node, index, centre: centre(node, index) }))
      .sort((a, b) => a.centre - b.centre || a.index - b.index)
      .map(entry => entry.node)
  }

  // The nodes of a subgraph stand together in their layer, at the place of the first of them, so that its box
  // can be drawn around them without taking in others
  for (let layer = 0; layer < layerCount; layer += 1) {
    const order: string[] = []
    const buckets = new Map<string, PlacedNode[]>()

    for (const node of nodesIn[layer] ?? []) {
      // A node in no subgraph is a bucket of its own; the `#` keeps its id apart from a subgraph's
      const key = node.group ?? `#${node.id}`
      const bucket = buckets.get(key)

      if (bucket === undefined) {
        buckets.set(key, [node])
        order.push(key)
      } else {
        bucket.push(node)
      }
    }

    nodesIn[layer] = order.flatMap(key => buckets.get(key) ?? [])
  }

  // Each subgraph's box is one cell outside its nodes, and one outside the boxes of the subgraphs inside it: the
  // drawing keeps that much room all around
  const children = new Map<string, string[]>()
  for (const group of diagram.groups) {
    if (group.parent !== undefined) children.set(group.parent, [...(children.get(group.parent) ?? []), group.id])
  }
  const depthOf = (id: string): number => 1 + Math.max(0, ...(children.get(id) ?? []).map(depthOf))
  const ringPad = Math.max(0, ...diagram.groups.filter(group => group.parent === undefined).map(group => depthOf(group.id)))

  // The runs along the cross axis: an edge between neighbouring layers has one; any other edge leaves its source by
  // one and arrives at its target by another, in the gaps after the source and before the target
  const runs: Run[] = []
  const routes = diagram.edges.map(edge => {
    runs.push({ gap: layerOfNode(edge.from), key: `from:${edge.from}` })

    // Between neighbouring layers the one run goes from the source's line to the target's
    if (layerOfNode(edge.to) - layerOfNode(edge.from) === 1) {
      return { out: runs.length - 1, into: runs.length - 1, aside: false }
    }

    runs.push({ gap: layerOfNode(edge.to) - 1, key: `to:${edge.to}` })

    return { out: runs.length - 2, into: runs.length - 1, aside: true }
  })

  const { rowOf, rowsIn } = assignRows(runs)
  const rowsOf = (gap: number): number => rowsIn.get(gap) ?? 0

  // The longest label of an edge that arrives through a gap: it needs a row (or, flowing sideways, a width) there
  const labelIn = new Map<number, number>()

  diagram.edges.forEach((edge, index) => {
    const route = routes[index]
    if (edge.label === undefined || edge.label === '' || route === undefined) return

    const gap = (runs[route.into] as Run).gap
    labelIn.set(gap, Math.max(labelIn.get(gap) ?? 0, Array.from(edge.label).length))
  })

  // How far a gap reaches along the main axis: the exit row, one row for each bus, the row of the arrowhead, and a
  // label (one row when flowing down or up, its width when flowing sideways). Before the first layer there is no exit
  // row; after the last there is no arrowhead row.
  const gapSize = (gap: number): number => {
    const label = labelIn.get(gap) ?? 0
    const base = Math.max(1, rowsOf(gap)) + 2

    return vertical ? base + (label > 0 ? 1 : 0) : Math.max(base, label + 2)
  }

  const topMargin = rowsOf(-1) > 0 || (labelIn.get(-1) ?? 0) > 0 ? gapSize(-1) - 1 : 0
  const bottomMargin = rowsOf(layerCount - 1) > 0 ? rowsOf(layerCount - 1) + 1 : 0

  const layerStart: number[] = []
  const layerSize = nodesIn.map(layer => Math.max(...layer.map(node => node.mainSize)))
  let cursor = ringPad + topMargin

  for (let layer = 0; layer < layerCount; layer += 1) {
    layerStart.push(cursor)
    cursor += (layerSize[layer] as number) + (layer < layerCount - 1 ? gapSize(layer) : 0)
  }

  const total = cursor + bottomMargin + ringPad

  // Across the diagram: the nodes of a layer side by side, each layer centred on the widest. With subgraphs the
  // nodes are kept further apart, so a box can be drawn between two that are in different ones.
  // Compact (the fit-width view) closes the nodes up as far as a box can still be drawn between them
  const crossGap = options.compact === true ? (diagram.groups.length > 0 ? 2 : 1) : vertical || diagram.groups.length > 0 ? 3 : 1
  const crossLength = (layer: PlacedNode[]): number =>
    layer.reduce((sum, node) => sum + node.crossSize, 0) + crossGap * Math.max(0, layer.length - 1)
  const widest = Math.max(...nodesIn.map(crossLength))
  const placed = new Map<string, PlacedNode>()

  nodesIn.forEach((layer, index) => {
    let cross = ringPad + Math.floor((widest - crossLength(layer)) / 2)

    for (const node of layer) {
      node.main = layerStart[index] as number
      node.cross = cross
      cross += node.crossSize + crossGap
      placed.set(node.id, node)
    }
  })

  const laneCount = routes.filter(route => route.aside).length
  const crossTotal = ringPad * 2 + widest + LANE_START + laneCount * 2 + 1
  // A subgraph's box grows to the right to hold its title, so the drawing keeps room for the longest one
  const titleRoom = Math.max(0, ...diagram.groups.map(group => Array.from(group.title).length + 6))
  const width = (vertical ? crossTotal : total) + titleRoom
  const height = vertical ? total : crossTotal

  const grid: Cell[][] = Array.from({ length: height }, () => Array.from({ length: width }, (): Cell => ({ sides: 0 })))
  const at = (x: number, y: number): Cell | undefined => grid[y]?.[x]

  // A point along the main and cross axes, as a cell of the grid
  const place = (main: number, cross: number): { x: number; y: number } => {
    switch (direction) {
      case 'BT':
        return { x: cross, y: total - 1 - main }
      case 'LR':
        return { x: main, y: cross }
      case 'RL':
        return { x: total - 1 - main, y: cross }
      default:
        return { x: cross, y: main }
    }
  }

  const setSolid = (
    x: number,
    y: number,
    char: string,
    hot: boolean,
    node?: { id: string; row: number; tone?: Tone },
  ): void => {
    const target = at(x, y)
    if (target === undefined) return

    target.solid = char
    target.hot = hot
    if (node !== undefined) {
      target.node = node.id
      target.row = node.row
      if (node.tone !== undefined) target.tone = node.tone
    }
  }

  const addSides = (main: number, cross: number, sides: number, hot: boolean, style: Style): void => {
    const { x, y } = place(main, cross)
    const target = at(x, y)
    if (target === undefined || target.solid !== undefined) return

    const physical = [FORWARD, BACK, CROSS_UP, CROSS_DOWN].reduce(
      (sum, side) => ((sides & side) !== 0 ? sum | (SIDES[direction][side] as number) : sum),
      0,
    )

    target.sides |= physical
    target.hot = target.hot === true || hot
    if (target.style === undefined || STYLE_RANK[style] > STYLE_RANK[target.style]) target.style = style
  }

  // A straight run of line between two points, along the main axis or across it, both ends included
  const drawRun = (m1: number, c1: number, m2: number, c2: number, hot: boolean, style: Style): void => {
    if (c1 === c2) {
      for (let main = Math.min(m1, m2); main <= Math.max(m1, m2); main += 1) {
        if (main > Math.min(m1, m2)) addSides(main, c1, BACK, hot, style)
        if (main < Math.max(m1, m2)) addSides(main, c1, FORWARD, hot, style)
      }
    } else {
      for (let cross = Math.min(c1, c2); cross <= Math.max(c1, c2); cross += 1) {
        if (cross > Math.min(c1, c2)) addSides(m1, cross, CROSS_UP, hot, style)
        if (cross < Math.max(c1, c2)) addSides(m1, cross, CROSS_DOWN, hot, style)
      }
    }
  }

  // The boxes are text, drawn the right way up whatever the direction: the main axis only places them
  const rects = new Map<string, { x: number; y: number; w: number; h: number }>()

  for (const node of placed.values()) {
    const main = direction === 'BT' || direction === 'RL' ? total - node.main - node.mainSize : node.main
    const x = vertical ? node.cross : main
    const y = vertical ? main : node.cross

    rects.set(node.id, { x, y, w: node.width, h: NODE_HEIGHT })

    node.rows.forEach((text, row) => {
      Array.from(text).forEach((char, column) =>
        setSolid(x + column, y + row, char, node.id === selected, {
          id: node.id,
          row,
          ...(node.tone !== undefined ? { tone: node.tone } : {}),
        }),
      )
    })
  }

  // Where the buses of a gap lie along the main axis: after the gap's exit row, one after another
  const busMain = (gap: number, row: number): number =>
    gap < 0 ? ringPad + row : (layerStart[gap] as number) + (layerSize[gap] as number) + 1 + row

  let lane = 0

  diagram.edges.forEach((edge, index) => {
    const from = placed.get(edge.from)
    const to = placed.get(edge.to)
    const route = routes[index]
    if (from === undefined || to === undefined || route === undefined) return

    const startMain = from.main + from.mainSize
    const startCross = from.cross + Math.floor(from.crossSize / 2)
    const endMain = to.main - 1
    const endCross = to.cross + Math.floor(to.crossSize / 2)
    const outRun = runs[route.out] as Run
    const outMain = busMain(outRun.gap, rowOf[route.out] as number)
    // An edge that touches the selected node is part of the selection
    const hot = selected !== '' && (edge.from === selected || edge.to === selected)
    const style = styleOf(edge.kind)

    drawRun(startMain, startCross, outMain, startCross, hot, style)

    if (!route.aside) {
      drawRun(outMain, startCross, outMain, endCross, hot, style)
      drawRun(outMain, endCross, endMain, endCross, hot, style)
    } else {
      const intoRun = runs[route.into] as Run
      const intoMain = busMain(intoRun.gap, rowOf[route.into] as number)
      const laneCross = ringPad + widest + LANE_START + lane * 2
      lane += 1

      drawRun(outMain, startCross, outMain, laneCross, hot, style)
      drawRun(outMain, laneCross, intoMain, laneCross, hot, style)
      drawRun(intoMain, laneCross, intoMain, endCross, hot, style)
      drawRun(intoMain, endCross, endMain, endCross, hot, style)
    }

    const head = place(endMain, endCross)
    if (edge.kind !== 'open') setSolid(head.x, head.y, ARROWHEAD[direction], hot)

    // The label sits beside the arrowhead (one step back along the flow when flowing down or up, above the line
    // when flowing sideways), over empty cells only, and stops where a line is in the way
    if (edge.label !== undefined && edge.label !== '') {
      const chars = Array.from(edge.label)
      const flow = direction === 'TD' || direction === 'LR' ? 1 : -1
      const startX = vertical ? head.x + 1 : flow === 1 ? head.x - chars.length : head.x + 1
      const labelY = vertical ? head.y - flow : head.y - 1

      for (const [offset, char] of chars.entries()) {
        const target = at(startX + offset, labelY)
        if (target === undefined || target.solid !== undefined || target.sides !== 0) break

        target.solid = char
        target.hot = hot
      }
    }
  })

  // A subgraph's box is drawn around its nodes, and around the boxes of the subgraphs inside it, over empty cells
  // only: a line that crosses it stays, and so does an arrowhead
  type Rect = { x: number; y: number; w: number; h: number }
  const boxOfGroup = (id: string): Rect | undefined => {
    const inside = [
      ...diagram.nodes.filter(node => node.group === id).map(node => rects.get(node.id)),
      ...(children.get(id) ?? []).map(boxOfGroup),
    ].filter((rect): rect is Rect => rect !== undefined)

    if (inside.length === 0) return undefined

    const left = Math.min(...inside.map(rect => rect.x))
    const top = Math.min(...inside.map(rect => rect.y))
    const right = Math.max(...inside.map(rect => rect.x + rect.w))
    const bottom = Math.max(...inside.map(rect => rect.y + rect.h))
    // Wide enough for the title between a corner and a bar on the top edge, growing to the right when it is not
    const title = Array.from(diagram.groups.find(group => group.id === id)?.title ?? '').length + 2

    return { x: left - 1, y: top - 1, w: Math.max(right - left + 2, title + 4), h: bottom - top + 2 }
  }

  const putBorder = (x: number, y: number, char: string): void => {
    const target = at(x, y)
    if (target !== undefined && target.solid === undefined && target.sides === 0) target.solid = char
  }

  // Inner boxes first, so that a title is not overwritten by the box around it
  const drawGroup = (id: string): void => {
    for (const child of children.get(id) ?? []) drawGroup(child)

    const rect = boxOfGroup(id)
    if (rect === undefined) return

    const right = rect.x + rect.w - 1
    const bottom = rect.y + rect.h - 1

    for (let x = rect.x + 1; x < right; x += 1) {
      putBorder(x, rect.y, '═')
      putBorder(x, bottom, '═')
    }

    for (let y = rect.y + 1; y < bottom; y += 1) {
      putBorder(rect.x, y, '║')
      putBorder(right, y, '║')
    }

    putBorder(rect.x, rect.y, '╔')
    putBorder(right, rect.y, '╗')
    putBorder(rect.x, bottom, '╚')
    putBorder(right, bottom, '╝')

    // The title sits on the top edge, with a space each side, as far as the box is wide
    const title = Array.from(` ${diagram.groups.find(group => group.id === id)?.title ?? ''} `)
    title.slice(0, Math.max(0, rect.w - 4)).forEach((char, offset) => {
      const target = at(rect.x + 2 + offset, rect.y)
      if (target !== undefined && target.sides === 0) target.solid = char
    })
  }

  for (const group of diagram.groups) if (group.parent === undefined) drawGroup(group.id)

  // Each grid row becomes segments: cells drawn alike and, for a node's box, belonging to the same node, are one
  return grid.map(row => {
    const segments: Segment[] = []

    for (const cell of row) {
      const set = cell.style === 'thick' ? THICK : cell.style === 'dotted' ? DOTTED : SOLID
      const text = cell.solid ?? set[cell.sides] ?? ' '
      const hot = cell.hot === true
      const last = segments[segments.length - 1]

      if (last !== undefined && last.node === cell.node && last.hot === hot && last.tone === cell.tone) last.text += text
      else {
        segments.push({
          text,
          hot,
          ...(cell.node !== undefined ? { node: cell.node, row: cell.row } : {}),
          ...(cell.tone !== undefined ? { tone: cell.tone } : {}),
        })
      }
    }

    // Nothing is drawn after the last line or box of a row
    const end = segments[segments.length - 1]
    if (end !== undefined && end.node === undefined) end.text = end.text.replace(/\s+$/, '')
    if (end !== undefined && end.text === '') segments.pop()

    return segments
  })
}
