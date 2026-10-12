// @ui-kit
// ui-kit part: actionLabel. Copy this file to a mod's `hooks/kit/action-label.ts`, then
// `import { actionLabel } from './kit/action-label'`. Self-contained: its only import is a type.
import type { RenderElement } from 'claude-code'

/**
 * The text of a button's label: the accent color on a fill for the main action, the accent color alone
 * otherwise. Place it as the child of the mod's own `<Button key onPress>`.
 * A primary label has a space each side of the text; `compact` leaves them off, so a filled label takes only the width
 * of its text (a selected row's time, say, that must not shift against the unfilled ones).
 */
export const actionLabel = ({
  text,
  primary = false,
  compact = false,
}: {
  text: string
  primary?: boolean
  compact?: boolean
}): RenderElement =>
  ({
    type: 'Text',
    props: primary ? { backgroundColor: 'claude', color: 'inverseText', bold: true } : { color: 'claude', bold: true },
    children: [primary && !compact ? ` ${text} ` : text],
  }) as unknown as RenderElement
