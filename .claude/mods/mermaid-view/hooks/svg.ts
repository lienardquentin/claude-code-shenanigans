import type { Segment } from './draw'

const CELL_WIDTH = 9
const CELL_HEIGHT = 20
const FONT_SIZE = 15

const escapeText = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * The drawing as one SVG document: its rows of characters set in a monospace font, so that the boxes and lines keep
 * the shape they have in the terminal. The selection is bold. No colors of its own: it is drawn in the current color.
 */
export const diagramSvg = (rows: readonly Segment[][]): { source: string; width: number; height: number } => {
  const columns = Math.max(1, ...rows.map(row => row.reduce((sum, segment) => sum + Array.from(segment.text).length, 0)))
  const width = columns * CELL_WIDTH + CELL_WIDTH
  const height = rows.length * CELL_HEIGHT + CELL_HEIGHT / 2

  const lines = rows.map((row, index) => {
    const spans = row
      .map(segment => `<tspan${segment.hot ? ' font-weight="700"' : ''}>${escapeText(segment.text)}</tspan>`)
      .join('')

    return `<text x="${CELL_WIDTH / 2}" y="${(index + 1) * CELL_HEIGHT - 5}" xml:space="preserve">${spans}</text>`
  })

  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" ` +
    `font-family="ui-monospace, Menlo, Consolas, monospace" font-size="${FONT_SIZE}" fill="currentColor">` +
    `${lines.join('')}</svg>`

  return { source, width, height }
}
