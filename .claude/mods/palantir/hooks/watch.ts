import type { Attachment, Cursor, Health, RuntimeId, Watch } from '../types'
import { absorb, EMPTY_WATCH, fresh, split } from './lines'

// What a read of an attachment comes to: the lines past the cursor, and the watches once they have taken them in.
// Values in, values out: the module that holds the engine runs the commands and keeps the state.

// How many lines the first read of an attachment goes back
export const TAIL = 200

export const firstLine = (text: string): string => (text.trim().split('\n')[0] ?? '').slice(0, 160)

export type Taken = { raws: string[]; cursor: Cursor; error: string }

/** How much of the end of a file too large to read whole is asked for, in bytes. */
export const END_BYTES = 1_000_000

/** The command that prints the end of a file too large to read whole. */
export const endArgv = (path: string): string[] => ['tail', '-c', String(END_BYTES), path]

// The offset kept when only the end of a file was read: where the next read starts is then told by the last line
const UNKNOWN = Number.MAX_SAFE_INTEGER

/**
 * A file's new lines, complete lines only: taken from where the last read stopped. A file shorter than what was
 * read was cut back or emptied, and of one too large to read whole only the end is here (`isEndOnly`): the lines
 * are then taken from after the last line already taken, where it still stands, so that a log kept small by
 * whatever writes it is neither read twice nor missed. Where that line is gone, the last lines are taken afresh.
 */
export const takeFile = (text: string, cursor: Cursor, isEndOnly = false): Taken => {
  const to = text.lastIndexOf('\n') + 1
  const [last] = cursor.seen
  let from = cursor.offset
  let isAfresh = from === 0

  // Cut back and grown again past where the last read stopped, a file is as long as one that only grew: it is
  // told by the line that read ended on, which no longer stands there
  const isMoved = last !== undefined && from > 0 && !text.startsWith(`${last}\n`, from - last.length - 1)

  if (isEndOnly || text.length < cursor.offset || isMoved) {
    const found = last === undefined ? -1 : `\n${text.slice(0, to)}`.lastIndexOf(`\n${last}\n`)

    isAfresh = found === -1
    // An end starts in the middle of a line
    from = found === -1 ? (isEndOnly ? text.indexOf('\n') + 1 : 0) : found + (last ?? '').length + 1
  }

  const lines = to > from ? text.slice(from, to).split('\n').filter(line => line.trim() !== '') : []
  const ending = to === 0 ? '' : text.slice(text.lastIndexOf('\n', to - 2) + 1, to - 1)

  return {
    raws: isAfresh ? lines.slice(-TAIL) : lines,
    cursor: { ...cursor, offset: isEndOnly ? UNKNOWN : Math.max(from, to), seen: ending.trim() === '' ? cursor.seen : [ending] },
    error: '',
  }
}

/** The new lines among what a runtime's logs command printed, and the cursor moved to the last of them. */
export const takePrinted = (runtime: RuntimeId, printed: { stdout: string; stderr: string }, cursor: Cursor): Taken => {
  // `docker logs` hands the app's standard error over on its own: both are the app's lines, put back in order by
  // the timestamp each leads with. What the other command lines write there is their own remarks.
  const text = runtime === 'docker' ? `${printed.stdout}\n${printed.stderr}` : printed.stdout
  const all = text.split('\n').filter(line => line.trim() !== '')

  // And the pods of a workload each write their own: one timeline, by the same timestamp
  if (runtime === 'docker' || runtime === 'kubernetes') all.sort((a, b) => (split(a).stamp < split(b).stamp ? -1 : split(a).stamp > split(b).stamp ? 1 : 0))

  // The runtime hands the lines of the cursor's own instant over again, and Kubernetes, which counts in whole
  // seconds, the ones written earlier in that second: those were taken by the read before
  const raws = all.filter(raw => {
    const { stamp } = split(raw)

    return !(stamp === cursor.since && cursor.seen.includes(raw)) && !(stamp !== '' && cursor.since !== '' && stamp < cursor.since)
  })
  const since = [...all].reverse().map(raw => split(raw).stamp).find(stamp => stamp !== '') ?? cursor.since
  const seen = [...(since === cursor.since ? cursor.seen : []), ...raws.filter(raw => split(raw).stamp === since)]

  return { raws, cursor: { ...cursor, since, seen }, error: '' }
}

export type Read = Taken & { label: string; health: Health }

/**
 * The watches once each read is taken in, and what there is to tell the person: an attachment that went down,
 * and the errors that are new since the last edit routed to it, each told once.
 */
export const settle = (held: Record<string, Watch>, reads: readonly Read[], now: number): { watches: Record<string, Watch>; said: string[] } => {
  const watches = { ...held }
  const said: string[] = []

  for (const { label, raws, cursor, error, health } of reads) {
    const was = held[label] ?? EMPTY_WATCH
    // It started over: restarted, or rolled out anew. One read for the first time has nothing to start over from.
    const isRolled = (held[label] !== undefined && health.restarts > was.health.restarts) || ((was.health.started ?? '') !== '' && (health.started ?? '') !== '' && health.started !== was.health.started)
    const watch = absorb({ ...was, cursor, error, health, ...(isRolled ? { rolledAt: now } : {}) }, raws, now)
    const unsaid = fresh(watch).filter(signature => !signature.isAnnounced)

    if (health.state === 'down' && was.health.state !== 'down') said.push(`palantir: ${label} is down${health.detail === '' ? '' : ` (${health.detail})`}`)
    if (unsaid.length > 0) said.push(`palantir: ${label} has ${unsaid.length} new error${unsaid.length === 1 ? '' : 's'} since the edit to ${watch.editedPath}`)

    watches[label] = { ...watch, signatures: watch.signatures.map(signature => (unsaid.includes(signature) ? { ...signature, isAnnounced: true } : signature)) }
  }

  return { watches, said }
}

/**
 * The watches once an edit is counted against the labelled ones: an error or a chain first seen from now on is new
 * since it, and what the renders, the requests and the page's figures came to is kept, to measure from.
 */
export const marked = (held: Record<string, Watch>, labels: readonly string[], path: string, now = 0, from?: number): Record<string, Watch> => ({
  ...held,
  ...Object.fromEntries(
    labels.map(label => {
      const watch = held[label] ?? EMPTY_WATCH

      return [
        label,
        {
          ...watch,
          // An edit found after it was made (`from` is when the file was written) may already have shown what it
          // broke: an error first written since then is counted as its doing
          ...(from === undefined ? {} : { signatures: watch.signatures.map(signature => ((signature.firstAt ?? signature.lastAt) >= from ? { ...signature, edit: watch.edits + 1, isAnnounced: false, isTold: false } : signature)) }),
          edits: watch.edits + 1,
          editedPath: path,
          editedAt: now,
          renders: (watch.renders ?? []).map(render => ({ ...render, countAtEdit: render.count })),
          requests: (watch.requests ?? []).map(request => ({ ...request, countAtEdit: request.count, totalMsAtEdit: request.totalMs })),
          ...(watch.vitals === undefined ? {} : { vitalsAtEdit: watch.vitals }),
        },
      ]
    }),
  ),
})

/** The watches of the attachments there still are. */
export const kept = (held: Record<string, Watch>, attachments: readonly Attachment[]): Record<string, Watch> =>
  Object.fromEntries(attachments.flatMap(({ label }) => (held[label] === undefined ? [] : [[label, held[label]] as const])))

/** The watches once a mark is set on each: an error that first shows from now on is new since the mark. */
export const markedNow = (held: Record<string, Watch>, labels: readonly string[], now: number): Record<string, Watch> => ({
  ...held,
  ...Object.fromEntries(labels.map(label => [label, { ...(held[label] ?? EMPTY_WATCH), markedAt: now }])),
})
