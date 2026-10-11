import type { Tone } from './diagram'
import type { Segment } from './draw'
import { PALETTE } from './kit/palette'

/** The size of one cell of the drawing, in pixels. */
export const CELL_WIDTH = 6
export const CELL_HEIGHT = 12

// What an `Image` takes: at most 2048 pixels each way and 2 MiB of pixels
const MAX_SIDE = 2048
const MAX_BYTES = 2 * 1024 * 1024
// An `Image` is at most 255 columns by 255 rows of cells
const MAX_CELLS = 255

export type Raster = { rgba: string; width: number; height: number; columns: number; rows: number }

type Color = readonly [number, number, number]

const color = (hex: string): Color => [
  Number.parseInt(hex.slice(1, 3), 16),
  Number.parseInt(hex.slice(3, 5), 16),
  Number.parseInt(hex.slice(5, 7), 16),
]

// The picture has no theme to follow, so it has the kit's palette: the gray reads on a light and on a dark terminal
const INK = color(PALETTE.gray)
const HOT = color(PALETTE.orange)
const TONE_INK: Record<Tone, Color> = {
  neutral: INK,
  accent: HOT,
  info: color(PALETTE.blue),
  success: color(PALETTE.green),
  warning: HOT,
  danger: color(PALETTE.red),
}

// The classic 5x7 font, ASCII 32 to 126: five columns a character, the top row the lowest bit of each
const FONT: readonly (readonly number[])[] = [
  [0x00, 0x00, 0x00, 0x00, 0x00], [0x00, 0x00, 0x5f, 0x00, 0x00], [0x00, 0x07, 0x00, 0x07, 0x00],
  [0x14, 0x7f, 0x14, 0x7f, 0x14], [0x24, 0x2a, 0x7f, 0x2a, 0x12], [0x23, 0x13, 0x08, 0x64, 0x62],
  [0x36, 0x49, 0x56, 0x20, 0x50], [0x00, 0x08, 0x07, 0x03, 0x00], [0x00, 0x1c, 0x22, 0x41, 0x00],
  [0x00, 0x41, 0x22, 0x1c, 0x00], [0x2a, 0x1c, 0x7f, 0x1c, 0x2a], [0x08, 0x08, 0x3e, 0x08, 0x08],
  [0x00, 0x80, 0x70, 0x30, 0x00], [0x08, 0x08, 0x08, 0x08, 0x08], [0x00, 0x00, 0x60, 0x60, 0x00],
  [0x20, 0x10, 0x08, 0x04, 0x02], [0x3e, 0x51, 0x49, 0x45, 0x3e], [0x00, 0x42, 0x7f, 0x40, 0x00],
  [0x72, 0x49, 0x49, 0x49, 0x46], [0x21, 0x41, 0x49, 0x4d, 0x33], [0x18, 0x14, 0x12, 0x7f, 0x10],
  [0x27, 0x45, 0x45, 0x45, 0x39], [0x3c, 0x4a, 0x49, 0x49, 0x31], [0x41, 0x21, 0x11, 0x09, 0x07],
  [0x36, 0x49, 0x49, 0x49, 0x36], [0x46, 0x49, 0x49, 0x29, 0x1e], [0x00, 0x00, 0x14, 0x00, 0x00],
  [0x00, 0x40, 0x34, 0x00, 0x00], [0x00, 0x08, 0x14, 0x22, 0x41], [0x14, 0x14, 0x14, 0x14, 0x14],
  [0x00, 0x41, 0x22, 0x14, 0x08], [0x02, 0x01, 0x59, 0x09, 0x06], [0x3e, 0x41, 0x5d, 0x59, 0x4e],
  [0x7c, 0x12, 0x11, 0x12, 0x7c], [0x7f, 0x49, 0x49, 0x49, 0x36], [0x3e, 0x41, 0x41, 0x41, 0x22],
  [0x7f, 0x41, 0x41, 0x41, 0x3e], [0x7f, 0x49, 0x49, 0x49, 0x41], [0x7f, 0x09, 0x09, 0x09, 0x01],
  [0x3e, 0x41, 0x41, 0x51, 0x73], [0x7f, 0x08, 0x08, 0x08, 0x7f], [0x00, 0x41, 0x7f, 0x41, 0x00],
  [0x20, 0x40, 0x41, 0x3f, 0x01], [0x7f, 0x08, 0x14, 0x22, 0x41], [0x7f, 0x40, 0x40, 0x40, 0x40],
  [0x7f, 0x02, 0x1c, 0x02, 0x7f], [0x7f, 0x04, 0x08, 0x10, 0x7f], [0x3e, 0x41, 0x41, 0x41, 0x3e],
  [0x7f, 0x09, 0x09, 0x09, 0x06], [0x3e, 0x41, 0x51, 0x21, 0x5e], [0x7f, 0x09, 0x19, 0x29, 0x46],
  [0x26, 0x49, 0x49, 0x49, 0x32], [0x03, 0x01, 0x7f, 0x01, 0x03], [0x3f, 0x40, 0x40, 0x40, 0x3f],
  [0x1f, 0x20, 0x40, 0x20, 0x1f], [0x3f, 0x40, 0x38, 0x40, 0x3f], [0x63, 0x14, 0x08, 0x14, 0x63],
  [0x03, 0x04, 0x78, 0x04, 0x03], [0x61, 0x59, 0x49, 0x4d, 0x43], [0x00, 0x7f, 0x41, 0x41, 0x41],
  [0x02, 0x04, 0x08, 0x10, 0x20], [0x00, 0x41, 0x41, 0x41, 0x7f], [0x04, 0x02, 0x01, 0x02, 0x04],
  [0x40, 0x40, 0x40, 0x40, 0x40], [0x00, 0x03, 0x07, 0x08, 0x00], [0x20, 0x54, 0x54, 0x78, 0x40],
  [0x7f, 0x28, 0x44, 0x44, 0x38], [0x38, 0x44, 0x44, 0x44, 0x28], [0x38, 0x44, 0x44, 0x28, 0x7f],
  [0x38, 0x54, 0x54, 0x54, 0x18], [0x00, 0x08, 0x7e, 0x09, 0x02], [0x18, 0xa4, 0xa4, 0x9c, 0x78],
  [0x7f, 0x08, 0x04, 0x04, 0x78], [0x00, 0x44, 0x7d, 0x40, 0x00], [0x20, 0x40, 0x40, 0x3d, 0x00],
  [0x7f, 0x10, 0x28, 0x44, 0x00], [0x00, 0x41, 0x7f, 0x40, 0x00], [0x7c, 0x04, 0x78, 0x04, 0x78],
  [0x7c, 0x08, 0x04, 0x04, 0x78], [0x38, 0x44, 0x44, 0x44, 0x38], [0xfc, 0x18, 0x24, 0x24, 0x18],
  [0x18, 0x24, 0x24, 0x18, 0xfc], [0x7c, 0x08, 0x04, 0x04, 0x08], [0x48, 0x54, 0x54, 0x54, 0x24],
  [0x04, 0x04, 0x3f, 0x44, 0x24], [0x3c, 0x40, 0x40, 0x20, 0x7c], [0x1c, 0x20, 0x40, 0x20, 0x1c],
  [0x3c, 0x40, 0x30, 0x40, 0x3c], [0x44, 0x28, 0x10, 0x28, 0x44], [0x4c, 0x90, 0x90, 0x90, 0x7c],
  [0x44, 0x64, 0x54, 0x4c, 0x44], [0x00, 0x08, 0x36, 0x41, 0x00], [0x00, 0x00, 0x77, 0x00, 0x00],
  [0x00, 0x41, 0x36, 0x08, 0x00], [0x02, 0x01, 0x02, 0x04, 0x02],
]

// A line character as the sides it reaches (up, right, down, left) and how it is drawn there
type Stroke = { up: boolean; right: boolean; down: boolean; left: boolean; weight: 1 | 2 | 'double'; dotted?: boolean }

const stroke = (sides: string, weight: Stroke['weight'] = 1, dotted = false): Stroke => ({
  up: sides.includes('u'),
  right: sides.includes('r'),
  down: sides.includes('d'),
  left: sides.includes('l'),
  weight,
  dotted,
})

const LINES: Record<string, Stroke> = {
  '─': stroke('rl'), '│': stroke('ud'), '┌': stroke('rd'), '┐': stroke('dl'), '└': stroke('ur'), '┘': stroke('ul'),
  '├': stroke('urd'), '┤': stroke('udl'), '┬': stroke('rdl'), '┴': stroke('url'), '┼': stroke('urdl'),
  '╭': stroke('rd'), '╮': stroke('dl'), '╰': stroke('ur'), '╯': stroke('ul'),
  '━': stroke('rl', 2), '┃': stroke('ud', 2), '┏': stroke('rd', 2), '┓': stroke('dl', 2), '┗': stroke('ur', 2),
  '┛': stroke('ul', 2), '┣': stroke('urd', 2), '┫': stroke('udl', 2), '┳': stroke('rdl', 2), '┻': stroke('url', 2),
  '╋': stroke('urdl', 2),
  '┄': stroke('rl', 1, true), '┆': stroke('ud', 1, true),
  '═': stroke('rl', 'double'), '║': stroke('ud', 'double'), '╔': stroke('rd', 'double'), '╗': stroke('dl', 'double'),
  '╚': stroke('ur', 'double'), '╝': stroke('ul', 'double'),
}

/** The pixels of a drawing as RGBA bytes, row by row, and its size; `undefined` when it is more than an `Image` takes. */
export const paint = (
  rows: readonly (readonly Segment[])[],
): { pixels: Uint8Array; width: number; height: number; columns: number; rows: number } | undefined => {
  const lines = rows.map(row =>
    row.flatMap(segment => Array.from(segment.text).map(char => ({ char, hot: segment.hot, tone: segment.tone }))),
  )
  const columns = Math.max(1, ...lines.map(line => line.length))
  const width = columns * CELL_WIDTH
  const height = Math.max(1, lines.length) * CELL_HEIGHT

  if (columns > MAX_CELLS || lines.length > MAX_CELLS) return undefined
  if (width > MAX_SIDE || height > MAX_SIDE || width * height * 4 > MAX_BYTES) return undefined

  const pixels = new Uint8Array(width * height * 4)

  const dot = (x: number, y: number, ink: Color): void => {
    if (x < 0 || y < 0 || x >= width || y >= height) return

    const at = (y * width + x) * 4
    pixels[at] = ink[0]
    pixels[at + 1] = ink[1]
    pixels[at + 2] = ink[2]
    pixels[at + 3] = 255
  }

  lines.forEach((line, row) => {
    line.forEach((cell, column) => {
      if (cell.char === ' ') return

      const ink = cell.hot ? HOT : cell.tone !== undefined ? TONE_INK[cell.tone] : INK
      const x0 = column * CELL_WIDTH
      const y0 = row * CELL_HEIGHT
      const px = (x: number, y: number): void => dot(x0 + x, y0 + y, ink)
      const cx = 3
      const cy = 6

      const code = cell.char.codePointAt(0) ?? 0
      const line = LINES[cell.char]

      if (line !== undefined) {
        const reach = (vertical: boolean, positive: boolean): void => {
          const length = vertical ? (positive ? CELL_HEIGHT - cy : cy + 1) : positive ? CELL_WIDTH - cx : cx + 1

          for (let step = 0; step < length; step += 1) {
            if (line.dotted && step % 3 === 1) continue

            const along = positive ? (vertical ? cy : cx) + step : (vertical ? cy : cx) - step
            const widths = line.weight === 'double' ? [-1, 1] : line.weight === 2 ? [-1, 0] : [0]

            for (const offset of widths) {
              if (vertical) px(cx + offset, along)
              else px(along, cy + offset)
            }
          }
        }

        if (line.up) reach(true, false)
        if (line.down) reach(true, true)
        if (line.left) reach(false, false)
        if (line.right) reach(false, true)
      } else if (cell.char === '▼' || cell.char === '▲') {
        // A triangle five rows tall, widest at its base
        for (let step = 0; step < 5; step += 1) {
          const y = cell.char === '▼' ? 3 + step : 7 - step
          const half = 2 - Math.floor((step * 2) / 4)
          for (let x = cx - half; x <= cx + half; x += 1) px(x, y)
        }
      } else if (cell.char === '▶' || cell.char === '◀' || cell.char === '▸') {
        // A triangle four columns wide, tallest at its base
        for (let step = 0; step < 4; step += 1) {
          const x = cell.char === '◀' ? 1 + step : 4 - step
          for (let y = cy - (3 - step); y <= cy + (3 - step); y += 1) px(x, y)
        }
      } else if (cell.char === '╱' || cell.char === '╲') {
        for (let step = 0; step < CELL_HEIGHT; step += 1) {
          const x = Math.round((step * (CELL_WIDTH - 1)) / (CELL_HEIGHT - 1))
          px(cell.char === '╲' ? x : CELL_WIDTH - 1 - x, step)
        }
      } else if (code >= 32 && code <= 126) {
        const glyph = FONT[code - 32] as readonly number[]

        glyph.forEach((bits, glyphColumn) => {
          for (let bit = 0; bit < 8; bit += 1) if ((bits >> bit) & 1) px(glyphColumn, 2 + bit)
        })
      } else {
        // A character the font does not have is a small box, so the gap shows
        for (let x = 1; x <= 4; x += 1) {
          px(x, 3)
          px(x, 8)
        }
        for (let y = 3; y <= 8; y += 1) {
          px(1, y)
          px(4, y)
        }
      }
    })
  })

  return { pixels, width, height, columns, rows: Math.max(1, lines.length) }
}

/** A drawing as an `Image` takes it: base64 RGBA pixels and their size, in pixels and in cells. */
export const rasterize = (rows: readonly (readonly Segment[])[]): Raster | undefined => {
  const painted = paint(rows)

  return painted === undefined
    ? undefined
    : { rgba: toBase64(painted.pixels), width: painted.width, height: painted.height, columns: painted.columns, rows: painted.rows }
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** The bytes as base64, which `Image` takes pixels as. */
export const toBase64 = (bytes: Uint8Array): string => {
  let out = ''

  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] as number
    const b = bytes[index + 1] ?? 0
    const c = bytes[index + 2] ?? 0
    const triple = (a << 16) | (b << 8) | c

    out += BASE64[(triple >> 18) & 63] as string
    out += BASE64[(triple >> 12) & 63] as string
    out += index + 1 < bytes.length ? (BASE64[(triple >> 6) & 63] as string) : '='
    out += index + 2 < bytes.length ? (BASE64[triple & 63] as string) : '='
  }

  return out
}
