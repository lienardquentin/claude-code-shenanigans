import type { Diagram } from './diagram'

const NODE_HEIGHT = 3
const SPACING = 3
const LANE_START = 2

// A line cell remembers the sides a line leaves it by; the character is chosen from them when the grid is printed,
// so two lines that meet or cross in one cell become the right junction
const UP = 1
const RIGHT = 2
const DOWN = 4
const LEFT = 8

const LINE: Record<number, string> = {
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

// `solid` is a character a node's box or an arrowhead drew: a line never overwrites it. `node` and `row` say which
// node's box (and which of its three rows) a cell belongs to; `hot` marks what belongs to the selection.
type Cell = { sides: number; solid?: string; node?: string; row?: number; hot?: boolean }

/**
 * A run of cells on one line of the drawing that is drawn alike: a piece of a node's box (the `node` it belongs to
 * and which `row` of its box it is) or a stretch of lines and spaces, `hot` when it belongs to the selection.
 */
export type Segment = { text: string; hot: boolean; node?: string; row?: number }

type PlacedNode = { id: string; label: string; layer: number; x: number; top: number; width: number }

// One horizontal run of an edge, in the gap between two layers (gap -1 is above the first layer). The key names the
// node whose edges it carries and in which direction: runs that share a key are one bus, drawn on one row.
type Run = { gap: number; key: string }

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
 * Draws a diagram top-down as lines of box-drawing characters: one box per node, the nodes of a layer side by side,
 * an edge as a line from the bottom of its source to an arrowhead above its target. An edge that does not join
 * neighbouring layers (it skips one, goes back up, or loops) runs down a lane to the right of every node, so it never
 * crosses one. The drawing comes as rows of segments; the node `selected`, and the edges that touch it, are `hot`.
 */
export const drawDiagram = (diagram: Diagram, selected = ''): Segment[][] => {
  if (diagram.nodes.length === 0) return []

  const layers = layerOf(diagram)
  const layerOfNode = (id: string): number => layers.get(id) ?? 0
  const layerCount = Math.max(...layers.values()) + 1
  const nodesIn: PlacedNode[][] = Array.from({ length: layerCount }, () => [])

  for (const node of diagram.nodes) {
    // The width counts characters the way a terminal cell does for ordinary text; wide characters are not handled
    const width = Array.from(node.label).length + 4
    nodesIn[layerOfNode(node.id)]?.push({ id: node.id, label: node.label, layer: layerOfNode(node.id), width, x: 0, top: 0 })
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

  // The horizontal runs: an edge between neighbouring layers has one; any other edge leaves its source by one and
  // arrives at its target by another, in the gaps below the source and above the target
  const runs: Run[] = []
  const routes = diagram.edges.map(edge => {
    runs.push({ gap: layerOfNode(edge.from), key: `from:${edge.from}` })

    // Between neighbouring layers the one run goes from the source's column to the target's
    if (layerOfNode(edge.to) - layerOfNode(edge.from) === 1) {
      return { out: runs.length - 1, into: runs.length - 1, aside: false }
    }

    runs.push({ gap: layerOfNode(edge.to) - 1, key: `to:${edge.to}` })

    return { out: runs.length - 2, into: runs.length - 1, aside: true }
  })

  const { rowOf, rowsIn } = assignRows(runs)
  const rowsOf = (gap: number): number => rowsIn.get(gap) ?? 0

  // Above the first layer there are the rows of the runs that arrive from there, and the arrowhead row; below the
  // last one the exit row and the rows of the runs that leave. Between layers: exit row, one row for each bus, and
  // the arrowhead row.
  const topMargin = rowsOf(-1) > 0 ? rowsOf(-1) + 1 : 0
  const bottomMargin = rowsOf(layerCount - 1) > 0 ? rowsOf(layerCount - 1) + 1 : 0
  const layerTop: number[] = []
  let cursor = topMargin

  for (let layer = 0; layer < layerCount; layer += 1) {
    layerTop.push(cursor)
    cursor += NODE_HEIGHT + (layer < layerCount - 1 ? Math.max(1, rowsOf(layer)) + 2 : 0)
  }

  const rowWidth = (layer: PlacedNode[]): number =>
    layer.reduce((sum, node) => sum + node.width, 0) + SPACING * Math.max(0, layer.length - 1)
  const widest = Math.max(...nodesIn.map(rowWidth))
  const placed = new Map<string, PlacedNode>()

  nodesIn.forEach((layer, index) => {
    let x = Math.floor((widest - rowWidth(layer)) / 2)

    for (const node of layer) {
      node.x = x
      node.top = layerTop[index] as number
      x += node.width + SPACING
      placed.set(node.id, node)
    }
  })

  const laneCount = routes.filter(route => route.aside).length
  const width = widest + LANE_START + laneCount * 2 + 1
  const height = cursor + bottomMargin

  const grid: Cell[][] = Array.from({ length: height }, () => Array.from({ length: width }, (): Cell => ({ sides: 0 })))
  const at = (x: number, y: number): Cell | undefined => grid[y]?.[x]

  const setSolid = (x: number, y: number, char: string, hot: boolean, node?: { id: string; row: number }): void => {
    const target = at(x, y)
    if (target === undefined) return

    target.solid = char
    target.hot = hot
    if (node !== undefined) {
      target.node = node.id
      target.row = node.row
    }
  }

  const addSides = (x: number, y: number, sides: number, hot: boolean): void => {
    const target = at(x, y)
    if (target === undefined || target.solid !== undefined) return

    target.sides |= sides
    target.hot = target.hot === true || hot
  }

  // A straight run of line between two cells along a row or a column, both ends included
  const drawRun = (x1: number, y1: number, x2: number, y2: number, hot: boolean): void => {
    if (y1 === y2) {
      for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x += 1) {
        if (x > Math.min(x1, x2)) addSides(x, y1, LEFT, hot)
        if (x < Math.max(x1, x2)) addSides(x, y1, RIGHT, hot)
      }
    } else {
      for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y += 1) {
        if (y > Math.min(y1, y2)) addSides(x1, y, UP, hot)
        if (y < Math.max(y1, y2)) addSides(x1, y, DOWN, hot)
      }
    }
  }

  for (const node of placed.values()) {
    const inner = '─'.repeat(node.width - 2)

    ;[`┌${inner}┐`, `│ ${node.label} │`, `└${inner}┘`].forEach((text, row) => {
      Array.from(text).forEach((char, column) =>
        setSolid(node.x + column, node.top + row, char, node.id === selected, { id: node.id, row }),
      )
    })
  }

  // Row `row` of a gap: the gap starts under the layer above it (row -1 is just above the grid for gap -1), its first
  // row is the exit row, so the buses follow it
  const busY = (gap: number, row: number): number => (gap < 0 ? -1 : (layerTop[gap] as number) + NODE_HEIGHT) + 1 + row

  let lane = 0

  diagram.edges.forEach((edge, index) => {
    const from = placed.get(edge.from)
    const to = placed.get(edge.to)
    const route = routes[index]
    if (from === undefined || to === undefined || route === undefined) return

    const startX = from.x + Math.floor(from.width / 2)
    const startY = from.top + NODE_HEIGHT
    const endX = to.x + Math.floor(to.width / 2)
    const endY = to.top - 1
    const outRun = runs[route.out] as Run
    const outY = busY(outRun.gap, rowOf[route.out] as number)
    // An edge that touches the selected node is part of the selection
    const hot = selected !== '' && (edge.from === selected || edge.to === selected)

    drawRun(startX, startY, startX, outY, hot)

    if (!route.aside) {
      drawRun(startX, outY, endX, outY, hot)
      drawRun(endX, outY, endX, endY, hot)
    } else {
      const intoRun = runs[route.into] as Run
      const intoY = busY(intoRun.gap, rowOf[route.into] as number)
      const laneX = widest + LANE_START + lane * 2
      lane += 1

      drawRun(startX, outY, laneX, outY, hot)
      drawRun(laneX, outY, laneX, intoY, hot)
      drawRun(laneX, intoY, endX, intoY, hot)
      drawRun(endX, intoY, endX, endY, hot)
    }

    setSolid(endX, endY, '▼', hot)
  })

  // Each grid row becomes segments: cells drawn alike and, for a node's box, belonging to the same node, are one
  return grid.map(row => {
    const segments: Segment[] = []

    for (const cell of row) {
      const text = cell.solid ?? LINE[cell.sides] ?? ' '
      const hot = cell.hot === true
      const last = segments[segments.length - 1]

      if (last !== undefined && last.node === cell.node && last.hot === hot) last.text += text
      else segments.push({ text, hot, ...(cell.node !== undefined ? { node: cell.node, row: cell.row } : {}) })
    }

    // Nothing is drawn after the last line or box of a row
    const end = segments[segments.length - 1]
    if (end !== undefined && end.node === undefined) end.text = end.text.replace(/\s+$/, '')
    if (end !== undefined && end.text === '') segments.pop()

    return segments
  })
}
