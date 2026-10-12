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
  /** What a press on the run hands the mod (a path, an id): data too, read by the mod and never drawn */
  link?: string
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

type ButtonConstructor = (props: {
  key: string
  label: string
  plain: true
  onPress: () => unknown
  children: readonly RenderElement[]
}) => RenderElement

/**
 * Lines drawn run by run in the colors they came with, such as the output of a program that paints its own text
 * (a themed diagram, a colored report). Spaces are kept as they are, so a filled background stays a block. A line
 * is never wrapped: with `width`, what is past that many characters is cut; without, the surface cuts it.
 *
 * A run that carries a `link` is pressable when the mod passes its `Button` (from `$.ui.resolve(e)`) and
 * `onLinkPress`: the runs side by side with one link are one button, drawn as the runs are, whose press hands the
 * link to `onLinkPress`. Their keys are `${key}-<line>-<place in the line>`. Without both, a link draws nothing.
 */
export const styledLines = ({
  lines,
  width,
  key = 'link',
  Button,
  onLinkPress,
}: {
  lines: readonly (readonly StyledSpan[])[]
  /** The most characters of a line that are drawn */
  width?: number
  key?: string
  Button?: ButtonConstructor
  onLinkPress?: (link: string) => unknown
}): RenderElement =>
  ({
    type: 'Box',
    props: { flexDirection: 'column' },
    children: lines.map((line, row) => {
      let room = width ?? Number.POSITIVE_INFINITY
      // The runs drawn, side by side under the link they carry (none: plain text)
      const groups: { link?: string; runs: unknown[] }[] = []

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
        const run = Object.keys(props).length === 0 ? text : { type: 'Text', props, children: [text] }
        const link =
          Button !== undefined && onLinkPress !== undefined && typeof span.link === 'string' && span.link !== '' ? span.link : undefined
        const last = groups[groups.length - 1]
        if (last !== undefined && last.link === link) last.runs.push(run)
        else groups.push({ link, runs: [run] })
      }

      // An empty line still takes its row
      if (groups.length === 0) return { type: 'Text', props: { wrap: 'truncate-end' }, children: [' '] }
      if (groups.length === 1 && groups[0]?.link === undefined) {
        return { type: 'Text', props: { wrap: 'truncate-end' }, children: groups[0]?.runs }
      }

      return {
        type: 'Box',
        props: { flexDirection: 'row' },
        children: groups.map((group, place) => {
          const { link, runs } = group
          if (link === undefined || Button === undefined || onLinkPress === undefined) {
            return { type: 'Text', props: { wrap: 'truncate-end' }, children: runs }
          }

          return Button({
            key: `${key}-${row}-${place}`,
            label: link,
            plain: true,
            onPress: () => onLinkPress(link),
            children: runs as RenderElement[],
          })
        }),
      }
    }),
  }) as unknown as RenderElement
