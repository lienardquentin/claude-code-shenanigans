import { frontier, label, problemsOf } from './tickets'
import type { Problem, Ticket } from './tickets'

/** One feature's ticket folder as read: the tickets of `.scratch/<feature>/issues/`. */
export type Folder = { feature: string; tickets: readonly Ticket[] }

const NOTES: Readonly<Record<string, string>> = {
  blocked: 'fix its ticket file, set it back to ready',
  'too-large': 'too large for one context window: split it into smaller tickets',
}

const problemLine = (problem: Problem): string =>
  `  ${problem.number !== undefined ? label(problem.number) : problem.file} ${problem.reason}`

const ticketLine = (ticket: Ticket, takeable: ReadonlySet<Ticket>, widths: { status: number; title: number }): string => {
  const notes = [
    ticket.blockers.length > 0 ? `blocked by ${ticket.blockers.map(label).join(', ')}` : '',
    ticket.model !== undefined ? `model ${ticket.model}` : '',
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
export const folderText = ({ feature, tickets }: Folder): string => {
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
    `${feature}: ${done} of ${tickets.length} tickets done, ${takeable.size} takeable now`,
    ...[...tickets]
      .sort((a, b) => (a.number ?? 0) - (b.number ?? 0))
      .map(ticket => ticketLine(ticket, takeable, widths)),
  ].join('\n')
}

/** What `/ship status` says for a repo: every feature's folder, or that there is no run. */
export const statusText = (folders: readonly Folder[]): string =>
  folders.length === 0
    ? 'No run in this repo: there is no .scratch/<feature>/issues folder. Start one with /ship <idea | #issue>.'
    : folders.map(folderText).join('\n\n')
