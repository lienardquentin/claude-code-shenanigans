import type { TimelineLane, TimelineSpan } from '../types'

/** The lane of the main conversation: its turns and the tools it called. */
export const MAIN = 'main'

/** What a cell or a row says about itself, as the kit's parts name their theme colors. */
export type Tone = 'neutral' | 'accent' | 'info' | 'success' | 'warning' | 'danger'

/** The periods the pane can be limited to: everything recorded, the latest turn, or the last minutes. */
export const RANGES = ['all', 'turn', '5m', '15m', '1h'] as const

export type Range = (typeof RANGES)[number]

export const RANGE_LABELS: Readonly<Record<Range, string>> = {
  all: 'whole session',
  turn: 'latest turn',
  '5m': 'last 5 minutes',
  '15m': 'last 15 minutes',
  '1h': 'last hour',
}

const RANGE_MS: Readonly<Partial<Record<Range, number>>> = { '5m': 300_000, '15m': 900_000, '1h': 3_600_000 }

export const isRange = (value: string): value is Range => (RANGES as readonly string[]).includes(value)

/** The kinds of work a tool call is drawn as, each in a tone of its own. */
export const KINDS = [
  { label: 'reads', tone: 'info', tools: ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'ToolSearch'] },
  { label: 'edits', tone: 'warning', tools: ['Edit', 'Write', 'NotebookEdit'] },
  { label: 'shell', tone: 'accent', tools: ['Bash', 'PowerShell'] },
  { label: 'agents', tone: 'success', tools: ['Agent', 'SendMessage', 'Workflow'] },
] as const satisfies readonly { label: string; tone: Tone; tools: readonly string[] }[]

/** The tone a span is drawn in: a failure first, then its kind of work; any other tool is neutral. */
export const toneOf = (span: TimelineSpan): Tone => {
  if (span.failed === true) return 'danger'

  return KINDS.find(kind => (kind.tools as readonly string[]).includes(span.name))?.tone ?? 'neutral'
}

const TARGET_FIELDS = ['command', 'file_path', 'notebook_path', 'pattern', 'url', 'query', 'description', 'skill', 'prompt']
const TARGET_LENGTH = 120

/** What a tool call worked on, in one line: its command, its file, its pattern, whichever it has. */
export const targetOf = (input: Readonly<Record<string, unknown>>): string => {
  const found = TARGET_FIELDS.map(field => input[field]).find(value => typeof value === 'string' && value.trim() !== '')

  return typeof found === 'string' ? found.trim().replace(/\s+/g, ' ').slice(0, TARGET_LENGTH) : ''
}

const two = (value: number): string => String(value).padStart(2, '0')

/** A moment as the wall clock's `HH:MM:SS`. */
export const clockOf = (ms: number): string => {
  const date = new Date(ms)

  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`
}

/** A length of time as a person reads it: `850ms`, `12.3s`, `4m 05s`, `1h 12m`. */
export const lengthOf = (ms: number): string => {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`

  const seconds = Math.round(ms / 1000)
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${two(seconds % 60)}s`

  return `${Math.floor(seconds / 3600)}h ${two(Math.floor((seconds % 3600) / 60))}m`
}

/** The stretch of time a drawing covers. */
export type Period = { from: number; to: number }

const endOf = (span: { start: number; end?: number }, now: number): number => Math.max(span.end ?? now, span.start + 1)

/**
 * The period a range covers: the latest turn of the main conversation, the last minutes up to now, or everything
 * recorded (up to now while something still runs). Undefined when nothing was recorded.
 */
export const periodOf = (
  spans: readonly TimelineSpan[],
  lanes: readonly TimelineLane[],
  range: Range,
  now: number,
): Period | undefined => {
  if (spans.length === 0 && lanes.length === 0) return undefined

  const minutes = RANGE_MS[range]
  if (minutes !== undefined) return { from: now - minutes, to: now }

  if (range === 'turn') {
    const turn = spans.filter(span => span.kind === 'turn').reduce<TimelineSpan | undefined>(
      (latest, span) => (latest === undefined || span.start >= latest.start ? span : latest),
      undefined,
    )
    if (turn !== undefined) return { from: turn.start, to: endOf(turn, now) }
  }

  const all = [...spans, ...lanes]

  return { from: Math.min(...all.map(one => one.start)), to: Math.max(...all.map(one => endOf(one, now))) }
}

const overlaps = (one: { start: number; end?: number }, period: Period, now: number): boolean =>
  one.start < period.to && endOf(one, now) > period.from

/** The spans of a lane that fall in a period, the most recent first. */
export const spansIn = (spans: readonly TimelineSpan[], lane: string, period: Period, now: number): TimelineSpan[] =>
  spans.filter(span => span.lane === lane && overlaps(span, period, now)).sort((a, b) => b.start - a.start)

/**
 * The lanes a period shows, the main conversation first and then each subagent by when it started. A subagent
 * that did nothing in the period is left out.
 */
export const lanesIn = (
  spans: readonly TimelineSpan[],
  lanes: readonly TimelineLane[],
  period: Period,
  now: number,
): TimelineLane[] => [
  { id: MAIN, label: 'main', start: period.from },
  ...lanes.filter(lane => lane.id !== MAIN && overlaps(lane, period, now)).sort((a, b) => a.start - b.start),
]

export const BUSY = '█'
export const ALIVE = '░'
export const QUIET = '·'

/** A stretch of one row drawn alike: the cells' glyphs, and their tone. */
export type Run = { text: string; tone: Tone }

/**
 * One lane as a row of `columns` cells over a period. A cell a tool call ran in is filled, in the tone of the call
 * that held most of it (a failed call wins, so a failure is never painted over); a cell where the lane was at work
 * with no tool running (the model thinking or writing) is shaded; any other cell is a dot.
 */
export const rowOf = (
  lane: TimelineLane,
  spans: readonly TimelineSpan[],
  period: Period,
  columns: number,
  now: number,
): Run[] => {
  const step = (period.to - period.from) / columns
  const cells: { held: number; tone?: Tone; alive: boolean }[] = Array.from({ length: columns }, () => ({ held: 0, alive: false }))

  // Each span paints only the cells it reaches
  const paint = (one: { start: number; end?: number }, mark: (cell: (typeof cells)[number], held: number) => void): void => {
    const start = Math.max(one.start, period.from)
    const end = Math.min(endOf(one, now), period.to)
    if (end <= start) return

    const last = Math.min(columns - 1, Math.ceil((end - period.from) / step) - 1)
    for (let index = Math.max(0, Math.floor((start - period.from) / step)); index <= last; index += 1) {
      const cell = cells[index]
      const from = period.from + index * step
      if (cell !== undefined) mark(cell, Math.min(end, from + step) - Math.max(start, from))
    }
  }

  if (lane.id !== MAIN) paint(lane, cell => void (cell.alive = true))

  for (const span of spans) {
    if (span.lane !== lane.id) continue
    if (span.kind === 'turn') {
      paint(span, cell => void (cell.alive = true))
      continue
    }

    const tone = toneOf(span)
    paint(span, (cell, held) => {
      if (cell.tone === 'danger' && tone !== 'danger') return
      if (cell.tone === undefined || held > cell.held || (tone === 'danger' && cell.tone !== 'danger')) {
        cell.held = held
        cell.tone = tone
      }
    })
  }

  return cells.reduce<Run[]>((runs, cell) => {
    const text = cell.tone !== undefined ? BUSY : cell.alive ? ALIVE : QUIET
    const tone = cell.tone ?? 'neutral'
    const last = runs[runs.length - 1]

    if (last !== undefined && last.tone === tone) last.text += text
    else runs.push({ text, tone })

    return runs
  }, [])
}

/** How long a lane's tool calls ran in all, each counted whole. */
export const busyOf = (spans: readonly TimelineSpan[], now: number): number =>
  spans.filter(span => span.kind === 'tool').reduce((total, span) => total + (endOf(span, now) - span.start), 0)
