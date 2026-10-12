// @ui-kit
// ui-kit part: styled-lines. Copy this file to a mod's `hooks/kit/styled-lines.ts`, then
// `import { styledLines } from './kit/styled-lines'`.
// Self-contained: its only import is a type.
import type { RenderElement } from 'claude-code'

/**
 * A run of a line as another program styled it: its text, and the paint and weight that program gave it. The colors
 * are data the mod was handed (a theme key, a color name or a raw color), never ones it wrote.
 */
export type StyledSpan = {
  text: string
  color?: string
  background?: string
  bold?: boolean
  italic?: boolean
  dim?: boolean
}

// A paint is a word (a theme key, a color name) or a raw color of six digits; anything else is dropped
const PAINT = /^(?:[A-Za-z]{1,32}|#[0-9A-Fa-f]{6})$/

const paint = (value: unknown): string | undefined => (typeof value === 'string' && PAINT.test(value) ? value : undefined)

// The text of a run with what a `Text` cannot hold taken out: every control character, an escape included
const clean = (text: string): string =>
  // eslint-disable-next-line no-control-regex
  text.replace(/[\u0000-\u001F\u007F]/g, '')

/** The widest line, in characters: what a mod compares to the room it has before saying a drawing is cut. */
export const styledWidth = (lines: readonly (readonly StyledSpan[])[]): number =>
  Math.max(0, ...lines.map(line => line.reduce((sum, span) => sum + [...clean(String(span.text ?? ''))].length, 0)))

/**
 * Lines drawn run by run in the colors they came with, such as the output of a program that paints its own text
 * (a themed diagram, a colored report). Spaces are kept as they are, so a filled background stays a block. A line
 * is never wrapped: with `width`, what is past that many characters is cut; without, the surface cuts it.
 */
export const styledLines = ({
  lines,
  width,
}: {
  lines: readonly (readonly StyledSpan[])[]
  /** The most characters of a line that are drawn */
  width?: number
}): RenderElement =>
  ({
    type: 'Box',
    props: { flexDirection: 'column' },
    children: lines.map(line => {
      let room = width ?? Number.POSITIVE_INFINITY
      const runs: unknown[] = []

      for (const span of line) {
        const characters = [...clean(String(span.text ?? ''))]
        if (characters.length === 0 || room <= 0) continue
        const text = characters.slice(0, room).join('')
        room -= characters.length

        const color = paint(span.color)
        const background = paint(span.background)
        const props = {
          ...(color !== undefined ? { color } : {}),
          ...(background !== undefined ? { backgroundColor: background } : {}),
          ...(span.bold === true ? { bold: true } : {}),
          ...(span.italic === true ? { italic: true } : {}),
          ...(span.dim === true ? { dimColor: true } : {}),
        }
        runs.push(Object.keys(props).length === 0 ? text : { type: 'Text', props, children: [text] })
      }

      // An empty line still takes its row
      return { type: 'Text', props: { wrap: 'truncate-end' }, children: runs.length === 0 ? [' '] : runs }
    }),
  }) as unknown as RenderElement
