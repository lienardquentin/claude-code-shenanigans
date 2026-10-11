// @ui-kit
// ui-kit part: pixel-image. Copy this file to a mod's `hooks/kit/pixel-image.ts`, then
// `import { pixelImage } from './kit/pixel-image'`.
// Self-contained: its only import is a type.
import type { RenderElement } from 'claude-code'

/**
 * A picture of raw pixels over a box of terminal cells, for the terminal surface (which draws `Image`: pixels in a
 * terminal that has a graphics protocol, `alt` in dim text elsewhere). `rgba` is `width * height` pixels of four
 * bytes each, as base64; at most 2048 pixels each way and 2 MiB, and 255 columns by 255 rows of cells. Returns
 * `undefined` past those, so the caller can draw something else.
 *
 * A leaf: it takes no press. Put the buttons beside it.
 */
export const pixelImage = ({
  rgba,
  width,
  height,
  columns,
  rows,
  alt,
}: {
  rgba: string
  width: number
  height: number
  columns: number
  rows: number
  alt: string
}): RenderElement | undefined =>
  width < 1 ||
  height < 1 ||
  width > 2048 ||
  height > 2048 ||
  columns < 1 ||
  rows < 1 ||
  columns > 255 ||
  rows > 255 ||
  width * height * 4 > 2 * 1024 * 1024
    ? undefined
    : ({
        type: 'Image',
        props: { source: { rgba, width, height }, columns, rows, alt },
      } as unknown as RenderElement)
