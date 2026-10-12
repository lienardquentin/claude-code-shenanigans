// @ui-kit
// ui-kit part: table. Copy this file to a mod's `hooks/kit/table.ts`, then `import { table } from './kit/table'`.
// Self-contained: its only import is a type.
import type { RenderElement } from 'claude-code'

/** What a cell says about its text: drawn in the matching theme color. */
export type CellTone = 'neutral' | 'accent' | 'info' | 'success' | 'warning' | 'danger'

/**
 * `width` fixes the column in cells; a column without one shares what is left. `wrap` lets the column's text run
 * onto as many lines as it needs, by words, instead of being cut to one.
 */
export type TableColumn = { header: string; width?: number; wrap?: boolean }

/** A string, `{ text, tone }`, or an element drawn as it is (a `<Button>`, say). */
export type TableCell = string | { text: string; tone: CellTone } | RenderElement

const TONE_COLOR: Record<CellTone, string> = {
  neutral: 'text',
  accent: 'claude',
  info: 'suggestion',
  success: 'success',
  warning: 'warning',
  danger: 'error',
}

const node = (type: string, props: Record<string, unknown>, children: readonly (RenderElement | string)[] = []): RenderElement =>
  (children.length > 0 ? { type, props, children } : { type, props }) as unknown as RenderElement

const cellBox = (column: TableColumn, content: RenderElement): RenderElement =>
  node(
    'Box',
    column.width !== undefined
      ? { width: column.width, flexShrink: 0, overflow: 'hidden' }
      : { flexGrow: 1, flexShrink: 1, overflow: 'hidden' },
    [content],
  )

/**
 * A table: a bold header row, then one row per entry of `rows`, cells aligned by column. A cell is a string or
 * `{ text, tone }`; text longer than its column is cut to one line, or wrapped in a column that has `wrap`. `empty`
 * is said when there are no rows.
 */
export const table = ({
  columns,
  rows,
  empty = 'Nothing yet.',
}: {
  columns: readonly TableColumn[]
  rows: readonly (readonly TableCell[])[]
  empty?: string
}): RenderElement => {
  const head = node(
    'Box',
    { flexDirection: 'row', gap: 2 },
    columns.map(column =>
      cellBox(column, node('Text', { bold: true, color: 'subtle', wrap: 'truncate-end' }, [column.header])),
    ),
  )

  if (rows.length === 0) {
    return node('Box', { flexDirection: 'column' }, [head, node('Text', { color: 'subtle' }, [empty])])
  }

  return node('Box', { flexDirection: 'column' }, [
    head,
    ...rows.map(row =>
      node(
        'Box',
        { flexDirection: 'row', gap: 2 },
        columns.map((column, index) => {
          const cell = row[index] ?? ''
          if (typeof cell !== 'string' && !('text' in cell)) return cellBox(column, cell)

          const { text, tone } = typeof cell === 'string' ? { text: cell, tone: 'neutral' as CellTone } : cell

          return cellBox(column, node('Text', { color: TONE_COLOR[tone], wrap: column.wrap ? 'wrap' : 'truncate-end' }, [text]))
        }),
      ),
    ),
  ])
}
