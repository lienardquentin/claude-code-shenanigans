import { label } from './tickets'
import type { Ticket } from './tickets'

/** What a ticket's reach says when it declared nothing, and the mark beside a ticket that has outward actions. */
export const NOT_DECLARED = 'not declared'
export const OUTWARD_MARK = '▲'
/** Said under the totals when the repo could not be read through `git`. */
export const DEPENDENTS_UNREAD = 'The dependents could not be read: git failed, so only the declared files are counted.'

/** What is read of the repo: its tracked files, and the lines of them that look like an import. */
export type Reading = {
  tracked: readonly string[]
  imports: readonly { file: string; line: string }[]
}

/** One ticket's blast radius: the files it declares inside the repo, who leans on them, and its outward actions in full. */
export type TicketRadius = {
  number?: number
  /** Whether the ticket declared its `Touches:` at all. */
  isDeclared: boolean
  /** Whether the repo was read: when not, only the declared files are known. */
  isRead: boolean
  files: readonly string[]
  /** The tracked files, not touched by the ticket, that import a touched file directly. */
  dependents: readonly string[]
  /** The dependents that are tests. */
  tests: readonly string[]
  outward: readonly string[]
}

/** A path that leaves the repo: absolute, starting with `~`, or climbing out with `..`. */
export const isOutside = (path: string): boolean =>
  /^([/\\]|~|[A-Za-z]:)/.test(path) || path.split(/[/\\]/).includes('..')

const unslash = (path: string): string => path.replaceAll('\\', '/')

const withoutExtension = (path: string): string => path.replace(/\.[^./]+$/, '')

const dirOf = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')

const baseOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

/** Joins a relative specifier onto the importing file's folder, folding `.` and `..`. */
const resolve = (from: string, specifier: string): string => {
  const parts: string[] = dirOf(from) === '' ? [] : dirOf(from).split('/')

  for (const part of specifier.split('/')) {
    if (part === '.' || part === '') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }

  return parts.join('/')
}

/** Whether a file's name or folder says it is a test. */
export const isTest = (path: string): boolean => {
  const parts = unslash(path).split('/')
  const name = parts.at(-1) ?? ''

  return /\.test\.|\.spec\.|_test\./.test(name) || name.startsWith('test_') || parts.slice(0, -1).some(part => ['test', 'tests', '__tests__'].includes(part))
}

const IMPORT_WORD = /\b(import|from|require|include|use|source|load)\b/

/** The quoted strings of a line that holds one of the words a language imports with. */
const specifiersOf = (line: string): string[] =>
  IMPORT_WORD.test(line) ? Array.from(line.matchAll(/(["'`])([^"'`\n]+?)\1/g), match => match[2] ?? '') : []

// Whether one specifier, written in `from`, names the touched file
const names = (specifier: string, from: string, touched: string): boolean => {
  const bare = withoutExtension(touched)
  const index = baseOf(bare) === 'index' ? dirOf(touched) : undefined

  if (specifier.startsWith('.')) {
    const target = resolve(from, specifier)

    return target === touched || target === bare || (index !== undefined && target === index)
  }

  const path = specifier.replace(/^\/+/, '')
  const tail = (full: string) => full === path || full.endsWith(`/${path}`)

  return tail(touched) || tail(bare) || (index !== undefined && index !== '' && tail(index))
}

/** The tracked files a ticket's touched paths stand for: a directory is every tracked file under it, an untracked path is new. */
const filesOf = (touched: readonly string[], tracked: ReadonlySet<string>): { files: string[]; existing: string[] } => {
  const files = new Set<string>()
  const existing = new Set<string>()

  for (const raw of touched) {
    const path = unslash(raw)

    if (path.endsWith('/')) {
      const under = [...tracked].filter(file => file.startsWith(path))

      if (under.length === 0) files.add(path)
      for (const file of under) {
        files.add(file)
        existing.add(file)
      }
    } else {
      files.add(path)
      if (tracked.has(path)) existing.add(path)
    }
  }

  return { files: [...files], existing: [...existing] }
}

/** A ticket's radius from what it declares. A touched path outside the repo is an outward action, not a file. */
export const radiusOf = (ticket: Ticket, reading?: Reading): TicketRadius => {
  const touched = ticket.touches ?? []
  const inside = touched.filter(path => !isOutside(path))
  const { files, existing } = filesOf(inside, new Set(reading?.tracked ?? []))
  const own = new Set(files)
  const dependents = new Set<string>()

  if (reading) {
    for (const { file, line } of reading.imports) {
      const from = unslash(file)

      if (own.has(from) || dependents.has(from)) continue
      if (specifiersOf(line).some(specifier => existing.some(target => names(specifier, from, target)))) dependents.add(from)
    }
  }

  return {
    ...(ticket.number !== undefined ? { number: ticket.number } : {}),
    isDeclared: ticket.touches !== undefined,
    isRead: reading !== undefined,
    files,
    dependents: [...dependents],
    tests: [...dependents].filter(isTest),
    outward: [...touched.filter(isOutside).map(path => `changes \`${path}\` outside the repo`), ...(ticket.outward ?? [])],
  }
}

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`

const reachOf = (isRead: boolean, files: number, dependents: number, tests: number): string =>
  isRead
    ? `${plural(files, 'file', 'files')} · ${plural(dependents, 'dependent', 'dependents')} · ${plural(tests, 'test', 'tests')}`
    : plural(files, 'file', 'files')

/** A ticket's reach as one cell or phrase: its files, dependents and tests, or that it declared none. */
export const reachText = (radius: TicketRadius): string =>
  radius.isDeclared ? reachOf(radius.isRead, radius.files.length, radius.dependents.length, radius.tests.length) : NOT_DECLARED

/** A ticket's reach, and the mark when it has outward actions: what its row says. */
export const rowText = (radius: TicketRadius): string =>
  radius.outward.length > 0 ? `${reachText(radius)} ${OUTWARD_MARK}` : reachText(radius)

/** The run's radius: its files and dependents, each counted once, and every outward action by ticket. */
export type RunRadius = {
  isDeclared: boolean
  isRead: boolean
  files: readonly string[]
  /** Every ticket's dependents, less every file the run touches. */
  dependents: readonly string[]
  tests: readonly string[]
  outward: readonly { number?: number; action: string }[]
}

export const runRadiusOf = (tickets: readonly Ticket[], reading?: Reading): RunRadius => {
  const radii = [...tickets].sort((a, b) => (a.number ?? 0) - (b.number ?? 0)).map(ticket => radiusOf(ticket, reading))
  const files = [...new Set(radii.flatMap(radius => radius.files))]
  const touched = new Set(files)
  const dependents = [...new Set(radii.flatMap(radius => radius.dependents))].filter(file => !touched.has(file))

  return {
    isDeclared: radii.some(radius => radius.isDeclared),
    isRead: reading !== undefined,
    files,
    dependents,
    tests: dependents.filter(isTest),
    outward: radii.flatMap(radius =>
      radius.outward.map(action => ({ ...(radius.number !== undefined ? { number: radius.number } : {}), action })),
    ),
  }
}

/** The run's block of lines: its totals, then every outward action in full, by ticket number. */
export const blockOf = (tickets: readonly Ticket[], reading?: Reading): { totals: string; outward: string[] } => {
  const run = runRadiusOf(tickets, reading)

  return {
    totals: `Blast radius (an estimate): ${
      run.isDeclared ? reachOf(run.isRead, run.files.length, run.dependents.length, run.tests.length) : NOT_DECLARED
    }`,
    outward: run.outward.map(({ number, action }) => `${number !== undefined ? label(number) : '??'} ${action}`),
  }
}
