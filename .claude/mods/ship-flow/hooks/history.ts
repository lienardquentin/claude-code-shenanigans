import { BUDGET_WINDOW } from './budget'
import type { Folder } from './status'
import { label, outsideOf } from './tickets'

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)

  return sorted.length % 2 === 1 ? (sorted[middle] ?? 0) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
}

/**
 * What the runs this repo has had say about the size of a ticket, as one sentence for whoever writes the next
 * tickets: how full their implementers got, how long they took, how many were stopped as too large, and how far
 * their `Touches:` were from what they changed. Undefined while no run has built a ticket.
 */
export const historyOf = (folders: readonly Folder[]): string | undefined => {
  const peaks = folders.flatMap(({ record }) => Object.values(record?.peak ?? {})).map(tokens => Math.round((tokens / BUDGET_WINDOW) * 100))

  if (peaks.length === 0) return undefined

  const minutes = folders.flatMap(({ record }) => Object.values(record?.took ?? {})).map(ms => ms / 60_000)
  const tooLarge = folders.flatMap(({ tickets }) => tickets).filter(ticket => ticket.status === 'too-large').length
  const estimates = folders.flatMap(({ tickets, record }) =>
    tickets.flatMap(ticket => {
      const changed = record?.actual?.[label(ticket.number ?? 0)]

      return changed?.length && ticket.touches?.length ? [{ changed: changed.length, outside: outsideOf(ticket, changed).length }] : []
    }),
  )
  const changed = estimates.reduce((sum, estimate) => sum + estimate.changed, 0)
  const outside = estimates.reduce((sum, estimate) => sum + estimate.outside, 0)

  return [
    `Over ${peaks.length} ${peaks.length === 1 ? 'ticket' : 'tickets'} built here, an implementer filled ${Math.round(median(peaks))}% of a context window at its fullest (the most: ${Math.max(...peaks)}%)`,
    ...(minutes.length > 0 ? [`a ticket took ${Math.max(1, Math.round(median(minutes)))} min`] : []),
    `${tooLarge} ${tooLarge === 1 ? 'was' : 'were'} stopped as too large`,
    ...(changed > 0 ? [`${Math.round((outside / changed) * 100)}% of the files they changed were outside their Touches`] : []),
  ].join('; ')
}
