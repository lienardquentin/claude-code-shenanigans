import type { RunRecord } from './run'
import { frontier, label, problemsOf } from './tickets'
import type { Problem, Ticket } from './tickets'

/** One feature's ticket folder as read: the tickets of `.scratch/<feature>/issues/`, and its run record if any. */
export type Folder = { feature: string; tickets: readonly Ticket[]; record?: RunRecord }

const NOTES: Readonly<Record<string, string>> = {
  blocked: 'fix its ticket file, set it back to ready',
  'too-large': 'too large for one context window: split it into smaller tickets',
}

const problemLine = (problem: Problem): string =>
  `  ${problem.number !== undefined ? label(problem.number) : problem.file} ${problem.reason}`

// Where the run stands, as the end of the feature's line: what it builds now, or why it does not build
const standing = (record: RunRecord | undefined): string => {
  if (!record) return ''
  if (record.phase === 'unattended') return ` · building ${label(record.ticket ?? 0)}`

  return ` · ${record.phase}${record.pause !== undefined ? `: ${record.pause}` : ''}`
}

const ticketLine = (
  ticket: Ticket,
  takeable: ReadonlySet<Ticket>,
  widths: { status: number; title: number },
  record: RunRecord | undefined,
): string => {
  const attempts = record?.attempts[label(ticket.number ?? 0)] ?? 0
  const failure = record?.failure?.ticket === ticket.number && ticket.status !== 'done' ? record?.failure : undefined
  const notes = [
    ticket.blockers.length > 0 ? `blocked by ${ticket.blockers.map(label).join(', ')}` : '',
    ticket.model !== undefined ? `model ${ticket.model}` : '',
    attempts > 1 ? `attempt ${attempts}` : '',
    failure ? `failed: ${failure.reason}` : '',
    takeable.has(ticket) ? 'takeable now' : (NOTES[ticket.status ?? ''] ?? ''),
  ].filter(note => note !== '')

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
export const folderText = ({ feature, tickets, record }: Folder): string => {
  const problems = problemsOf(tickets)

  if (problems.length > 0) {
    return [`${feature}: the ticket folder cannot be run`, ...problems.map(problemLine)].join('\n')
  }
  if (tickets.length === 0) return `${feature}: no tickets yet`

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
  ].join('\n')
}

/** What `/ship status` says for a repo: every feature's folder, or that there is no run. */
export const statusText = (folders: readonly Folder[]): string =>
  folders.length === 0
    ? 'No run in this repo: there is no .scratch/<feature>/issues folder. Start one with /ship <idea | #issue>.'
    : folders.map(folderText).join('\n\n')
