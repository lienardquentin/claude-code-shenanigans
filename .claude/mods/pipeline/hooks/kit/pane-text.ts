// @ui-kit
// ui-kit part: pane-text. Copy this file to a mod's `hooks/kit/pane-text.ts`, then `import { paneView } from './kit/pane-text'`.
// Self-contained: it imports nothing.

type Shape = { type?: unknown; ref?: unknown; props?: Record<string, unknown>; children?: unknown }

/** The mod's own open panes, as `$.ui.panes()` answers: `$` itself never leaves the hooks module. */
export type OpenPanes = () => Promise<readonly { id: string; isShown: boolean; isPlaced: boolean }[]>


// What the model is handed at most: a pane that lists more is cut, and says so
const MAX_CHARS = 20_000
// A one-line box that hides what overflows is clipped by the pane, whose width is not known here
const CLIPPED_COLUMNS = 60
// A bordered box is a panel: what it holds is set in, so a panel inside a panel reads as one
const INSET = '  '
// Said after a button drawn filled
const FILLED = '*'
const FILLED_LEGEND = `A button marked ${FILLED} is drawn filled: the main action, or the choice in force.`

const flat = (value: unknown): unknown[] =>
  Array.isArray(value) ? value.flatMap(flat) : value === null || value === undefined || typeof value === 'boolean' ? [] : [value]

const said = (value: unknown): string => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '')

const count = (value: unknown): number => (typeof value === 'number' && value > 0 ? Math.floor(value) : 0)

const childrenOf = (node: Shape): unknown[] => flat(node.children ?? node.props?.children)

const blank = (rows: number): string[] => Array.from({ length: rows }, () => '')

// A row whose every child is one line is one line; with a child of several lines, the children are stacked
const rowOf = (children: readonly unknown[], props: Record<string, unknown>): string[] => {
  const cells = children.map(child => ({ lines: linesOf(child), width: count((child as Shape).props?.width) })).filter(cell => cell.lines.length > 0)

  if (cells.some(cell => cell.lines.length > 1)) return cells.flatMap(cell => cell.lines)

  // Children pushed apart are still two things: they keep a space between them
  const apart = said(props.justifyContent).startsWith('space-') ? 2 : 0
  const between = ' '.repeat(Math.max(count(props.gap) || count(props.columnGap), apart))

  return cells.length === 0 ? [] : [cells.map(cell => (cell.lines[0] ?? '').padEnd(cell.width)).join(between)]
}

const columnOf = (children: readonly unknown[], props: Record<string, unknown>): string[] => {
  const gap = count(props.gap) || count(props.rowGap)

  return children
    .map(child => {
      const own = (child as Shape).props ?? {}

      return { lines: linesOf(child), above: count(own.marginTop) || count(own.marginY), isPanel: own.borderStyle !== undefined }
    })
    .filter(block => block.lines.length > 0)
    .flatMap((block, index, blocks) => {
      // A panel's border sets it apart from what is above and below it: here a blank line does
      const apart = block.isPanel || blocks[index - 1]?.isPanel === true ? 1 : 0

      return [...blank(index === 0 ? 0 : Math.max(gap, block.above, apart)), ...block.lines]
    })
}

const boxOf = (node: Shape): string[] => {
  const props = node.props ?? {}
  const children = childrenOf(node)
  const inner = said(props.flexDirection).startsWith('column') ? columnOf(children, props) : rowOf(children, props)
  const isClipped = props.overflow === 'hidden' && props.height === 1
  const kept = count(props.height) > 0 ? inner.slice(0, count(props.height)) : inner
  const lines = isClipped ? kept.map(line => line.slice(0, CLIPPED_COLUMNS)) : kept

  return props.borderStyle !== undefined ? lines.map(line => (line === '' ? '' : INSET + line)) : lines
}

const selectOf = (props: Record<string, unknown>): string => {
  const options = flat(props.options).map(option => option as { value?: unknown; label?: unknown })
  const picked = options.find(option => option.value === props.value)
  const label = said(props.label)

  return `${label !== '' ? `${label}: ` : ''}${said(picked?.label ?? props.value) || '(nothing picked)'} (of ${options.map(option => said(option.label ?? option.value)).join(', ')})`
}

const inputOf = (props: Record<string, unknown>): string => {
  const label = said(props.label)
  const value = said(props.value)
  const placeholder = said(props.placeholder)

  return `${label !== '' ? `${label}: ` : ''}[${value}]${value === '' && placeholder !== '' ? ` (empty; hint: ${placeholder})` : ''}`
}

const linkOf = (node: Shape): string => {
  const href = said(node.props?.href)
  const text = childrenOf(node).map(inlineOf).join('') || said(node.props?.label)

  return text === '' || text === href ? href : href === '' ? text : `${text} (${href})`
}

// The text of something drawn in a line: what a Text, a Button or a Link holds
const inlineOf = (child: unknown): string => (typeof child === 'string' ? child : linesOf(child).join('\n'))

const linesOf = (value: unknown): string[] => {
  if (typeof value === 'string' || typeof value === 'number') return String(value).split('\n')
  if (Array.isArray(value)) return columnOf(flat(value), {})
  if (value === null || typeof value !== 'object') return []

  const node = value as Shape
  const props = node.props ?? {}

  switch (node.type) {
    case 'Box':
      return boxOf(node)
    case 'Text':
      return childrenOf(node).map(inlineOf).join('').split('\n')
    case 'Button': {
      // A button reads as one: its label between brackets, as the terminal draws it. One drawn filled says so by
      // its color alone, which is the main action or the choice in force: here a mark says it
      const isFilled = props.variant === 'primary' || childrenOf(node).some(child => (child as Shape).props?.backgroundColor !== undefined)

      return [`[${(childrenOf(node).map(inlineOf).join('') || said(props.label)).trim()}]${isFilled ? FILLED : ''}`]
    }
    case 'Input':
      return [inputOf(props)]
    case 'Select':
      return [selectOf(props)]
    case 'Link':
      return [linkOf(node)]
    case 'Code':
      return said(props.source).split('\n')
    case 'Markdown':
      return said(props.text).split('\n')
    case 'Svg':
    case 'Image':
      return [`(picture: ${said(props.alt) || 'no description'})`]
    case 'Raster':
      return ['(a drawing in terminal cells)']
    case 'Client':
      return ['(a region the mod draws on the surface itself)']
    case 'engine':
      return ["(the engine's own drawing)"]
    default:
      return columnOf(childrenOf(node), {})
  }
}

/**
 * A drawn tree as the text a person reads off it: one line per row, a panel's content set in, a button as
 * `[label]` (`[label]*` when it is drawn filled), a field as `label: [value]`, a picker as `label: picked (of every option)`, code as its source. Colors
 * and borders say nothing here; text the pane cuts at its width is whole. Past 20,000 characters it is cut.
 */
export const paneText = (tree: unknown): string => {
  const lines = linesOf(tree)
    .map(line => line.trimEnd())
    // Rows of blank lines say no more than one
    .filter((line, index, all) => line !== '' || (index > 0 && all[index - 1] !== ''))
  // The first line keeps its inset, so a panel's title stands over what the panel holds
  const text = lines.join('\n').trimEnd()

  if (text.length <= MAX_CHARS) return text

  const shown = text.slice(0, MAX_CHARS)
  const left = text.slice(MAX_CHARS).split('\n').length

  return `${shown}\n… cut here: about ${left} more ${left === 1 ? 'line' : 'lines'} are drawn in the pane.`
}

const agoOf = (ms: number): string => {
  const seconds = Math.max(0, Math.round(ms / 1000))

  return seconds < 60 ? `${seconds}s ago` : seconds < 3600 ? `${Math.floor(seconds / 60)} min ago` : `${Math.floor(seconds / 3600)} h ago`
}

/**
 * A pane the model can read: the mod keeps each tree its render hook returns, and serves a tool that answers the
 * latest as text, with whether the pane is open. One view per pane, made beside the mod's atoms.
 *
 * - `await $.tool.register(view.tool).catch(() => undefined)` in `session.start`: the tool is `mcp__<mod>__pane`,
 *   and a host that registers no tools still starts the session;
 * - `return view.keep(tree)` wherever the pane's `ui.render` hook returns;
 * - `on('tool.call', { tool: 'mcp__<mod>__pane' }, $ => view.answer(() => $.ui.panes()))`.
 *
 * `command` is what opens the pane, as the person types it (`/timeline`).
 */
export const paneView = ({ id, title, command }: { id: string; title: string; command: string }) => {
  let kept: { tree: unknown; at: number; columns: number } | undefined

  return {
    /** What `$.tool.register` takes. */
    tool: {
      name: 'pane',
      description: `Reads the "${title}" side pane (${command}) as text: what it shows the person right now, or last showed. Call it when they speak of that pane or of something only it shows.`,
    },
    /**
     * Keeps the tree as the pane's latest drawing, and hands it back to be returned. `columns` is the pane's
     * `bodyColumns` as it was drawn: the reader is told how wide the drawing was, where its text wraps.
     */
    keep: <T>(tree: T, columns?: number): T => {
      kept = { tree, at: Date.now(), columns: count(columns) }

      return tree
    },
    /** What the tool answers: how the pane stands, then its latest drawing as text. */
    answer: async (openPanes: OpenPanes): Promise<{ result: string }> => {
      // A session that cannot say which panes are open still has the drawing to read
      const pane = await openPanes()
        .then(panes => panes.find(one => one.id === id) ?? null)
        .catch(() => undefined)
      const standing =
        pane === undefined
          ? ''
          : pane === null
            ? 'closed'
            : !pane.isPlaced
              ? 'open, waiting for room to be drawn'
              : pane.isShown
                ? 'open and shown'
                : "open, behind another pane's tab"

      if (kept === undefined) {
        return { result: `The "${title}" pane has drawn nothing in this session${standing !== '' ? ` (${standing})` : ''}. ${command} opens it.` }
      }

      const drawn = `drawn ${agoOf(Date.now() - kept.at)}${kept.columns > 0 ? `, ${kept.columns} columns wide` : ''}`
      const head =
        standing === 'open and shown' || standing === ''
          ? `The "${title}" pane${standing !== '' ? `, ${standing}` : ''} (${drawn}):`
          : `The "${title}" pane is ${standing}. What it last showed (${drawn}), which may be out of date; ${command} opens it:`

      const text = paneText(kept.tree)

      return { result: `${head}${text.includes(`]${FILLED}`) ? ` ${FILLED_LEGEND}` : ''}\n\n${text}` }
    },
  }
}
