import type { History, Line, Usage } from '../types'
import { clockTime, isNoise, requestIds, signatureOf, traceLines } from './lines'
import type { Labelled } from './report'

// What the timeline is made readable with: one request followed across the apps, the lines nobody reads folded
// away, and the last figures of an app as a line. Values in, values out.

/** The lines that name a request id, oldest first. */
export const traceOf = (everything: readonly Labelled[], id: string): Labelled[] => (id === '' ? [] : everything.filter(({ line }) => requestIds(line.message).includes(id)))

const msText = (ms: number): string => (ms >= 10_000 ? `${Math.round(ms / 1000)}s` : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.max(0, Math.round(ms))}ms`)

/** How long after the first line of a request a line was written: `+12ms`. */
export const offsetText = (at: number, from: number): string => `+${msText(at - from)}`

/** A request in a line: how many lines name it, the apps it went through in the order each first wrote, and how long from its first line to its last. */
export const traceSummary = (id: string, traced: readonly Labelled[]): string => {
  const [first] = traced
  const last = traced[traced.length - 1]

  if (first === undefined || last === undefined) return `No line held names the request ${id}: it was written before the lines kept, or it goes by another name.`

  const apps = [...new Set(traced.map(({ label }) => label))]
  // Each app's part of it: from the first line it wrote of the request to the last
  const hops = apps.map(label => {
    const own = traced.filter(entry => entry.label === label)
    const from = own[0]?.line.at ?? first.line.at
    const to = own[own.length - 1]?.line.at ?? from

    return `${label} ${offsetText(from, first.line.at)}${to > from ? ` for ${msText(to - from)}` : ''}`
  })
  const errors = traced.filter(({ line }) => line.level === 'error').length

  return `request ${id}: ${traced.length} line${traced.length === 1 ? '' : 's'} through ${hops.join(' → ')}, ${msText(last.line.at - first.line.at)} from the first to the last${errors === 0 ? '' : `, ${errors} of them ${errors === 1 ? 'an error' : 'errors'}`}`
}

const MAX_TRACED = 80

/** A request as text, for the model: its summary, then each line with how long after the first it was written. */
export const traceText = (id: string, traced: readonly Labelled[]): string => {
  const from = traced[0]?.line.at ?? 0

  return [
    traceSummary(id, traced),
    ...traced.slice(-MAX_TRACED).flatMap(({ label, line }) => [`  ${offsetText(line.at, from).padEnd(8)} ${clockTime(line.at)} [${label}] ${line.level.toUpperCase().padEnd(5)} ${line.message}`, ...traceLines(line.trace, '             ')]),
  ].join('\n')
}

export type Row = Labelled & { times: number }

/**
 * The timeline as it is drawn: the health checks left out and counted, and a line an app writes several times
 * running (the same but for its numbers and ids) said once with how often. An error is never left out.
 */
export const quieted = (lines: readonly Labelled[], isNoisy: boolean): { rows: Row[]; hidden: number } => {
  if (isNoisy) return { rows: lines.map(entry => ({ ...entry, times: 1 })), hidden: 0 }

  const rows: Row[] = []
  let hidden = 0

  for (const entry of lines) {
    if (isNoise(entry.line)) {
      hidden += 1
      continue
    }

    const last = rows[rows.length - 1]

    // The last of them is the one shown: it carries the latest time
    if (last !== undefined && last.label === entry.label && isRepeat(last.line, entry.line)) rows[rows.length - 1] = { ...entry, times: last.times + 1 }
    else rows.push({ ...entry, times: 1 })
  }

  return { rows, hidden }
}

// A line that names a request is one of that request's, however alike the next is
const isRepeat = (a: Line, b: Line): boolean => a.level === b.level && a.more === b.more && requestIds(a.message).length === 0 && requestIds(b.message).length === 0 && signatureOf(a.message) === signatureOf(b.message)

const BARS = '▁▂▃▄▅▆▇█'

/** How many figures a row's line draws, and a history keeps three times that. */
export const SPARK_WIDTH = 8
const MAX_HISTORY = SPARK_WIDTH * 3

/**
 * The last figures as a line of bars, the lowest of them at the foot: what holds steady is flat, what climbs
 * climbs. A figure that was not known is a gap. Empty until two are known.
 */
export const spark = (values: readonly number[], width = SPARK_WIDTH): string => {
  const last = values.slice(-width)
  const known = last.filter(value => value >= 0)

  if (known.length < 2) return ''

  const low = Math.min(...known)
  const high = Math.max(...known)
  // A figure that wavers by less than a fifth of itself is steady, not a mountain range
  const range = Math.max(high - low, high * 0.2, 1e-9)

  return last.map(value => (value < 0 ? ' ' : (BARS[Math.min(BARS.length - 1, Math.round(((value - low) / range) * (BARS.length - 1)))] ?? ' '))).join('')
}

export const EMPTY_HISTORY: History = { cpu: [], memory: [], lag: [] }

/** The history once the figures of a read are added to it; `lag` is -1 for what is no broker. */
export const recorded = (history: History | undefined, usage: Usage | undefined, lag: number): History => {
  const { cpu, memory, lag: lags } = history ?? EMPTY_HISTORY

  return {
    cpu: usage === undefined ? cpu : [...cpu, usage.note === '' ? usage.cpu : -1].slice(-MAX_HISTORY),
    memory: usage === undefined ? memory : [...memory, usage.note === '' ? usage.memory : -1].slice(-MAX_HISTORY),
    lag: lag < 0 ? lags : [...lags, lag].slice(-MAX_HISTORY),
  }
}

/** Whether the last figures climbed without ever coming down: memory that only grows, a lag that only deepens. */
export const isClimbing = (values: readonly number[], width = SPARK_WIDTH): boolean => {
  const known = values.slice(-width).filter(value => value >= 0)
  const [first = 0] = known
  const last = known[known.length - 1] ?? 0

  return known.length >= SPARK_WIDTH && known.every((value, index) => index === 0 || value >= (known[index - 1] ?? 0)) && last > first * 1.1 && last > first
}

// The theme's colors that say nothing by themselves: an app keeps one, so its lines are told from another's at a glance
const TAG_COLORS = ['suggestion', 'merged', 'planMode', 'autoAccept', 'ide', 'remember', 'permission'] as const

/** The color an app's name is drawn in on the timeline, by its place among what is watched. */
export const tagColor = (index: number): string => TAG_COLORS[((index % TAG_COLORS.length) + TAG_COLORS.length) % TAG_COLORS.length] ?? 'suggestion'
