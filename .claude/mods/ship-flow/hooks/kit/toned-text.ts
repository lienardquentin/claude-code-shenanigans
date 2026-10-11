// @ui-kit
// ui-kit part: toned-text. Copy this file to a mod's `hooks/kit/toned-text.ts`, then
// `import { tonedText } from './kit/toned-text'`.
// Self-contained: its only import is a type.
import type { RenderElement } from 'claude-code'

/** What a piece of text says about itself: drawn in the matching theme color. */
export type Tone = 'neutral' | 'accent' | 'info' | 'success' | 'warning' | 'danger'

const TONE_COLOR: Record<Tone, string> = {
  neutral: 'subtle',
  accent: 'claude',
  info: 'suggestion',
  success: 'success',
  warning: 'warning',
  danger: 'error',
}

/**
 * Text in the tone's theme color, with no dot (`badge` has one); without a tone, in the default color. For the parts
 * of a line, some of which stand out, such as the selected cells of a drawing; a Button may hold it as its label.
 */
export const tonedText = ({ text, tone, bold }: { text: string; tone?: Tone; bold?: boolean }): RenderElement =>
  ({
    type: 'Text',
    props: { ...(tone !== undefined ? { color: TONE_COLOR[tone] } : {}), ...(bold === true ? { bold: true } : {}) },
    children: [text],
  }) as unknown as RenderElement
