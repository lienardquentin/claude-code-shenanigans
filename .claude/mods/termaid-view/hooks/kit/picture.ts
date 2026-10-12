// @ui-kit
// ui-kit part: picture. Copy this file to a mod's `hooks/kit/picture.ts`, then `import { picture } from './kit/picture'`.
// Self-contained: its only import is a type.
import type { RenderElement } from 'claude-code'

/** The longest SVG document an `Svg` element takes. */
export const MAX_SOURCE = 131072

/**
 * A still vector picture, for the surfaces that draw `Svg` (the desktop, VS Code, mobile; the terminal does not).
 * `alt` is what a reader that cannot see it hears, and is required. Returns `undefined` when the markup is too long
 * for the element, so the caller can say so instead of the pane failing to draw.
 */
export const picture = ({
  source,
  alt,
  width,
  height,
}: {
  source: string
  alt: string
  width?: number
  height?: number
}): RenderElement | undefined =>
  source.length > MAX_SOURCE
    ? undefined
    : ({
        type: 'Svg',
        props: { source, alt, ...(width !== undefined ? { width } : {}), ...(height !== undefined ? { height } : {}) },
      } as unknown as RenderElement)
