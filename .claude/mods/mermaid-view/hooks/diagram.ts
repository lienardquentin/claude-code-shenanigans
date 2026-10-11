/** The way a diagram flows: top-down, bottom-up, left to right or right to left. */
export type Direction = 'TD' | 'BT' | 'LR' | 'RL'

export type Shape = 'rectangle' | 'rounded' | 'stadium' | 'diamond' | 'circle'

/** `-->` is an arrow, `---` an open line, `-.->` a dotted arrow and `==>` a thick one. */
export type EdgeKind = 'arrow' | 'open' | 'dotted' | 'thick'

/**
 * What a `click` directive attaches to a node: a web address (`url`, http or https only), a file of the project
 * (`file`, a relative path that stays inside it), or an address of a kind that is never followed (`blocked`).
 */
export type Link = { kind: 'url' | 'file' | 'blocked'; target: string }

/** What a node is drawn with: its label, and a mark after it when a `click` directive gave it a link. */
export const shownLabel = (node: { label: string; link?: Link }): string => {
  if (node.link === undefined) return node.label

  return `${node.label} ${node.link.kind === 'url' ? '↗' : node.link.kind === 'file' ? '▤' : '⊘'}`
}

/** What a node the author marked out is drawn in: one of the theme's colors, never one the source names. */
export type Tone = 'neutral' | 'accent' | 'info' | 'success' | 'warning' | 'danger'

/**
 * A diagram read from Mermaid source: its nodes in the order they were first named, its edges, and the subgraphs
 * that group nodes (a node's `group` is the innermost one it is in; a group's `parent` the one around it).
 */
export type Diagram = {
  direction: Direction
  nodes: { id: string; label: string; shape: Shape; group?: string; tone?: Tone; link?: Link }[]
  edges: { from: string; to: string; kind: EdgeKind; label?: string }[]
  groups: { id: string; title: string; parent?: string }[]
}

/**
 * Why a diagram is not drawn: it is another kind of diagram than a flowchart (`type`), it uses a flowchart feature
 * that is not drawn yet (`unsupported`), or it could not be read as a flowchart at all (`syntax`).
 */
export type Problem =
  | { kind: 'type'; what: string }
  | { kind: 'unsupported'; what: string }
  | { kind: 'syntax' }

/** On failure, the statement it stopped at, which line of the source it starts on (from 1), and why. */
export type ParseResult =
  | { ok: true; diagram: Diagram }
  | { ok: false; line: string; number: number; problem: Problem }

/** The most nodes a diagram may have to be drawn: past it the pane shows the source, with a note. */
export const MAX_NODES = 200

/** The source of each ```mermaid fenced block in a text, in order. */
export const mermaidBlocks = (text: string): string[] =>
  [...text.matchAll(/```mermaid[^\n]*\n([\s\S]*?)```/gi)]
    .map(match => (match[1] as string).trim())
    .filter(block => block !== '')

/**
 * Whether an argument to the command is diagram text rather than the path of a file: it has several statements or
 * lines, an edge, or opens with a diagram keyword.
 */
export const looksLikeDiagram = (argument: string): boolean =>
  /[;\n]|-->|---|==>/.test(argument) ||
  /^(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie|journey|mindmap)\b/i.test(argument)

const HEADER = /^(?:graph|flowchart)(?:\s+(TD|TB|BT|LR|RL))?$/i
const NODE = /^([\p{L}\p{N}_-]+)(?:(\(\(|\(\[|\[|\(|\{)(.*?)(\)\)|\]\)|\]|\)|\}))?(?::::([\p{L}\p{N}_-]+))?$/u
const NAME = '[\\p{L}\\p{N}_-]+'
const SUBGRAPH = /^subgraph\s+(.+)$/i
const SUBGRAPH_ID = new RegExp(`^(${NAME})\\s*\\[(.*)\\]$`, 'u')
const CLASS_DEF = new RegExp(`^classDef\\s+(${NAME})(?:\\s+.*)?$`, 'iu')
const CLASS_USE = new RegExp(`^class\\s+(\\S+)\\s+(${NAME})$`, 'iu')
const STYLE = new RegExp(`^style\\s+(${NAME})(?:\\s+.*)?$`, 'iu')
// `click A "target"`, `click A href "target"`, with an optional tooltip and window name that are not read
const CLICK = new RegExp(`^click\\s+(${NAME})\\s+(?:href\\s+)?("[^"]*"|[^\\s"]+)(?:\\s+"[^"]*")?(?:\\s+_\\w+)?$`, 'iu')

// What a click directive's target is: a web page, a file inside the project, or something that is never followed
// (another scheme, an absolute path, a way out of the project)
const linkOf = (target: string): Link => {
  if (/^https?:\/\//i.test(target)) return { kind: 'url', target }
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || /^[\\/]/.test(target)) return { kind: 'blocked', target }
  if (target.split(/[\\/]/).includes('..')) return { kind: 'blocked', target }

  return { kind: 'file', target }
}

// A class names a tone when its name says one; any other class or style marks the node out in the accent tone. The
// colors the source gives (`fill:#f96`) are never read.
const TONE_OF_NAME: Record<string, Tone> = {
  neutral: 'neutral',
  accent: 'accent',
  info: 'info',
  success: 'success',
  ok: 'success',
  good: 'success',
  warning: 'warning',
  warn: 'warning',
  danger: 'danger',
  error: 'danger',
  bad: 'danger',
}

const toneOf = (className: string): Tone => TONE_OF_NAME[className.toLowerCase()] ?? 'accent'

// Other kinds of Mermaid diagram, which have a grammar of their own
const OTHER_TYPES =
  /^(sequenceDiagram|classDiagram(?:-v2)?|stateDiagram(?:-v2)?|erDiagram|gantt|pie|journey|mindmap|gitGraph|timeline|quadrantChart|requirementDiagram|C4\w+|sankey(?:-beta)?|xychart(?:-beta)?|block(?:-beta)?|architecture(?:-beta)?|packet(?:-beta)?|kanban)\b/i

// Flowchart features that are read in Mermaid and not drawn here yet, each named for the message
const UNSUPPORTED: readonly (readonly [RegExp, string])[] = [
  [/^linkStyle\b/i, '`linkStyle`'],
  [/^click\b/i, 'click callbacks (only a link or a file is followed)'],
  [/^direction\b/i, '`direction` inside a subgraph'],
  [/^(?:accTitle|accDescr)\b/i, 'accessibility titles and descriptions'],
  [/~~~/, 'invisible links (`~~~`)'],
  [/<-->|<-\.->|<==>/, 'arrows with a head at both ends'],
  [/--[xo](?:\s|$)|(?:^|\s)[xo]--/, 'cross and circle ends on an edge'],
  [/--\s*[^>\-|\s][^>|]*\s*-->/, 'text written inside the arrow (`-- text -->`); write `-->|text|`'],
]

const classify = (statement: string, isHeader: boolean): Problem => {
  if (isHeader) {
    const other = OTHER_TYPES.exec(statement)
    return other === null ? { kind: 'syntax' } : { kind: 'type', what: other[1] as string }
  }

  // What is inside brackets is a label, so it cannot be a feature of the statement
  const bare = statement.replace(/\[[^\]]*\]|\([^)]*\)|\{[^}]*\}/g, '')
  const found = UNSUPPORTED.find(([pattern]) => pattern.test(bare))

  return found === undefined ? { kind: 'syntax' } : { kind: 'unsupported', what: found[1] }
}

// The statements of a source with the line each starts on: separated by `;` or a new line outside brackets, blank
// ones and `%%` comments left out
const statementsOf = (source: string): { text: string; line: number }[] => {
  const found: { text: string; line: number }[] = []
  let depth = 0
  let start = 0
  let startLine = 1
  let line = 1

  const push = (end: number): void => {
    const raw = source.slice(start, end)
    const text = raw.trim()
    const skipped = (/^\s*/.exec(raw)?.[0].match(/\n/g) ?? []).length

    if (text !== '' && !text.startsWith('%%')) found.push({ text, line: startLine + skipped })
  }

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] as string
    if ('[({'.includes(char)) depth += 1
    else if ('])}'.includes(char)) depth = Math.max(0, depth - 1)

    if (char === '\n') line += 1

    if (depth === 0 && (char === ';' || char === '\n')) {
      push(index)
      start = index + 1
      startLine = line
    }
  }

  push(source.length)

  return found
}

// What each opening token makes, and the token that has to close it
const SHAPES: Record<string, { shape: Shape; close: string }> = {
  '[': { shape: 'rectangle', close: ']' },
  '(': { shape: 'rounded', close: ')' },
  '([': { shape: 'stadium', close: '])' },
  '((': { shape: 'circle', close: '))' },
  '{': { shape: 'diamond', close: '}' },
}

// Longest first: `-.->` and `-->` both start with a dash
const OPERATORS: readonly (readonly [string, EdgeKind])[] = [
  ['-.->', 'dotted'],
  ['-->', 'arrow'],
  ['---', 'open'],
  ['==>', 'thick'],
]

// Splits at the separators that are not inside brackets, so a label may hold a `;`, an `&` or an arrow
const splitOutsideLabels = (text: string, separators: readonly string[]): string[] => {
  const parts: string[] = []
  let depth = 0
  let start = 0
  let index = 0

  while (index < text.length) {
    const char = text[index] as string
    if ('[({'.includes(char)) depth += 1
    else if ('])}'.includes(char)) depth = Math.max(0, depth - 1)

    const separator = depth === 0 ? separators.find(candidate => text.startsWith(candidate, index)) : undefined

    if (separator !== undefined) {
      parts.push(text.slice(start, index))
      index += separator.length
      start = index
    } else {
      index += 1
    }
  }

  parts.push(text.slice(start))

  return parts
}

// A statement as the node groups between its edge operators, and the operators (with their `|label|`)
const tokenize = (statement: string): { groups: string[]; edges: { kind: EdgeKind; label?: string }[] } => {
  const groups: string[] = []
  const edges: { kind: EdgeKind; label?: string }[] = []
  let depth = 0
  let start = 0
  let index = 0

  while (index < statement.length) {
    const char = statement[index] as string
    if ('[({'.includes(char)) depth += 1
    else if ('])}'.includes(char)) depth = Math.max(0, depth - 1)

    const operator = depth === 0 ? OPERATORS.find(([token]) => statement.startsWith(token, index)) : undefined

    if (operator !== undefined) {
      groups.push(statement.slice(start, index))
      index += operator[0].length

      const label = /^\s*\|([^|]*)\|/.exec(statement.slice(index))
      if (label !== null) index += label[0].length

      edges.push({ kind: operator[1], ...(label !== null ? { label: unquoted(label[1] ?? '') } : {}) })
      start = index
    } else {
      index += 1
    }
  }

  groups.push(statement.slice(start))

  return { groups, edges }
}

function unquoted(label: string): string {
  const text = label.trim()

  return text.length >= 2 && text.startsWith('"') && text.endsWith('"') ? text.slice(1, -1) : text
}

/**
 * Reads a diagram: a `graph`/`flowchart` header with an optional direction (`TD`, `TB`, `BT`, `LR`, `RL`), then
 * statements of nodes (`A`, `A[Label]`, `A(Label)`, `A([Label])`, `A((Label))`, `A{Label}`; labels may be quoted)
 * joined by `-->`, `---`, `-.->` or `==>` (with `|text|` after it), nodes joined by `&`. Statements are separated by
 * `;` or a new line. The first statement that is none of these is the one reported.
 */
export const parseDiagram = (source: string): ParseResult => {
  const statements = statementsOf(source)
  const first = statements[0]
  const fail = (statement: { text: string; line: number }, isHeader = false): ParseResult => ({
    ok: false,
    line: statement.text,
    number: statement.line,
    problem: classify(statement.text, isHeader),
  })

  const header = HEADER.exec(first?.text ?? '')
  if (first === undefined) return { ok: false, line: '', number: 1, problem: { kind: 'syntax' } }
  if (header === null) return fail(first, true)

  const word = header[1]?.toUpperCase()
  const direction: Direction = word === 'BT' || word === 'LR' || word === 'RL' ? word : 'TD'
  const nodes: Diagram['nodes'] = []
  const edges: Diagram['edges'] = []
  const subgraphs: Diagram['groups'] = []
  // The subgraphs a statement is inside, outermost first; a `class` or `style` line may come before the node it names
  const open: string[] = []
  const openedAt = new Map<string, { text: string; line: number }>()
  const marks: { id: string; tone: Tone }[] = []
  const attachments: { id: string; link: Link }[] = []

  for (const located of statements.slice(1)) {
    const statement = located.text
    const opening = SUBGRAPH.exec(statement)

    if (opening !== null) {
      const text = (opening[1] as string).trim()
      const named = SUBGRAPH_ID.exec(text)
      const id = named?.[1] ?? `subgraph-${subgraphs.length}`
      const parent = open[open.length - 1]

      subgraphs.push({ id, title: unquoted(named?.[2] ?? text), ...(parent !== undefined ? { parent } : {}) })
      open.push(id)
      openedAt.set(id, located)
      continue
    }

    if (/^end$/i.test(statement)) {
      if (open.pop() === undefined) return fail(located)
      continue
    }

    // `classDef` only names a class; its colors are not read
    if (CLASS_DEF.test(statement)) continue

    const using = CLASS_USE.exec(statement)

    if (using !== null) {
      for (const id of (using[1] as string).split(',')) marks.push({ id: id.trim(), tone: toneOf(using[2] as string) })
      continue
    }

    const styled = STYLE.exec(statement)

    if (styled !== null) {
      marks.push({ id: styled[1] as string, tone: 'accent' })
      continue
    }

    // A `click` directive gives a node a link or a file; its tooltip and window are not read
    const clicked = CLICK.exec(statement)

    if (clicked !== null) {
      attachments.push({ id: clicked[1] as string, link: linkOf(unquoted(clicked[2] as string)) })
      continue
    }

    const { groups, edges: links } = tokenize(statement)
    const members: string[][] = []

    for (const group of groups) {
      const ids: string[] = []

      for (const reference of splitOutsideLabels(group, ['&'])) {
        const match = NODE.exec(reference.trim())
        if (match === null) return fail(located)

        const id = match[1] as string
        const opener = match[2]
        const closer = match[4]
        const wrapper = opener === undefined ? undefined : SHAPES[opener]
        if (opener !== undefined && (wrapper === undefined || wrapper.close !== closer)) return fail(located)

        const label = match[3] === undefined ? undefined : unquoted(match[3])
        const known = nodes.find(node => node.id === id)
        const group = open[open.length - 1]

        if (known === undefined) {
          nodes.push({
            id,
            label: label ?? id,
            shape: wrapper?.shape ?? 'rectangle',
            ...(group !== undefined ? { group } : {}),
          })
        } else {
          if (wrapper !== undefined) {
            known.label = label ?? id
            known.shape = wrapper.shape
          }
          // A node named inside a subgraph belongs to it, unless it already belongs to one
          if (known.group === undefined && group !== undefined) known.group = group
        }

        if (match[5] !== undefined) marks.push({ id, tone: toneOf(match[5]) })

        ids.push(id)
      }

      members.push(ids)
    }

    links.forEach((link, index) => {
      for (const from of members[index] ?? []) {
        for (const to of members[index + 1] ?? []) {
          edges.push({ from, to, kind: link.kind, ...(link.label !== undefined ? { label: link.label } : {}) })
        }
      }
    })
  }

  const unclosed = open[open.length - 1]
  const opened = unclosed === undefined ? undefined : openedAt.get(unclosed)
  if (opened !== undefined) return { ok: false, line: opened.text, number: opened.line, problem: { kind: 'syntax' } }

  for (const mark of marks) {
    const node = nodes.find(candidate => candidate.id === mark.id)
    if (node !== undefined) node.tone = mark.tone
  }

  for (const attachment of attachments) {
    const node = nodes.find(candidate => candidate.id === attachment.id)
    if (node !== undefined) node.link = attachment.link
  }

  return { ok: true, diagram: { direction, nodes, edges, groups: subgraphs } }
}
