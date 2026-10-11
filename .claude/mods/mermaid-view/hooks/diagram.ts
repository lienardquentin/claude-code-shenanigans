/** A diagram read from Mermaid source: its nodes in the order they were first named, and its edges. */
export type Diagram = {
  nodes: { id: string; label: string }[]
  edges: { from: string; to: string }[]
}

export type ParseResult = { ok: true; diagram: Diagram } | { ok: false; line: string }

// Only the top-down direction is drawn so far; another direction is reported as unreadable, not drawn upside down
const HEADER = /^(?:graph|flowchart)(?:\s+(?:TD|TB))?$/i
const NODE = /^([\p{L}\p{N}_-]+)(?:\[(.*)\])?$/u

// Splits at the separators that are not inside square brackets, so a label may hold a `;` or an arrow
const splitOutsideLabels = (text: string, separators: readonly string[]): string[] => {
  const parts: string[] = []
  let depth = 0
  let start = 0
  let index = 0

  while (index < text.length) {
    const char = text[index]
    if (char === '[') depth += 1
    else if (char === ']') depth = Math.max(0, depth - 1)

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

const unquoted = (label: string): string => {
  const text = label.trim()

  return text.length >= 2 && text.startsWith('"') && text.endsWith('"') ? text.slice(1, -1) : text
}

/**
 * Reads a diagram: a `graph`/`flowchart` header, then statements of nodes (`A`, `A[Label]` or `A["Label"]`) joined by
 * `-->`, separated by `;` or a new line. The first statement that is none of these is the one reported.
 */
export const parseDiagram = (source: string): ParseResult => {
  const statements = splitOutsideLabels(source, [';', '\n'])
    .map(statement => statement.trim())
    .filter(statement => statement !== '' && !statement.startsWith('%%'))

  if (statements.length === 0 || !HEADER.test(statements[0] ?? '')) return { ok: false, line: statements[0] ?? '' }

  const nodes: Diagram['nodes'] = []
  const edges: Diagram['edges'] = []

  for (const statement of statements.slice(1)) {
    const ids: string[] = []

    for (const part of splitOutsideLabels(statement, ['-->'])) {
      const match = NODE.exec(part.trim())
      if (match === null) return { ok: false, line: statement }

      const id = match[1] as string
      const label = match[2] === undefined ? undefined : unquoted(match[2])
      const known = nodes.find(node => node.id === id)

      if (known === undefined) nodes.push({ id, label: label ?? id })
      else if (label !== undefined) known.label = label

      ids.push(id)
    }

    for (let index = 1; index < ids.length; index += 1) {
      edges.push({ from: ids[index - 1] as string, to: ids[index] as string })
    }
  }

  return { ok: true, diagram: { nodes, edges } }
}
