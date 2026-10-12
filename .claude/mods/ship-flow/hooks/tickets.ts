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
  /** The paths the ticket expects to change; absent when it declared no `Touches:`. */
  touches?: readonly string[]
  /** The ticket's outward actions, empty for `None`; absent when it declared no `Outward actions:`. */
  outward?: readonly string[]
}

/** What is wrong with a ticket, by its number, or by its file when it has none. */
export type Problem = { number?: number; file?: string; reason: string }

/** A ticket's number as its files and its lists spell it: two digits. */
export const label = (number: number): string => String(number).padStart(2, '0')

const field = (text: string, name: string): string | undefined =>
  new RegExp(`^\\*\\*${name}:\\*\\*[ \\t]*(.*)$`, 'm').exec(text)?.[1]?.trim()

const items = (value: string, separator: string): string[] =>
  value
    .split(separator)
    .map(item => item.trim())
    .filter(item => item !== '')

/** Reads one ticket file. Never fails: what a file lacks is left out, for `problemsOf` to report. */
export const parseTicket = (file: string, text: string): Ticket => {
  const heading = /^#\s+(?:(\d+)\s*:\s*)?(.*)$/m.exec(text)
  const numbered = heading?.[1] ?? /^(\d+)/.exec(file)?.[1]
  const status = field(text, 'Status')
  const model = field(text, 'Model')
  const touches = field(text, 'Touches')
  const outward = field(text, 'Outward actions')

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
    ...(touches !== undefined ? { touches: items(touches, ',') } : {}),
    ...(outward !== undefined ? { outward: /^none\.?$/i.test(outward) ? [] : items(outward, ';') } : {}),
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

const isUnder = (path: string, other: string): boolean => path === other || (other.endsWith('/') && path.startsWith(other))

/**
 * Whether two tickets may change the same file, by what each declares it touches. A ticket that declares nothing
 * may touch anything, so it overlaps every other.
 */
export const overlaps = (a: Ticket, b: Ticket): boolean => {
  const [mine, theirs] = [a, b].map(ticket => (ticket.touches ?? []).map(path => path.replaceAll('\\', '/')))

  if (!mine?.length || !theirs?.length) return true

  return mine.some(path => theirs.some(other => isUnder(path, other) || isUnder(other, path)))
}

/**
 * The tickets to start now, in ticket order, given those being built: those of the frontier that overlap neither a
 * ticket being built nor one taken before them, as many as the run still has room for.
 */
export const takeable = (tickets: readonly Ticket[], building: readonly number[], room: number): Ticket[] => {
  const beside = tickets.filter(t => t.number !== undefined && building.includes(t.number))
  const taken: Ticket[] = []

  for (const t of frontier(tickets)) {
    if (beside.length + taken.length >= room) break
    if (![...beside, ...taken].some(other => overlaps(t, other))) taken.push(t)
  }

  return taken
}

/** The files of a ticket's commit that its `Touches:` did not name; none for a ticket that declared nothing. */
export const outsideOf = (ticket: Ticket, changed: readonly string[]): string[] => {
  const declared = (ticket.touches ?? []).map(path => path.replaceAll('\\', '/'))

  return declared.length === 0 ? [] : changed.filter(file => !declared.some(path => isUnder(file.replaceAll('\\', '/'), path)))
}

/**
 * What is worth putting right in tickets that can be run as they are, in ticket order: what makes one be built
 * alone, or beside little, and what leaves the run nothing to judge it by.
 */
export const lintOf = (tickets: readonly Ticket[]): string[] =>
  [...tickets]
    .sort((a, b) => (a.number ?? 0) - (b.number ?? 0))
    .flatMap(ticket => {
      const name = ticket.number !== undefined ? label(ticket.number) : ticket.file
      const touches = ticket.touches ?? []

      return [
        ...(touches.length === 0 ? [`${name} declares no Touches: it is built alone, beside no other ticket`] : []),
        ...(touches.length > 0 && touches.every(path => path.endsWith('/'))
          ? [`${name} names only folders in Touches (${touches.join(', ')}): name the files, or no ticket under them is built beside it`]
          : []),
        ...(ticket.outward === undefined ? [`${name} declares no Outward actions: write None when it has none`] : []),
        ...(ticket.criteria.length === 0 ? [`${name} has no acceptance criterion: nothing says when it is built`] : []),
      ]
    })

/**
 * How a run would build its tickets, as an estimate: the waves it would take them in, were every ticket of a wave
 * to end before the next is taken, and the longest chain of tickets that each wait on the one before.
 */
export const scheduleOf = (tickets: readonly Ticket[], room: number): { waves: number[][]; chain: number[] } => {
  const waves: number[][] = []
  let standing = tickets

  for (let wave = takeable(standing, [], room); wave.length > 0; wave = takeable(standing, [], room)) {
    const built = new Set(wave)

    waves.push(wave.map(ticket => ticket.number ?? 0))
    standing = standing.map(ticket => (built.has(ticket) ? { ...ticket, status: 'done' } : ticket))
  }

  const left = new Map(tickets.filter(t => t.number !== undefined && t.status !== 'done').map(t => [t.number ?? 0, t]))
  const chains = new Map<number, number[]>()
  const chainTo = (number: number, walked: readonly number[]): number[] => {
    const known = chains.get(number)

    if (known) return known

    const before = (left.get(number)?.blockers ?? [])
      .filter(blocker => left.has(blocker) && !walked.includes(blocker))
      .map(blocker => chainTo(blocker, [...walked, number]))
      .reduce<number[]>((longest, chain) => (chain.length > longest.length ? chain : longest), [])
    const chain = [...before, number]

    chains.set(number, chain)

    return chain
  }

  return {
    waves,
    chain: [...left.keys()].sort((a, b) => a - b).reduce<number[]>((longest, number) => {
      const chain = chainTo(number, [])

      return chain.length > longest.length ? chain : longest
    }, []),
  }
}

/** The schedule as the lines the checkpoint shows; none for a run with fewer than two tickets left to build. */
export const scheduleLines = (tickets: readonly Ticket[], room: number): string[] => {
  const { waves, chain } = scheduleOf(tickets, room)
  const count = waves.reduce((sum, wave) => sum + wave.length, 0)

  if (count < 2) return []

  return [
    `Schedule (an estimate): ${count} tickets in ${waves.length} ${waves.length === 1 ? 'wave' : 'waves'}, up to ${room} side by side: ${waves.map(wave => wave.map(label).join(', ')).join(' · ')}`,
    ...(waves.every(wave => wave.length === 1) && room > 1 ? ['No two tickets are built side by side: their Touches overlap, or each waits on the one before.'] : []),
    ...(chain.length > 1 ? [`Longest chain: ${chain.map(label).join(' → ')}`] : []),
  ]
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
