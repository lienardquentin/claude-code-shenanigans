// @ui-kit
// ui-kit part: tree. Copy this file to a mod's `hooks/kit/tree.ts`, then `import { tree } from './kit/tree'`.
// Self-contained: its only import is a type.
import type { RenderElement } from 'claude-code'

/** What a node says about its label: drawn in the matching theme color. */
export type Tone = 'neutral' | 'accent' | 'info' | 'success' | 'warning' | 'danger'

/**
 * `meta` is said dimly after the label (a count, a status, a duration); `value` is what the node holds, said last
 * on the row in the default color, so it is the first of the row to be cut; `children` hang under the node. `detail`
 * is what the one line of the node cannot hold (a long value, formatted data), of as many lines as it takes:
 * drawn under the node while `isOpen`. `id` names the node to `onToggle`; the label does when there is none.
 */
export type TreeNode = { label: string; tone?: Tone; meta?: string; value?: string; children?: readonly TreeNode[]; id?: string; detail?: string; isOpen?: boolean }

const TONE_COLOR: Record<Tone, string> = {
  neutral: 'subtle',
  accent: 'claude',
  info: 'suggestion',
  success: 'success',
  warning: 'warning',
  danger: 'error',
}

// What a `Text` cannot hold is taken out: every control character, an escape included
const clean = (text: string): string =>
  // eslint-disable-next-line no-control-regex
  text.replace(/[\u0000-\u001F\u007F]/g, '')

// The lines of a detail, the spaces a line leads with kept as its indentation
const detailLines = (detail: string): string[] => detail.split('\n').map(line => clean(line).replace(/^ +/, spaces => ' '.repeat(spaces.length)))

const openLines = (node: TreeNode): string[] => (node.isOpen === true && node.detail !== undefined && node.detail !== '' ? detailLines(node.detail) : [])

/** How many rows the nodes take when all are drawn: one per node, at every depth, and the lines of each open detail. */
export const treeSize = (nodes: readonly TreeNode[]): number =>
  nodes.reduce((sum, node) => sum + 1 + openLines(node).length + treeSize(node.children ?? []), 0)

type ButtonConstructor = (props: {
  key: string
  label: string
  plain: true
  onPress: () => unknown
  children: readonly RenderElement[]
}) => RenderElement

// A piece of a row and how it is drawn
type Run = { text: string; props?: Record<string, unknown> }

const drawn = ({ text, props }: Run): unknown => (props === undefined || Object.keys(props).length === 0 ? text : { type: 'Text', props, children: [text] })

// The runs as lines: `first` characters at most on the first, `rest` on those after, broken at a space when one
// is in the second half of the line
const wrapped = (runs: readonly Run[], first: number, rest: number): Run[][] => {
  const cells = runs.flatMap((run, place) => [...run.text].map(char => ({ char, place })))
  const lines: Run[][] = []
  let from = 0

  while (from < cells.length) {
    const room = Math.max(8, lines.length === 0 ? first : rest)
    let to = Math.min(cells.length, from + room)

    if (to < cells.length) {
      let space = to

      while (space > from + room / 2 && cells[space]?.char !== ' ') space -= 1

      if (cells[space]?.char === ' ') to = space
    }

    const line: (Run & { place: number })[] = []

    for (const { char, place } of cells.slice(from, to)) {
      const last = line[line.length - 1]

      if (last !== undefined && last.place === place) last.text += char
      else line.push({ text: char, place, ...(runs[place]?.props !== undefined ? { props: runs[place]?.props } : {}) })
    }

    lines.push(line.map(({ text, props }) => (props === undefined ? { text } : { text, props })))
    from = to

    // The space a line is broken at is not said
    while (cells[from]?.char === ' ') from += 1
  }

  return lines.length > 0 ? lines : [[]]
}

/**
 * A tree: one row per node, the children of a node hung under it on guide lines. A top node has no guide; a node
 * that has children is bold. Without `width`, a row is one line, cut at the width it is drawn in. With `width`
 * (the characters a row has), a longer row goes on under itself, past its guide and further in than its label,
 * never back at the left edge, and the guides go on beside it. With `maxRows`, the lines past it are left out and
 * a last row says how many nodes; `empty` is said when there are no nodes.
 *
 * A node with a `detail` opens and closes when the mod passes its `Button` (from `$.ui.resolve(e)`) and `onToggle`:
 * its row is then a button marked `▸` (closed) or `▾` (open), whose press hands the node's `id` to `onToggle`; the
 * mod keeps which are open and says so with `isOpen`. The keys are `${key}-<place among the nodes that open>`. An
 * open detail is drawn under its row, line by line, a long line going on under itself as a row does. Without
 * both, a node is not marked.
 */
export const tree = ({
  nodes,
  maxRows,
  empty = 'Nothing yet.',
  width,
  key = 'node',
  Button,
  onToggle,
}: {
  nodes: readonly TreeNode[]
  maxRows?: number
  empty?: string
  /** How many characters a row has: with it, a longer row is wrapped under itself instead of cut */
  width?: number
  key?: string
  Button?: ButtonConstructor
  onToggle?: (id: string) => unknown
}): RenderElement => {
  const rows: unknown[] = []
  const room = maxRows ?? Number.POSITIVE_INFINITY
  // The lines taken, which a wrapped row has several of, and the nodes and detail lines said
  let taken = 0
  let said = 0
  let opening = 0

  // One row as text: its lines one under the other, each led by its guide; one line cut when there is no `width`
  const rowOf = (head: string, onward: string, runs: readonly Run[]): { row: unknown; lines: number } => {
    const lines = width === undefined ? [[...runs]] : wrapped(runs, width - head.length, width - onward.length)

    return {
      lines: lines.length,
      row: {
        type: 'Text',
        props: { wrap: lines.length > 1 ? 'wrap' : 'truncate-end' },
        children: lines.flatMap((line, place) => {
          const guide = place === 0 ? head : onward

          return [...(place > 0 ? ['\n'] : []), ...(guide !== '' ? [{ type: 'Text', props: { color: 'subtle' }, children: [guide] }] : []), ...line.map(drawn)]
        }),
      },
    }
  }

  const walk = (level: readonly TreeNode[], lead: string, isTop: boolean): void => {
    level.forEach((node, index) => {
      if (taken >= room) return

      const isLast = index === level.length - 1
      const children = node.children ?? []
      const guide = isTop ? '' : lead + (isLast ? '└─ ' : '├─ ')
      const under = isTop ? '' : lead + (isLast ? '   ' : '│  ')
      // Beside what goes on under the row: the guide its children hang from
      const beside = `${under}${children.length > 0 ? '│' : ' '}`
      const props = {
        ...(node.tone !== undefined ? { color: TONE_COLOR[node.tone] } : {}),
        ...(children.length > 0 ? { bold: true } : {}),
      }
      const label = clean(node.label)
      const meta = node.meta !== undefined ? clean(node.meta) : ''
      const value = node.value !== undefined ? clean(node.value) : ''
      const isOpen = node.isOpen === true
      const opens = Button !== undefined && onToggle !== undefined && node.detail !== undefined && node.detail !== ''

      const { row, lines } = rowOf(guide, `${beside}    `, [
        ...(opens ? [{ text: isOpen ? '▾ ' : '▸ ', props: { color: 'suggestion' } }] : []),
        { text: label, props },
        ...(meta !== '' ? [{ text: `  ${meta}`, props: { color: 'subtle' } }] : []),
        ...(value !== '' ? [{ text: `  ${value}` }] : []),
      ])

      if (opens) {
        const id = node.id ?? node.label

        rows.push(
          Button({
            key: `${key}-${opening}`,
            label: `${isOpen ? 'Close' : 'Open'} ${label}`,
            plain: true,
            onPress: () => onToggle(id),
            children: [row as unknown as RenderElement],
          }),
        )
        opening += 1
      } else {
        rows.push(row)
      }

      taken += lines
      said += 1

      for (const line of openLines(node)) {
        if (taken >= room) break

        // A line that goes on keeps the indentation it leads with, and two more
        const indent = /^ */.exec(line)?.[0] ?? ''
        const detail = rowOf(`${beside}   `, `${beside}   ${indent}  `, [{ text: line === '' ? ' ' : line }])

        rows.push(detail.row)
        taken += detail.lines
        said += 1
      }

      walk(children, under, false)
    })
  }

  walk(nodes, '', true)

  if (rows.length === 0) rows.push({ type: 'Text', props: { color: 'subtle' }, children: [empty] })

  const left = treeSize(nodes) - said
  if (left > 0) rows.push({ type: 'Text', props: { color: 'subtle' }, children: [`… ${left} more`] })

  return { type: 'Box', props: { flexDirection: 'column' }, children: rows } as unknown as RenderElement
}
