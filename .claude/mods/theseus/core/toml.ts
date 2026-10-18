// A reader of the TOML a project's .claude/theseus.toml is written in: tables, dotted keys, strings of the four kinds,
// integers, floats, booleans, arrays and inline tables. Arrays of tables and dates are not read: Theseus's file has
// none. Every error names its line, and a statement that does not read is skipped, the rest still read.

export type TomlValue = string | number | boolean | TomlValue[] | TomlTable
export type TomlTable = { [key: string]: TomlValue }

/** What a text reads as: its table, each error with its line, and the line each key was set on, by its dotted path. */
export type TomlRead = { value: TomlTable; errors: string[]; lineOf: Map<string, number> }

class Fault extends Error {}

const BARE = /[A-Za-z0-9_-]/
const isTable = (value: unknown): value is TomlTable => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Reads a TOML text. */
export const parseToml = (text: string): TomlRead => {
  const root: TomlTable = {}
  const errors: string[] = []
  const lineOf = new Map<string, number>()
  // The tables a header made, so one made twice is an error, as TOML has it
  const headed = new Set<string>()
  let at = 0
  let line = 1
  let table = root
  let tablePath: string[] = []

  const peek = (ahead = 0): string => text[at + ahead] ?? ''
  const fail = (why: string): never => {
    throw new Fault(`line ${line}: ${why}`)
  }
  const step = (): string => {
    const char = text[at++] ?? ''
    if (char === '\n') line += 1
    return char
  }
  const spaces = (): void => {
    while (peek() === ' ' || peek() === '\t') step()
  }
  /** Spaces, newlines and comments, inside an array. */
  const gaps = (): void => {
    for (;;) {
      spaces()
      if (peek() === '#') while (at < text.length && peek() !== '\n') step()
      else if (peek() === '\n' || (peek() === '\r' && peek(1) === '\n')) step()
      else return
    }
  }
  const endOfLine = (): void => {
    spaces()
    if (peek() === '#') while (at < text.length && peek() !== '\n') step()
    if (peek() === '\r') step()
    if (at < text.length && peek() !== '\n') fail(`expected the end of the line, found ${JSON.stringify(text.slice(at, text.indexOf('\n', at) === -1 ? undefined : text.indexOf('\n', at)).trim())}`)
    if (peek() === '\n') step()
  }

  const escaped = (): string => {
    const char = step()
    const simple: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' }

    if (char in simple) return simple[char] ?? ''
    if (char === 'u' || char === 'U') {
      const hex = text.slice(at, at + (char === 'u' ? 4 : 8))
      if (!/^[0-9A-Fa-f]+$/.test(hex) || hex.length !== (char === 'u' ? 4 : 8)) fail(`\\${char} wants ${char === 'u' ? 4 : 8} hex digits`)
      at += hex.length
      return String.fromCodePoint(Number.parseInt(hex, 16))
    }
    return fail(`\\${char} is no escape TOML knows`)
  }

  const string = (): string => {
    const quote = peek()
    const isMulti = text.startsWith(quote.repeat(3), at)
    const isLiteral = quote === "'"
    let out = ''

    at += isMulti ? 3 : 1
    // A newline right after the opening quotes of a multi-line string is not part of it
    if (isMulti && peek() === '\n') step()
    else if (isMulti && peek() === '\r' && peek(1) === '\n') (step(), step())

    for (;;) {
      if (at >= text.length) fail('a string is not closed')
      if (isMulti && text.startsWith(quote.repeat(3), at)) {
        at += 3
        return out
      }
      const char = peek()
      if (!isMulti && char === quote) {
        step()
        return out
      }
      if (!isMulti && char === '\n') fail('a string is not closed on its line')
      if (!isLiteral && char === '\\') {
        step()
        // A backslash at the end of a line in a multi-line string eats the line's end and what space follows
        if (isMulti && /[\s]/.test(peek())) {
          while (/\s/.test(peek())) step()
          continue
        }
        out += escaped()
        continue
      }
      out += step()
    }
  }

  const key = (): string[] => {
    const parts: string[] = []

    for (;;) {
      spaces()
      if (peek() === '"' || peek() === "'") parts.push(string())
      else {
        let bare = ''
        while (BARE.test(peek())) bare += step()
        if (bare === '') fail(`expected a key, found ${JSON.stringify(peek() || 'the end')}`)
        parts.push(bare)
      }
      spaces()
      if (peek() !== '.') return parts
      step()
    }
  }

  const value = (): TomlValue => {
    const char = peek()

    if (char === '"' || char === "'") return string()
    if (char === '[') {
      step()
      const items: TomlValue[] = []
      for (;;) {
        gaps()
        if (peek() === ']') {
          step()
          return items
        }
        items.push(value())
        gaps()
        if (peek() === ',') step()
        else if (peek() !== ']') fail(`expected , or ] in an array, found ${JSON.stringify(peek() || 'the end')}`)
      }
    }
    if (char === '{') {
      step()
      const inline: TomlTable = {}
      spaces()
      if (peek() === '}') {
        step()
        return inline
      }
      for (;;) {
        const path = key()
        if (peek() !== '=') fail(`expected = after ${path.join('.')}`)
        step()
        spaces()
        set(inline, path, value(), [])
        spaces()
        if (peek() === ',') step()
        else if (peek() === '}') {
          step()
          return inline
        } else fail(`expected , or } in an inline table, found ${JSON.stringify(peek() || 'the end')}`)
      }
    }
    const word = /^[^\s,\]}#]+/.exec(text.slice(at))?.[0] ?? ''

    at += word.length
    if (word === 'true') return true
    if (word === 'false') return false
    if (/^[+-]?(0|[1-9](_?\d)*)$/.test(word)) return Number(word.replaceAll('_', ''))
    if (/^[+-]?(0|[1-9](_?\d)*)(\.\d(_?\d)*)?([eE][+-]?\d+)?$/.test(word)) return Number(word.replaceAll('_', ''))
    if (/^\d{4}-\d\d-\d\d/.test(word)) return fail('dates are not read here: write it as a string')
    return fail(word === '' ? 'expected a value' : `${JSON.stringify(word)} is not a value: a string is written in quotes`)
  }

  function set(into: TomlTable, path: readonly string[], given: TomlValue, prefix: readonly string[]): void {
    let place = into

    for (const [index, part] of path.entries()) {
      const full = [...prefix, ...path.slice(0, index + 1)].join('.')

      if (index === path.length - 1) {
        if (part in place) fail(`${full} is set twice`)
        place[part] = given
        lineOf.set(full, line)
        return
      }
      const next = place[part]
      if (next === undefined) place[part] = {}
      else if (!isTable(next)) fail(`${full} is a value, not a table`)
      place = place[part] as TomlTable
    }
  }

  while (at < text.length) {
    const start = at

    try {
      gaps()
      if (at >= text.length) break
      if (peek() === '[') {
        step()
        if (peek() === '[') fail('arrays of tables ([[…]]) are not read here')
        const path = key()
        if (peek() !== ']') fail('a table header is not closed with ]')
        step()
        const named = path.join('.')
        if (headed.has(named)) fail(`the table [${named}] is made twice`)
        headed.add(named)
        lineOf.set(named, line)
        endOfLine()
        let place = root
        for (const part of path) {
          const next = place[part]
          if (next === undefined) place[part] = {}
          else if (!isTable(next)) fail(`${named} is a value, not a table`)
          place = place[part] as TomlTable
        }
        table = place
        tablePath = path
        continue
      }
      const path = key()
      if (peek() !== '=') fail(`expected = after ${path.join('.')}`)
      step()
      spaces()
      const startLine = line
      const given = value()
      const endLine = line
      line = startLine
      set(table, path, given, tablePath)
      line = endLine
      endOfLine()
    } catch (error) {
      if (!(error instanceof Fault)) throw error
      errors.push(error.message)
      // Skip what is left of the line the error is on, and go on with the next
      if (at === start) step()
      while (at < text.length && peek() !== '\n') step()
    }
  }

  return { value: root, errors, lineOf }
}

/** A string TOML reads back as the same text: basic, with what must be escaped escaped. */
export const tomlString = (text: string): string => JSON.stringify(text)

/** A string as a literal one where it can be (no single quote, no newline), so backslashes stay as written. */
export const tomlLiteral = (text: string): string => (text.includes("'") || text.includes('\n') ? tomlString(text) : `'${text}'`)
