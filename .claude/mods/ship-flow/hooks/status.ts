import { BUDGET_WINDOW } from './budget'
import { blockLines } from './radius'
import type { Reading } from './radius'
import type { RunRecord } from './run'
import { frontier, label, problemsOf } from './tickets'
import type { Problem, Ticket } from './tickets'

/** One feature's ticket folder as read: the tickets of `.scratch/<feature>/issues/`, and its run record if any. */
export type Folder = { feature: string; tickets: readonly Ticket[]; record?: RunRecord }

const NOTES: Readonly<Record<string, string>> = {
  blocked: 'fix its ticket file, set it back to ready',
  'too-large': 'too large for one context window: split it into smaller tickets',
}

const HANGING = 'waits on a ticket that was not built: ready again at the next /ship resume'

/** A problem of a ticket folder as one line: the ticket, or the file, and what is wrong with it. */
export const problemText = (problem: Problem): string =>
  `${problem.number !== undefined ? label(problem.number) : problem.file} ${problem.reason}`

const problemLine = (problem: Problem): string => `  ${problemText(problem)}`

/** Where a run stands, in a few words: what it builds now, or why it does not build. Empty for a folder with no run. */
export const standingOf = (record: RunRecord | undefined): string => {
  if (!record) return ''
  if (record.phase === 'attended') {
    return record.isAuto
      ? 'an auto run, before the checkpoint: it approves itself once its tickets are written'
      : 'with you, before the checkpoint: /ship resume approves it'
  }
  if (record.phase === 'unattended') {
    return ['building', ...(record.flights?.length ? [record.flights.map(flight => label(flight.ticket)).join(', ')] : [])].join(' ')
  }
  if (record.phase === 'finishing') {
    return record.stage === 'follow' ? 'following up its pull request' : record.stage === 'fix' ? 'fixing what the review found' : 'reviewing the branch'
  }

  return `${record.phase}${record.pause !== undefined ? `: ${record.pause}` : ''}`
}

// The same, as the end of the feature's line
const standing = (record: RunRecord | undefined): string => (record ? ` · ${standingOf(record)}` : '')

/** What is worth saying of one ticket beside its state: its blockers, its model, its attempt, its context, its failure. */
export const notesOf = (ticket: Ticket, takeable: ReadonlySet<Ticket>, record: RunRecord | undefined): string[] => {
  const attempts = record?.attempts[label(ticket.number ?? 0)] ?? 0
  const peak = record?.peak?.[label(ticket.number ?? 0)]
  const failure = ticket.status !== 'done' ? record?.failures?.[label(ticket.number ?? 0)] : undefined
  // Blocked for what it hangs off, not for a failure of its own: the run takes it again by itself
  const isHanging = ticket.status === 'blocked' && record?.hangs?.includes(label(ticket.number ?? 0)) === true
  const unticked = ticket.status === 'done' ? ticket.criteria.filter(criterion => !criterion.isDone).length : 0

  return [
    ticket.blockers.length > 0 ? `blocked by ${ticket.blockers.map(label).join(', ')}` : '',
    ticket.model !== undefined ? `model ${ticket.model}` : '',
    attempts > 1 ? `attempt ${attempts}` : '',
    peak !== undefined ? `context ${Math.round((peak / BUDGET_WINDOW) * 100)}%` : '',
    failure ? `failed: ${failure.reason}` : '',
    unticked > 0 ? `${unticked} of ${ticket.criteria.length} criteria left unticked` : '',
    takeable.has(ticket) ? 'takeable now' : isHanging ? HANGING : (NOTES[ticket.status ?? ''] ?? ''),
  ].filter(note => note !== '')
}

const ticketLine = (
  ticket: Ticket,
  takeable: ReadonlySet<Ticket>,
  widths: { status: number; title: number },
  record: RunRecord | undefined,
): string => {
  const notes = notesOf(ticket, takeable, record)

  return [
    '',
    ticket.number !== undefined ? label(ticket.number) : '??',
    (ticket.status ?? '?').padEnd(widths.status),
    notes.length > 0 ? ticket.title.padEnd(widths.title) : ticket.title,
    notes.join(' · '),
  ]
    .join('  ')
    .trimEnd()
}

/** What `/ship status` says about one feature: its problems when the graph is broken, else each ticket. */
export const folderText = ({ feature, tickets, record }: Folder, reading?: Reading): string => {
  const problems = problemsOf(tickets)

  if (problems.length > 0) {
    return [`${feature}: the ticket folder cannot be run`, ...problems.map(problemLine)].join('\n')
  }
  if (tickets.length === 0) return `${feature}: no tickets yet${standing(record)}`

  const takeable = new Set(frontier(tickets))
  const done = tickets.filter(ticket => ticket.status === 'done').length
  const widths = {
    status: Math.max(...tickets.map(ticket => (ticket.status ?? '?').length)),
    title: Math.max(...tickets.map(ticket => ticket.title.length)),
  }

  return [
    `${feature}: ${done} of ${tickets.length} tickets done, ${takeable.size} takeable now${standing(record)}`,
    ...[...tickets]
      .sort((a, b) => (a.number ?? 0) - (b.number ?? 0))
      .map(ticket => ticketLine(ticket, takeable, widths, record)),
    // The estimate stays until the run ends: a pull request then holds the real answer
    ...(record?.phase !== 'ended' ? blockLines(tickets, reading).map(line => `  ${line}`) : []),
  ].join('\n')
}

/** Whether any run that has not ended declares what it touches: only then is the repo worth reading. */
export const needsReading = (folders: readonly Folder[]): boolean =>
  folders.some(folder => folder.record?.phase !== 'ended' && folder.tickets.some(ticket => ticket.touches !== undefined))

/** What `/ship status` says for a repo: every feature's folder, or that there is no run. */
export const statusText = (folders: readonly Folder[], reading?: Reading): string =>
  folders.length === 0
    ? 'No run in this repo: there is no .scratch/<feature>/issues folder. Start one with /ship <idea | #issue>.'
    : folders.map(folder => folderText(folder, reading)).join('\n\n')
