// @ui-kit
// ui-kit part: divider. Copy this file to a mod's `hooks/kit/divider.ts`, then `import { divider } from './kit/divider'`.
// Self-contained: its only import is a type.
import type { RenderElement } from 'claude-code'

// Longer than any pane; its one-line box clips it to the pane's width
const RULE = '─'.repeat(400)

/** A one-line rule in the theme's subtle color, clipped to the width it is drawn in. */
export const divider = (): RenderElement =>
  ({
    type: 'Box',
    props: { height: 1, overflow: 'hidden' },
    children: [{ type: 'Text', props: { color: 'subtle' }, children: [RULE] }],
  }) as unknown as RenderElement
