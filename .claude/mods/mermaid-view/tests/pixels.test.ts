import { describe, expect, test } from 'claude-code/testing'

import { CELL_HEIGHT, CELL_WIDTH, paint, rasterize, toBase64 } from '../hooks/pixels'

const row = (text: string, hot = false) => [{ text, hot }]

// The pixel at (x, y) of a painted drawing: its four bytes
const at = (painted: NonNullable<ReturnType<typeof paint>>, x: number, y: number): number[] => {
  const start = (y * painted.width + x) * 4

  return [...painted.pixels.slice(start, start + 4)]
}

describe('painting a drawing', () => {
  test('is one cell of CELL_WIDTH by CELL_HEIGHT pixels for each character, and as wide as the widest row', () => {
    const painted = paint([row('abc'), row('de')])

    expect(painted?.columns).toBe(3)
    expect(painted?.rows).toBe(2)
    expect(painted?.width).toBe(3 * CELL_WIDTH)
    expect(painted?.height).toBe(2 * CELL_HEIGHT)
    expect(painted?.pixels.length).toBe(painted!.width * painted!.height * 4)
  })

  test('leaves a space transparent', () => {
    const painted = paint([row(' ')])

    expect([...painted!.pixels].every(byte => byte === 0)).toBe(true)
  })

  test('draws a vertical line down the middle of its cell, and a horizontal one across it', () => {
    const vertical = paint([row('│')])!
    const horizontal = paint([row('─')])!

    // the vertical bar reaches the top and the bottom of the cell at its middle column, and not the corner
    expect(at(vertical, 3, 0)[3]).toBe(255)
    expect(at(vertical, 3, CELL_HEIGHT - 1)[3]).toBe(255)
    expect(at(vertical, 0, 0)[3]).toBe(0)
    // the horizontal bar crosses the whole width at the middle row
    expect(at(horizontal, 0, 6)[3]).toBe(255)
    expect(at(horizontal, CELL_WIDTH - 1, 6)[3]).toBe(255)
    expect(at(horizontal, 0, 0)[3]).toBe(0)
  })

  test('joins the sides a corner reaches, and no others', () => {
    const corner = paint([row('┌')])!

    // right and down from the middle: pixels there; none above it or to its left
    expect(at(corner, 5, 6)[3]).toBe(255)
    expect(at(corner, 3, 11)[3]).toBe(255)
    expect(at(corner, 3, 0)[3]).toBe(0)
    expect(at(corner, 0, 6)[3]).toBe(0)
  })

  test('draws a thick line two pixels wide and a dotted one with gaps', () => {
    const thick = paint([row('┃')])!
    const solid = paint([row('│')])!
    const dotted = paint([row('┆')])!
    const lit = (painted: NonNullable<ReturnType<typeof paint>>): number =>
      [...Array(painted.height).keys()].filter(y => at(painted, 2, y)[3] === 255 || at(painted, 3, y)[3] === 255).length

    expect(at(thick, 2, 3)[3]).toBe(255)
    expect(at(thick, 3, 3)[3]).toBe(255)
    expect(at(solid, 2, 3)[3]).toBe(0)
    expect(lit(dotted)).toBeLessThan(lit(solid))
  })

  test('draws a letter from the font, and a character the font does not have as a small box', () => {
    const letter = paint([row('I')])!
    const unknown = paint([row('é')])!

    // the capital I has a bar across its top and its foot
    expect(at(letter, 2, 2)[3]).toBe(255)
    expect([...letter.pixels].some(byte => byte !== 0)).toBe(true)
    expect(at(unknown, 1, 3)[3]).toBe(255)
    expect(at(unknown, 4, 8)[3]).toBe(255)
  })

  test('draws the selection in the accent color of the palette, and the rest in its gray', () => {
    const plain = paint([row('A')])!
    const hot = paint([row('A', true)])!
    const first = (painted: NonNullable<ReturnType<typeof paint>>): number[] => {
      const lit = [...Array(painted.width * painted.height).keys()].find(index => painted.pixels[index * 4 + 3] === 255)

      return [...painted.pixels.slice((lit as number) * 4, (lit as number) * 4 + 3)]
    }

    expect(first(hot)).toEqual([0xd9, 0x77, 0x57])
    expect(first(plain)).toEqual([0xb0, 0xae, 0xa5])
  })

  test('is nothing when it is more than an Image can take', () => {
    expect(paint([row('x'.repeat(256))])).toBeUndefined()
    expect(paint(Array.from({ length: 256 }, () => row('x')))).toBeUndefined()
    // wide and tall enough to pass 2 MiB of pixels, though under the sides' limits
    expect(paint(Array.from({ length: 170 }, () => row('x'.repeat(200))))).toBeUndefined()
  })
})

describe('base64', () => {
  test('encodes as the standard does, with its padding', () => {
    const bytes = (text: string) => new Uint8Array([...text].map(char => char.charCodeAt(0)))

    expect(toBase64(bytes('Man'))).toBe('TWFu')
    expect(toBase64(bytes('Ma'))).toBe('TWE=')
    expect(toBase64(bytes('M'))).toBe('TQ==')
    expect(toBase64(new Uint8Array([]))).toBe('')
  })

  test('a drawing gives its pixels as base64 of the right length', () => {
    const raster = rasterize([row('ab')])!

    expect(raster.width).toBe(2 * CELL_WIDTH)
    expect(raster.rgba.length).toBe(Math.ceil((raster.width * raster.height * 4) / 3) * 4)
  })
})
