/** The states a ticket's `Status:` line may hold. */
export const STATES = ['ready', 'in-progress', 'done', 'blocked', 'too-large'] as const

export type State = (typeof STATES)[number]

export type Criterion = { text: string; isDone: boolean }

/** One ticket file as read. `status` is the line's own word, checked by `problemsOf`, not here. */
export type Ticket = {
  file: string
  number?: number
  title: string
  status?: string
  blockers: readonly number[]
  model?: string
  criteria: readonly Criterion[]
}

/** What is wrong with a ticket, by its number, or by its file when it has none. */
export type Problem = { number?: number; file?: string; reason: string }

/** A ticket's number as its files and its lists spell it: two digits. */
export const label = (number: number): string => String(number).padStart(2, '0')

const field = (text: string, name: string): string | undefined =>
  new RegExp(`^\\*\\*${name}:\\*\\*[ \\t]*(.*)$`, 'm').exec(text)?.[1]?.trim()

/** Reads one ticket file. Never fails: what a file lacks is left out, for `problemsOf` to report. */
export const parseTicket = (file: string, text: string): Ticket => {
  const heading = /^#\s+(?:(\d+)\s*:\s*)?(.*)$/m.exec(text)
  const numbered = heading?.[1] ?? /^(\d+)/.exec(file)?.[1]
  const status = field(text, 'Status')
  const model = field(text, 'Model')

  return {
    file,
    ...(numbered !== undefined ? { number: Number(numbered) } : {}),
    title: heading?.[2]?.trim() ?? file,
    ...(status ? { status } : {}),
    blockers: (field(text, 'Blocked by')?.match(/\d+/g) ?? []).map(Number),
    ...(model ? { model } : {}),
    criteria: Array.from(text.matchAll(/^- \[([ xX])\]\s+(.*)$/gm), ([, mark, criterion]) => ({
      text: (criterion ?? '').trim(),
      isDone: mark !== ' ',
    })),
  }
}

/** The ticket's text with its `Status:` line saying `status`, and nothing else changed. */
export const withStatus = (text: string, status: State): string =>
  text.replace(/^(\*\*Status:\*\*)[ \t]*.*$/m, `$1 ${status}`)

const isState = (status: string | undefined): status is State => STATES.includes(status as State)

// The first cycle found walking blockers from `start`, as the numbers on it with `start` at both ends
const cycleFrom = (start: number, blockersOf: ReadonlyMap<number, readonly number[]>): number[] | undefined => {
  const walk = (at: number, path: readonly number[]): number[] | undefined => {
    for (const blocker of blockersOf.get(at) ?? []) {
      // A ticket blocked by itself is reported as that, not as a cycle of one
      if (blocker === at) continue
      if (blocker === start) return [...path, blocker]
      if (path.includes(blocker)) continue

      const found = walk(blocker, [...path, blocker])

      if (found) return found
    }

    return undefined
  }

  return walk(start, [start])
}

/**
 * Everything that makes a ticket folder unfit to run, in ticket order: a file with no number, a number two files
 * share, a missing or unknown status, a blocker that does not exist, a ticket blocked by itself, a cycle.
 */
export const problemsOf = (tickets: readonly Ticket[]): Problem[] => {
  const problems: Problem[] = []
  const numbered = tickets.filter((t): t is Ticket & { number: number } => t.number !== undefined)
  const blockersOf = new Map(numbered.map(t => [t.number, t.blockers]))
  const cycles = new Map<number, string>()

  for (const t of [...numbered].sort((a, b) => a.number - b.number)) {
    const twin = numbered.find(other => other.number === t.number && other !== t)

    if (twin) {
      if (numbered.indexOf(twin) > numbered.indexOf(t)) {
        problems.push({ number: t.number, reason: `is the number of two files: ${t.file} and ${twin.file}` })
      }
      continue
    }

    if (t.status === undefined) problems.push({ number: t.number, reason: 'has no Status line' })
    else if (!isState(t.status)) {
      problems.push({
        number: t.number,
        reason: `has the status "${t.status}", which is not one of ${STATES.join(', ')}`,
      })
    }

    for (const blocker of t.blockers) {
      if (blocker === t.number) problems.push({ number: t.number, reason: 'is blocked by itself' })
      else if (!blockersOf.has(blocker)) {
        problems.push({ number: t.number, reason: `is blocked by ${label(blocker)}, which does not exist` })
      }
    }

    // A cycle is named once, from its lowest ticket, and that name is given to each ticket on it
    if (!cycles.has(t.number)) {
      const cycle = cycleFrom(t.number, blockersOf)

      if (cycle) for (const on of cycle) cycles.set(on, cycle.map(label).join(' → '))
    }

    const cycle = cycles.get(t.number)

    if (cycle) problems.push({ number: t.number, reason: `is in a cycle: ${cycle}` })
  }

  for (const t of tickets) {
    if (t.number === undefined) problems.push({ file: t.file, reason: 'has no ticket number in its name or its heading' })
  }

  return problems
}

/** The tickets that can be taken now: `ready`, with every blocker `done`. In ticket order. */
export const frontier = (tickets: readonly Ticket[]): Ticket[] => {
  const done = new Set(tickets.filter(t => t.status === 'done').map(t => t.number))

  return tickets
    .filter(t => t.status === 'ready' && t.blockers.every(blocker => done.has(blocker)))
    .sort((a, b) => (a.number ?? 0) - (b.number ?? 0))
}

/**
 * The `ready` tickets that can no longer be reached, because a ticket they hang off, directly or through others,
 * is `blocked` or `too-large`. The run marks these `blocked`.
 */
export const blockedBy = (tickets: readonly Ticket[]): Ticket[] => {
  const stuck = new Set(tickets.filter(t => t.status === 'blocked' || t.status === 'too-large').map(t => t.number))
  const found: Ticket[] = []
  let isGrowing = true

  while (isGrowing) {
    isGrowing = false

    for (const t of tickets) {
      if (t.status !== 'ready' || stuck.has(t.number) || !t.blockers.some(blocker => stuck.has(blocker))) continue

      stuck.add(t.number)
      found.push(t)
      isGrowing = true
    }
  }

  return found.sort((a, b) => (a.number ?? 0) - (b.number ?? 0))
}
