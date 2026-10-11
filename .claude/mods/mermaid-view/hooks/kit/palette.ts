// @ui-kit
// ui-kit part: palette. Copy this file to a mod's `hooks/kit/palette.ts`, then
// `import { PALETTE } from './kit/palette'`. Self-contained: no imports.
//
// For the rare raw color a mod wants of its own. The other parts use theme colors, which follow the
// person's light or dark theme: prefer those.

/** The Anthropic palette as hex colors. */
export const PALETTE = {
  ink: '#141413',
  ivory: '#faf9f5',
  gray: '#b0aea5',
  border: '#b0aea5',
  orange: '#d97757',
  blue: '#6a9bcc',
  green: '#788c5d',
  red: '#e05d5d',
} as const
