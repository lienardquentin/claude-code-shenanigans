// @ui-kit
// ui-kit part: card. Copy this file to a mod's `hooks/kit/card.ts`, then `import { card } from './kit/card'`.
// Self-contained: its only import is a type.
import type { RenderElement } from 'claude-code'

// `children` is left off when there are none: a leaf such as `Code` refuses the key, even empty
const node = (type: string, props: Record<string, unknown>, children: readonly (RenderElement | string)[] = []): RenderElement =>
  (children.length > 0 ? { type, props, children } : { type, props }) as unknown as RenderElement

const text = (props: Record<string, string | number | boolean>, ...children: string[]): RenderElement =>
  node('Text', props, children)

/**
 * A rounded panel with a title row, an optional meta text and the children below, in theme colors.
 * `width` is the pane's `e.props.bodyColumns`. A `<Button onPress>` may be one of the children.
 */
export const card = ({
  width,
  title,
  meta,
  children = [],
}: {
  width: number
  title: string
  meta?: string
  children?: readonly (RenderElement | string)[]
}): RenderElement =>
  node('Box', { width, flexDirection: 'column', borderStyle: 'round', borderColor: 'promptBorder', paddingX: 1 }, [
    node('Box', { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }, [
      text({ bold: true, color: 'text' }, title),
      ...(meta !== undefined ? [text({ color: 'subtle' }, meta)] : []),
    ]),
    ...(children.length > 0 ? [node('Box', { flexDirection: 'column', marginTop: 1 }, children)] : []),
  ])
