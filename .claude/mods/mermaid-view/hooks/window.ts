import type { Segment } from './draw'

/** How many cells a row of segments takes. */
export const rowWidth = (row: readonly Segment[]): number =>
  row.reduce((sum, segment) => sum + Array.from(segment.text).length, 0)

/** The widest row of a drawing, in cells. */
export const drawingWidth = (rows: readonly (readonly Segment[])[]): number => Math.max(0, ...rows.map(rowWidth))

/**
 * The part of a drawing that lies in the window of cells `[from, from + width)`: each row cut to it. A piece of a
 * node's box keeps its node, so a box cut by the edge of the window can still be pressed.
 */
export const clipDrawing = (rows: readonly (readonly Segment[])[], from: number, width: number): Segment[][] =>
  rows.map(row => {
    const kept: Segment[] = []
    let at = 0

    for (const segment of row) {
      const chars = Array.from(segment.text)
      const start = Math.max(from - at, 0)
      const end = Math.min(from + width - at, chars.length)

      if (end > start) kept.push({ ...segment, text: chars.slice(start, end).join('') })
      at += chars.length
    }

    return kept
  })

/** The cells a node's box takes in a drawing: where it starts, and where it ends (one past), or `undefined`. */
export const spanOfNode = (
  rows: readonly (readonly Segment[])[],
  id: string,
): { start: number; end: number } | undefined => {
  let start = Number.POSITIVE_INFINITY
  let end = -1

  for (const row of rows) {
    let at = 0

    for (const segment of row) {
      const length = Array.from(segment.text).length

      if (segment.node === id) {
        start = Math.min(start, at)
        end = Math.max(end, at + length)
      }

      at += length
    }
  }

  return end < 0 ? undefined : { start, end }
}

/**
 * Where the window is to start so that `span` shows whole, moving no further than it has to: the window stays where
 * it is when the span is already in it, and a span wider than the window shows its start.
 */
export const windowFor = (current: number, width: number, span: { start: number; end: number }): number => {
  if (span.end - span.start >= width || span.start < current) return span.start
  if (span.end > current + width) return span.end - width

  return current
}
