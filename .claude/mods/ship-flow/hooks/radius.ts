import { label } from './tickets'
import type { Ticket } from './tickets'

/** What a ticket's reach says when it declared nothing, and the mark beside a ticket that has outward actions. */
export const NOT_DECLARED = 'not declared'
export const OUTWARD_MARK = '▲'

/** One ticket's blast radius: the files it declares inside the repo, and its outward actions in full. */
export type TicketRadius = {
  number?: number
  /** Whether the ticket declared its `Touches:` at all. */
  isDeclared: boolean
  files: readonly string[]
  outward: readonly string[]
}

/** A path that leaves the repo: absolute, starting with `~`, or climbing out with `..`. */
export const isOutside = (path: string): boolean =>
  /^([/\\]|~|[A-Za-z]:)/.test(path) || path.split(/[/\\]/).includes('..')

/** A ticket's radius from what it declares. A touched path outside the repo is an outward action, not a file. */
export const radiusOf = (ticket: Ticket): TicketRadius => {
  const touched = ticket.touches ?? []

  return {
    ...(ticket.number !== undefined ? { number: ticket.number } : {}),
    isDeclared: ticket.touches !== undefined,
    files: [...new Set(touched.filter(path => !isOutside(path)))],
    outward: [...touched.filter(isOutside).map(path => `changes \`${path}\` outside the repo`), ...(ticket.outward ?? [])],
  }
}

const filesOf = (count: number): string => `${count} ${count === 1 ? 'file' : 'files'}`

/** A ticket's reach as one cell or phrase: how many files it declares, or that it declared none. */
export const reachText = (radius: TicketRadius): string => (radius.isDeclared ? filesOf(radius.files.length) : NOT_DECLARED)

/** A ticket's reach, and the mark when it has outward actions: what its row says. */
export const rowText = (radius: TicketRadius): string =>
  radius.outward.length > 0 ? `${reachText(radius)} ${OUTWARD_MARK}` : reachText(radius)

/** The run's radius: its files, each counted once, and every outward action by ticket. */
export type RunRadius = {
  isDeclared: boolean
  files: readonly string[]
  outward: readonly { number?: number; action: string }[]
}

export const runRadiusOf = (tickets: readonly Ticket[]): RunRadius => {
  const radii = [...tickets].sort((a, b) => (a.number ?? 0) - (b.number ?? 0)).map(radiusOf)

  return {
    isDeclared: radii.some(radius => radius.isDeclared),
    files: [...new Set(radii.flatMap(radius => radius.files))],
    outward: radii.flatMap(radius =>
      radius.outward.map(action => ({ ...(radius.number !== undefined ? { number: radius.number } : {}), action })),
    ),
  }
}

/** The run's block of lines: its totals, then every outward action in full, by ticket number. */
export const blockOf = (tickets: readonly Ticket[]): { totals: string; outward: string[] } => {
  const run = runRadiusOf(tickets)

  return {
    totals: `Blast radius (an estimate): ${run.isDeclared ? filesOf(run.files.length) : NOT_DECLARED}`,
    outward: run.outward.map(({ number, action }) => `${number !== undefined ? label(number) : '??'} ${action}`),
  }
}
