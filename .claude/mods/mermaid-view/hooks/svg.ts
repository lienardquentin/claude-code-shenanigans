import type { Geometry } from './draw'

// One cell of the layout is this many pixels: a cell is about twice as tall as it is wide, as a terminal's is
const CELL_WIDTH = 9
const CELL_HEIGHT = 20
const MARGIN = 14

const escapeText = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const round = (value: number): number => Math.round(value * 10) / 10

// The picture is an image, so it cannot see the theme of the page: it carries both. Colors are CSS names, and the
// dark scheme is the browser's own media query, which an SVG image follows.
const STYLE = `
.ink{fill:none;stroke:black;stroke-width:1.5;stroke-linejoin:round;stroke-linecap:round}
.thick{stroke-width:3}
.dotted{stroke-dasharray:2 5}
.head{fill:black;stroke:none}
.txt{fill:black;font-family:system-ui,'Segoe UI',Roboto,sans-serif;font-size:13px}
.group{fill:none;stroke:gray;stroke-width:1.2;stroke-dasharray:5 4}
.gtxt{fill:gray;font-family:system-ui,'Segoe UI',Roboto,sans-serif;font-size:11px}
.success{stroke:green}.warning{stroke:darkorange}.danger{stroke:crimson}.info{stroke:dodgerblue}.neutral{stroke:gray}.accent{stroke:darkorange}
.hot{stroke:darkorange;stroke-width:3}
.hothead{fill:darkorange}
.hottxt{font-weight:700}
@media (prefers-color-scheme: dark){
.ink{stroke:white}.head{fill:white}.txt{fill:white}.gtxt{fill:silver}.group{stroke:silver}
.success{stroke:lightgreen}.warning{stroke:orange}.danger{stroke:tomato}.info{stroke:lightskyblue}.neutral{stroke:silver}.accent{stroke:orange}
.hot{stroke:orange}.hothead{fill:orange}
}`

type Point = { x: number; y: number }

// The point `by` along the direction from one point to another, as a unit vector
const unit = (from: Point, to: Point): Point => {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const length = Math.hypot(dx, dy) || 1

  return { x: dx / length, y: dy / length }
}

// Half a cell along the way a line runs: across a cell's width when it runs sideways, its height when it runs up or down
const halfCell = (direction: Point): number => (Math.abs(direction.x) > Math.abs(direction.y) ? CELL_WIDTH : CELL_HEIGHT) / 2

/**
 * The layout as an SVG document: boxes in their shapes, edges as lines with arrowheads, subgraphs as dashed frames,
 * the selection thick and in the accent color, the author's tones in theme colors. It is the same layout as the cell
 * drawing, so what is where is the same in both.
 */
export const vectorSvg = (geometry: Geometry): { source: string; width: number; height: number } => {
  // A cell's middle, and a cell's corner, in pixels
  const px = (point: Point): Point => ({ x: point.x * CELL_WIDTH + MARGIN, y: point.y * CELL_HEIGHT + MARGIN })
  const parts: string[] = []
  let right = 0
  let bottom = 0
  const reach = (x: number, y: number): void => {
    right = Math.max(right, x)
    bottom = Math.max(bottom, y)
  }

  for (const group of geometry.groups) {
    const x = group.x * CELL_WIDTH + MARGIN
    const y = group.y * CELL_HEIGHT + MARGIN
    const w = group.w * CELL_WIDTH
    const h = group.h * CELL_HEIGHT

    parts.push(`<rect class="group" x="${round(x)}" y="${round(y)}" width="${round(w)}" height="${round(h)}" rx="8"/>`)
    if (group.title !== '') {
      parts.push(`<text class="gtxt" x="${round(x + 12)}" y="${round(y + 14)}">${escapeText(group.title)}</text>`)
    }
    reach(x + w, y + h)
  }

  for (const edge of geometry.edges) {
    const points = edge.points.map(px)
    const first = points[0]
    const last = points[points.length - 1]
    const before = points[points.length - 2]
    if (first === undefined || last === undefined || before === undefined) continue

    // The line starts at the border of its source and ends at the border of its target: half a cell beyond the
    // middle of the cell next to each box
    const start = unit(points[1] ?? first, first)
    const end = unit(before, last)
    const from: Point = { x: first.x + start.x * halfCell(start), y: first.y + start.y * halfCell(start) }
    const tip: Point = { x: last.x + end.x * halfCell(end), y: last.y + end.y * halfCell(end) }
    const hasHead = edge.kind !== 'open'
    // The line stops short of the tip so the arrowhead is not drawn over by it
    const stop: Point = hasHead ? { x: tip.x - end.x * 7, y: tip.y - end.y * 7 } : tip
    const through = [from, ...points.slice(0, -1), stop]
    const classes = ['ink', edge.kind === 'thick' ? 'thick' : '', edge.kind === 'dotted' ? 'dotted' : '', edge.hot ? 'hot' : '']
      .filter(Boolean)
      .join(' ')

    parts.push(`<polyline class="${classes}" points="${through.map(point => `${round(point.x)},${round(point.y)}`).join(' ')}"/>`)

    if (hasHead) {
      // A triangle on the tip, pointing the way the line ends
      const side = { x: -end.y, y: end.x }
      const back = { x: tip.x - end.x * 9, y: tip.y - end.y * 9 }
      const left = { x: back.x + side.x * 4.5, y: back.y + side.y * 4.5 }
      const rightPoint = { x: back.x - side.x * 4.5, y: back.y - side.y * 4.5 }

      parts.push(
        `<polygon class="head${edge.hot ? ' hothead' : ''}" points="${[tip, left, rightPoint]
          .map(point => `${round(point.x)},${round(point.y)}`)
          .join(' ')}"/>`,
      )
    }

    if (edge.label !== undefined) {
      // Beside the arrowhead: to the right of a line going up or down, above a line going sideways
      const vertical = Math.abs(end.y) > Math.abs(end.x)
      const x = vertical ? tip.x + 8 : tip.x - end.x * 14
      const y = vertical ? tip.y - end.y * 14 : tip.y - 7

      parts.push(
        `<text class="txt" font-size="11" x="${round(x)}" y="${round(y)}"${vertical ? '' : ' text-anchor="middle"'}>${escapeText(edge.label)}</text>`,
      )
      reach(x + edge.label.length * 7, y)
    }

    for (const point of [...points, tip]) reach(point.x, point.y)
  }

  for (const node of geometry.nodes) {
    const x = node.x * CELL_WIDTH + MARGIN
    const y = node.y * CELL_HEIGHT + MARGIN
    const w = node.w * CELL_WIDTH
    const h = node.h * CELL_HEIGHT
    const cx = x + w / 2
    const cy = y + h / 2
    // A box is inset a little, so that a line that ends at its border is seen to
    const bx = x + 3
    const by = y + 6
    const bw = w - 6
    const bh = h - 12
    const tone = node.tone !== undefined ? ` ${node.tone}` : ''
    const classes = `ink${tone}${node.hot ? ' hot' : ''}`
    const label = escapeText(node.label)

    switch (node.shape) {
      case 'rounded':
        parts.push(`<rect class="${classes}" x="${round(bx)}" y="${round(by)}" width="${round(bw)}" height="${round(bh)}" rx="10"/>`)
        break
      case 'stadium':
        parts.push(
          `<rect class="${classes}" x="${round(bx)}" y="${round(by)}" width="${round(bw)}" height="${round(bh)}" rx="${round(bh / 2)}"/>`,
        )
        break
      case 'diamond':
        parts.push(
          `<polygon class="${classes}" points="${round(cx)},${round(by - 4)} ${round(bx + bw + 10)},${round(cy)} ${round(cx)},${round(by + bh + 4)} ${round(bx - 10)},${round(cy)}"/>`,
        )
        break
      case 'circle':
        parts.push(`<ellipse class="${classes}" cx="${round(cx)}" cy="${round(cy)}" rx="${round(bw / 2 + 6)}" ry="${round(bh / 2 + 2)}"/>`)
        break
      default:
        parts.push(`<rect class="${classes}" x="${round(bx)}" y="${round(by)}" width="${round(bw)}" height="${round(bh)}" rx="3"/>`)
    }

    parts.push(
      `<text class="txt${node.hot ? ' hottxt' : ''}" x="${round(cx)}" y="${round(cy)}" text-anchor="middle" dominant-baseline="central">${label}</text>`,
    )
    reach(x + w + 10, y + h)
  }

  const width = Math.ceil(right + MARGIN)
  const height = Math.ceil(bottom + MARGIN)

  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<style>${STYLE}</style>${parts.join('')}</svg>`

  return { source, width, height }
}
