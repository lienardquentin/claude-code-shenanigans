// @ui-kit
// ui-kit part: field. Copy this file to a mod's `hooks/kit/field.ts`, then `import { field } from './kit/field'`.
// Self-contained: its only import is a type. Pass the mod's resolved elements: `$.ui.resolve(e)`.
// It builds with `h`, the factory JSX compiles to, so the input keeps its handlers the way a `<Input>` does.
import type { Elements } from 'claude-code'

type FieldElements = Pick<Elements['terminal'], 'Box' | 'Text' | 'Input'>

/**
 * A text field with its label above it, the label in the subtle color. The mod keeps the text in its own
 * state: pass it as `value`, write each change back from `onInput`, and run the mod's action from `onSubmit`
 * (Enter). The field's `key` is its address, the one a `ui.input` names.
 */
export const field = (
  { Box, Text, Input }: FieldElements,
  {
    key,
    label,
    value,
    placeholder,
    onInput,
    onSubmit,
  }: {
    key: string
    label: string
    value: string
    placeholder?: string
    onInput: (value: string) => void
    onSubmit: (value: string) => void
  },
) =>
  h(
    Box,
    { flexDirection: 'column', gap: 1 },
    h(Text, { color: 'subtle' }, label),
    h(Input, { key, value, onInput, onSubmit, ...(placeholder !== undefined ? { placeholder } : {}) }),
  )
