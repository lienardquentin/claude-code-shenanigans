/** The way a diagram flows: top-down, bottom-up, left to right or right to left. */
export type Direction = 'TD' | 'BT' | 'LR' | 'RL'

export type Shape = 'rectangle' | 'rounded' | 'stadium' | 'diamond' | 'circle'

/** `-->` is an arrow, `---` an open line, `-.->` a dotted arrow and `==>` a thick one. */
export type EdgeKind = 'arrow' | 'open' | 'dotted' | 'thick'

/** A diagram read from Mermaid source: its nodes in the order they were first named, and its edges. */
export type Diagram = {
  direction: Direction
  nodes: { id: string; label: string; shape: Shape }[]
  edges: { from: string; to: string; kind: EdgeKind; label?: string }[]
}

export type ParseResult = { ok: true; diagram: Diagram } | { ok: false; line: string }

const HEADER = /^(?:graph|flowchart)(?:\s+(TD|TB|BT|LR|RL))?$/i
const NODE = /^([\p{L}\p{N}_-]+)(?:(\(\(|\(\[|\[|\(|\{)(.*?)(\)\)|\]\)|\]|\)|\}))?$/u

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
  const statements = splitOutsideLabels(source, [';', '\n'])
    .map(statement => statement.trim())
    .filter(statement => statement !== '' && !statement.startsWith('%%'))

  const header = HEADER.exec(statements[0] ?? '')
  if (header === null) return { ok: false, line: statements[0] ?? '' }

  const word = header[1]?.toUpperCase()
  const direction: Direction = word === 'BT' || word === 'LR' || word === 'RL' ? word : 'TD'
  const nodes: Diagram['nodes'] = []
  const edges: Diagram['edges'] = []

  for (const statement of statements.slice(1)) {
    const { groups, edges: links } = tokenize(statement)
    const members: string[][] = []

    for (const group of groups) {
      const ids: string[] = []

      for (const reference of splitOutsideLabels(group, ['&'])) {
        const match = NODE.exec(reference.trim())
        if (match === null) return { ok: false, line: statement }

        const id = match[1] as string
        const opener = match[2]
        const closer = match[4]
        const wrapper = opener === undefined ? undefined : SHAPES[opener]
        if (opener !== undefined && (wrapper === undefined || wrapper.close !== closer)) return { ok: false, line: statement }

        const label = match[3] === undefined ? undefined : unquoted(match[3])
        const known = nodes.find(node => node.id === id)

        if (known === undefined) {
          nodes.push({ id, label: label ?? id, shape: wrapper?.shape ?? 'rectangle' })
        } else if (wrapper !== undefined) {
          known.label = label ?? id
          known.shape = wrapper.shape
        }

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

  return { ok: true, diagram: { direction, nodes, edges } }
}
