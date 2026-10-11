// @ui-kit
// ui-kit part: badge. Copy this file to a mod's `hooks/kit/badge.ts`, then `import { badge } from './kit/badge'`.
// Self-contained: its only import is a type.
import type { RenderElement } from 'claude-code'

/** What a badge says about its label: drawn in the matching theme color. */
export type Tone = 'neutral' | 'accent' | 'info' | 'success' | 'warning' | 'danger'

const TONE_COLOR: Record<Tone, string> = {
  neutral: 'subtle',
  accent: 'claude',
  info: 'suggestion',
  success: 'success',
  warning: 'warning',
  danger: 'error',
}

/** A dot and a label in the tone's theme color. */
export const badge = ({ label, tone }: { label: string; tone: Tone }): RenderElement =>
  ({ type: 'Text', props: { color: TONE_COLOR[tone] }, children: ['● ', label] }) as unknown as RenderElement
