// @ui-kit
// ui-kit part: pagination. Copy this file to a mod's `hooks/kit/pagination.ts`, then
// `import { pagination } from './kit/pagination'`. Self-contained: its only import is a type.
import type { RenderElement } from 'claude-code'

type ButtonConstructor = (props: { key: string; onPress: () => unknown; children: readonly RenderElement[] }) => RenderElement

const glyphText = (glyph: string): RenderElement =>
  ({ type: 'Text', props: { color: 'claude', bold: true }, children: [glyph] }) as unknown as RenderElement

const pagerButton = (key: string, glyph: string, Button?: ButtonConstructor, onPress?: () => unknown): unknown =>
  Button !== undefined && onPress !== undefined
    ? // A press the mod answers in the button itself: the engine draws only a Button some plugin holds a press for
      Button({ key, onPress, children: [glyphText(glyph)] })
    : {
        type: 'Button',
        props: { key, label: glyph, variant: 'secondary' },
        children: [glyphText(glyph)],
      }

/**
 * Chevron buttons for the pages before and after `current`. Their keys are `${key}-previous` and
 * `${key}-next`: the mod answers them with `on('ui.press', { plugin, element: '<key>-next' }, ...)`, or passes
 * its `Button` (from `$.ui.resolve(e)`) with `onPrevious` / `onNext` to run on the press.
 */
export const pagination = ({
  key,
  current,
  pageCount,
  Button,
  onPrevious,
  onNext,
}: {
  key: string
  current: number
  pageCount: number
  Button?: ButtonConstructor
  onPrevious?: () => unknown
  onNext?: () => unknown
}): RenderElement =>
  ({
    type: 'Box',
    props: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 1, marginTop: 1, paddingX: 1 },
    children: [
      ...(current > 1 ? [pagerButton(`${key}-previous`, '‹', Button, onPrevious)] : []),
      ...(current < pageCount ? [pagerButton(`${key}-next`, '›', Button, onNext)] : []),
    ],
  }) as unknown as RenderElement
