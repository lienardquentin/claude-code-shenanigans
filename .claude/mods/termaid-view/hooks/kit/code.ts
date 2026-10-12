// @ui-kit
// ui-kit part: code. Copy this file to a mod's `hooks/kit/code.ts`, then `import { code } from './kit/code'`.
// Self-contained: its only import is a type. Pair it with the `json` or `yaml` part to make the source.
import type { RenderElement } from 'claude-code'

// What `Code` allows in its source: tab and newline are its only control characters. A carriage return (a Windows
// command's output) or an escape (a progress meter's) is taken out.
const clean = (source: string): string =>
  // eslint-disable-next-line no-control-regex
  source.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')

// A line's leading spaces and tabs as no-break spaces, so a surface that folds whitespace keeps the indentation
const keepIndent = (line: string): string =>
  line.replace(/^[ \t]+/, lead => '\u00A0'.repeat(lead.replace(/\t/g, '  ').length))

// A run of a line, in a theme color or, with none, the text's own
type Span = { text: string; color?: string }

const KEY = 'suggestion'
const STRING = 'success'
const NUMBER = 'warning'
const KEYWORD = 'claude'

// One JSON line as runs: keys, strings, numbers and true/false/null in their own colors, the punctuation as it is
const jsonSpans = (line: string): Span[] => {
  const spans: Span[] = []
  const token = /("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b/g
  let from = 0

  for (const match of line.matchAll(token)) {
    const at = match.index ?? 0
    if (at > from) spans.push({ text: line.slice(from, at) })

    if (match[1] !== undefined) {
      spans.push({ text: match[1], color: match[2] === undefined ? STRING : KEY })
      if (match[2] !== undefined) spans.push({ text: match[2] })
    } else if (match[3] !== undefined) spans.push({ text: match[3], color: NUMBER })
    else spans.push({ text: match[4] ?? '', color: KEYWORD })

    from = at + match[0].length
  }

  if (from < line.length) spans.push({ text: line.slice(from) })

  return spans
}

// One YAML line as runs: the key before the colon, then its value as a JSON scalar is
const yamlSpans = (line: string): Span[] => {
  const pair = /^(\s*(?:-\s+)?)([^\s:#][^:#]*?)(:)(\s+.*|)$/.exec(line)
  if (pair === null) return jsonSpans(line)

  return [
    { text: pair[1] ?? '' },
    { text: pair[2] ?? '', color: KEY },
    { text: pair[3] ?? '' },
    ...jsonSpans(pair[4] ?? ''),
  ]
}

const spansOf = (line: string, language: string | undefined): Span[] =>
  language === 'json' ? jsonSpans(line) : language === 'yaml' || language === 'yml' ? yamlSpans(line) : [{ text: line }]

/**
 * A block of code or data, highlighted for its language (`json`, `yaml`, ...); no language draws plain text.
 * `Code` is a leaf: the element carries no `children` key, not even an empty one.
 *
 * `plain` draws the text as a column of `Text` lines instead, for a surface that does not draw `Code` (pass
 * `e.surface !== 'terminal'`): indentation is kept, long lines wrap, and `json` and `yaml` are colored by token in
 * theme colors (keys, strings, numbers, true/false/null).
 *
 * `path` names the file the source is from, for its language when none is given (nothing is read). `startLine`
 * numbers the lines from it, in a gutter. `diff` reads the source as unified-diff hunks, drawn with their own
 * numbers and the added and removed lines colored. `plain` draws none of the three.
 */
export const code = ({
  source,
  language,
  path,
  startLine,
  diff = false,
  plain = false,
}: {
  source: string
  language?: string
  path?: string
  startLine?: number
  diff?: boolean
  plain?: boolean
}): RenderElement => {
  const text = clean(source)

  if (plain) {
    return {
      type: 'Box',
      props: { flexDirection: 'column' },
      children: text.split('\n').map(line => ({
        type: 'Text',
        props: { wrap: 'wrap' },
        children:
          line === ''
            ? ['\u00A0']
            : spansOf(keepIndent(line), language).map(span =>
                span.color === undefined
                  ? span.text
                  : { type: 'Text', props: { color: span.color }, children: [span.text] },
              ),
      })),
    } as unknown as RenderElement
  }

  return {
    type: 'Code',
    props: {
      source: text,
      ...(language !== undefined ? { language } : {}),
      ...(path !== undefined ? { path } : {}),
      ...(startLine !== undefined ? { startLine } : {}),
      ...(diff ? { format: 'diff' } : {}),
    },
  } as unknown as RenderElement
}
