import type { Attachment, Dom, DomElement, Facts, Level, Line, Render, Usage, Watch } from '../types'
import { json } from './kit/json'
import type { TreeNode } from './kit/tree'
import { clockTime, describeLine, EMPTY_WATCH, fresh } from './lines'
import { RUNTIME_NAME } from './runtime'

// What the tools answer the model: the watches as text, bounded, the secrets already out of every line.

export const HOW_TO_ATTACH =
  "Nothing is attached. palantir watches a compose project's services by itself; name anything else in .claude/palantir, one per line, as label=runtime:ref@root: api=docker:my-api@api, web=local:logs/web.log@web#3000 (the port a local app listens on, which is how what it consumes is measured), kafka=k8s:staging/statefulset/kafka. Then /palantir."

type Held = Record<string, Watch>

const RANK: Record<Level, number> = { info: 0, warn: 1, error: 2 }

const errorsOf = (watch: Watch) => watch.signatures.reduce((sum, signature) => sum + signature.count, 0)

export const EMPTY_USAGE: Usage = { cpu: -1, memory: -1, limit: 0, processes: 0, cpuSeconds: 0, at: 0, note: 'not read yet' }
export const EMPTY_FACTS: Facts = { env: [], envNote: 'Not read yet.', usage: EMPTY_USAGE }

const MEGA = 1024 ** 2
const GIGA = 1024 ** 3

const bytesText = (bytes: number): string => (bytes >= GIGA ? `${(bytes / GIGA).toFixed(1)} GB` : `${Math.round(bytes / MEGA)} MB`)

/** A processor share as the pane's cell writes it: of one core, so two busy cores are 200%. Empty while not known. */
export const cpuText = ({ cpu }: Usage): string => (cpu < 0 ? '' : `${cpu >= 10 ? Math.round(cpu) : cpu.toFixed(1)}%`)

/** The memory held, and of how much when there is a limit. Empty while not known. */
export const memoryText = ({ memory, limit }: Usage): string => (memory < 0 ? '' : limit > 0 ? `${bytesText(memory)} / ${bytesText(limit)}` : bytesText(memory))

/** What an app consumes, in words: or why that is not known. */
export const describeUsage = (usage: Usage): string =>
  usage.note !== ''
    ? usage.note
    : [
        usage.cpu < 0 ? 'cpu not measured yet (it is measured between two reads)' : `cpu ${cpuText(usage)} of one core`,
        `memory ${memoryText(usage)}`,
        usage.processes > 1 ? `across ${usage.processes} processes` : '',
      ]
        .filter(part => part !== '')
        .join(', ')

/** One attachment in a line: where it runs, how it stands, its errors and how many are new since the last edit. */
export const describeAttachment = ({ label, runtime, ref }: Attachment, watch: Watch, usage: Usage = EMPTY_USAGE): string => {
  const { health, error, edits, editedPath } = watch
  const news = fresh(watch).length

  return [
    `${label} (${RUNTIME_NAME[runtime]} ${ref}): ${health.state}${health.detail === '' ? '' : `, ${health.detail}`}`,
    health.restarts > 0 ? `${health.restarts} restarts` : '',
    `${errorsOf(watch)} errors in ${watch.signatures.length} kinds`,
    edits === 0 ? 'no edit routed to it yet' : `${news} new since the edit to ${editedPath}`,
    error === '' ? '' : `could not be read: ${error}`,
    usage.note === '' ? describeUsage(usage) : '',
  ]
    .filter(part => part !== '')
    .join('; ')
}

type Known = Record<string, Facts>

export const statusText = (attachments: readonly Attachment[], held: Held, known: Known = {}): string =>
  attachments.length === 0
    ? HOW_TO_ATTACH
    : attachments.map(attachment => describeAttachment(attachment, held[attachment.label] ?? EMPTY_WATCH, known[attachment.label]?.usage)).join('\n')

// The attachments a tool was asked about: the one named, or all; a word of refusal when none has the name
const askedOf = (attachments: readonly Attachment[], ask: { target?: unknown }): Attachment[] | string => {
  if (attachments.length === 0) return HOW_TO_ATTACH

  const target = typeof ask.target === 'string' ? ask.target.trim() : ''
  const asked = attachments.filter(({ label }) => target === '' || label === target)

  return asked.length === 0 ? `No attachment is named ${target}. They are: ${attachments.map(({ label }) => label).join(', ')}.` : asked
}

/** What each attachment consumes, or the one asked for. */
export const usageText = (attachments: readonly Attachment[], known: Known, ask: { target?: unknown }): string => {
  const asked = askedOf(attachments, ask)

  return typeof asked === 'string' ? asked : asked.map(({ label }) => `${label}: ${describeUsage((known[label] ?? EMPTY_FACTS).usage)}`).join('\n')
}

const MAX_VARIABLES = 200

/** The environment of each attachment, or of the one asked for, the secrets out of every value. */
export const envText = (attachments: readonly Attachment[], known: Known, ask: { target?: unknown; grep?: unknown }): string => {
  const asked = askedOf(attachments, ask)

  if (typeof asked === 'string') return asked

  const needle = typeof ask.grep === 'string' ? ask.grep.toLowerCase() : ''

  return asked
    .map(({ label }) => {
      const { env, envNote } = known[label] ?? EMPTY_FACTS
      const matching = env.filter(({ name }) => needle === '' || name.toLowerCase().includes(needle))
      const said = matching.slice(0, MAX_VARIABLES)

      return [
        `${label}: ${matching.length} variable${matching.length === 1 ? '' : 's'}${needle === '' ? '' : ` of ${env.length} named like ${needle}`}. ${envNote}`,
        ...said.map(({ name, value, from }) => `  ${name}=${value} (${from})`),
        ...(matching.length > said.length ? [`  and ${matching.length - said.length} more: ask with grep`] : []),
      ].join('\n')
    })
    .join('\n')
}

export const HOW_TO_REPORT_RENDERS =
  'No render has been reported. A frontend reports one by writing a JSON line to its log: {"palantir":"render","component":"Cart","chain":["items (ref) set","total (computed)","Cart"],"values":["[3] (was [2])","42",null],"count":1}, the chain being what changed, through what, down to the component, and the values, which may be left out, what each step held. For Vue and Nuxt the palantir mod holds a plugin that does it in development, in its recipes folder.'

const MAX_CHAINS = 40

/** Why the components of each frontend rendered again: each chain once, the most frequent first. */
export const rendersText = (attachments: readonly Attachment[], held: Held, ask: { target?: unknown; component?: unknown }): string => {
  const asked = askedOf(attachments, ask)

  if (typeof asked === 'string') return asked

  const needle = typeof ask.component === 'string' ? ask.component.toLowerCase() : ''
  const reported = asked.flatMap(({ label }) => {
    const renders = ((held[label] ?? EMPTY_WATCH).renders ?? []).filter(({ component }) => needle === '' || component.toLowerCase().includes(needle))
    const total = renders.reduce((sum, render) => sum + render.count, 0)

    if (renders.length === 0) return []

    return [
      [
        `${label}: ${total} render${total === 1 ? '' : 's'} in ${renders.length} chain${renders.length === 1 ? '' : 's'}.`,
        ...[...renders]
          .sort((a, b) => b.count - a.count)
          .slice(0, MAX_CHAINS)
          .map(({ chain, values, count, lastAt }) => `  x${count} last ${clockTime(lastAt)} ${chain.map((step, index) => stepText(step, values?.[index])).join(' -> ')}`),
      ].join('\n'),
    ]
  })

  return reported.length > 0 ? reported.join('\n') : needle === '' ? HOW_TO_REPORT_RENDERS : `No render of a component named like ${needle} has been reported.`
}

type Branch = { step: string; value: string; whole: string; valueAt: number; itself: number; total: number; under: Map<string, Branch> }

export type RenderTreeAsk = {
  /** The app the renders are of, where the tree holds more than one: its rows are told apart from another's by it. */
  scope?: string
  /** The rows that are open, by their id. */
  opened?: readonly string[]
}

// A whole value as it is read: formatted when it is JSON, as it came otherwise
const wholeText = (whole: string): string => {
  try {
    return json(JSON.parse(whole))
  } catch {
    return whole
  }
}

/** A step of a chain with the value it held, when one was said. */
const stepText = (step: string, value: string | undefined): string => (value === undefined || value === '' ? step : `${step}: ${value}`)

/**
 * The chains as one tree. A top row is a component of the app's own; under it, what changed, then what carried the
 * change, a step a row, down to each component that rendered, said in the accent tone. Chains that start alike
 * share their start, so a row's children are all that its change reached. A row says how many renders went through
 * it where that is not what the row above says, a component how many times it rendered itself, and a state or a
 * prop the value it held, last on the row. A value sent whole beside its short form is the row's detail, as
 * formatted JSON where it is JSON: such a row opens, and is open when `opened` names it.
 */
export const renderTree = (renders: readonly Render[], { scope = '', opened = [] }: RenderTreeAsk = {}): TreeNode[] => {
  const top = new Map<string, Branch>()

  const branchIn = (level: Map<string, Branch>, step: string): Branch => {
    const branch = level.get(step) ?? { step, value: '', whole: '', valueAt: 0, itself: 0, total: 0, under: new Map<string, Branch>() }

    level.set(step, branch)

    return branch
  }

  for (const { component, chain, values, whole, count, lastAt } of renders) {
    // A library's component renders inside one of the app's own: its chain hangs under that one
    const owner = branchIn(top, component)
    let level = owner.under

    owner.total += count
    // A render whose cause was not said is still that component's
    if (chain.length === 0) owner.itself += count

    chain.forEach((step, index) => {
      const branch = branchIn(level, step)
      const value = values?.[index] ?? ''

      branch.total += count

      // Of the chains that share the step, the one that rendered last says what it holds
      if (value !== '' && lastAt >= branch.valueAt) Object.assign(branch, { value, whole: whole?.[index] ?? '', valueAt: lastAt })
      if (index === chain.length - 1) branch.itself += count

      level = branch.under
    })
  }

  const busiestFirst = (level: Map<string, Branch>): Branch[] => [...level.values()].sort((a, b) => b.total - a.total)

  // `trail` is the steps from the top down to the row above, `above` the count the row above says
  const nodeOf = (branch: Branch, trail: readonly string[], above: number): TreeNode => {
    const steps = [...trail, branch.step]
    const count = branch.itself > 0 ? branch.itself : branch.total
    const meta = branch.itself > 0 || branch.total !== above ? `×${count}` : ''
    const value = branch.value === '' ? '' : `= ${branch.value}`
    const detail = branch.whole === '' ? '' : wholeText(branch.whole)
    const id = [scope, ...steps].join('\n')

    return {
      label: branch.step,
      ...(branch.itself > 0 ? { tone: 'accent' as const } : {}),
      ...(meta === '' ? {} : { meta }),
      ...(value === '' ? {} : { value }),
      children: busiestFirst(branch.under).map(below => nodeOf(below, steps, branch.total)),
      ...(detail === '' ? {} : { id, detail, isOpen: opened.includes(id) }),
    }
  }

  return busiestFirst(top).map(branch => nodeOf(branch, [], -1))
}

export const HOW_TO_READ_RENDERS = 'Colored: it rendered, × times. ▸ opens a value whole. The pane scrolls.'
export const HOW_TO_REPORT_DOM =
  'No page has been reported. A frontend reports its page by writing a JSON line to its log when the page has changed: {"palantir":"dom","url":"/cart","title":"Cart","elements":[[0,"body","","",""],[1,"main#app","role=\\"main\\"","","App"],[2,"h1","","Your cart",""]],"left":0}, an element being how deep it is nested, what it is, what it is to a reader, its own text, and the component it is the outermost element of. For Vue and Nuxt the palantir mod holds a plugin that does it in development, in its recipes folder.'

export const HOW_TO_READ_DOM = 'Colored: the outermost element of a component, named after it. › : an element that holds only the next.'

type Nested = DomElement & { under: Nested[] }

/**
 * A page's elements as a tree, nested as the document nests them. An element says what it is, then its component
 * and what it is to a reader, then the text it holds itself; the outermost element of a component is in the accent
 * tone. An element that only holds one other, and says nothing more than its tag, is said on that one's row.
 */
export const domTree = ({ elements }: Dom): TreeNode[] => {
  const top: Nested[] = []
  const open: Nested[] = []

  for (const element of elements) {
    const nested = { ...element, under: [] }

    // Back up to the element that holds it: the last one less deep
    while (open.length > 0 && (open[open.length - 1]?.depth ?? 0) >= element.depth) open.pop()

    ;(open[open.length - 1]?.under ?? top).push(nested)
    open.push(nested)
  }

  const nodeOf = (element: Nested, before: readonly string[]): TreeNode => {
    const path = [...before, element.tag]
    const [only] = element.under

    if (element.under.length === 1 && only !== undefined && element.text === '' && element.attributes === '' && element.component === '') return nodeOf(only, path)

    const meta = [element.component === '' ? '' : `<${element.component}>`, element.attributes].filter(part => part !== '').join(' ')

    return {
      label: path.join(' › '),
      ...(element.component === '' ? {} : { tone: 'accent' as const }),
      ...(meta === '' ? {} : { meta }),
      ...(element.text === '' ? {} : { value: `"${element.text}"` }),
      children: element.under.map(below => nodeOf(below, [])),
    }
  }

  return top.map(element => nodeOf(element, []))
}

export type Labelled = { label: string; line: Line }

/** Every attachment's lines as one timeline, oldest first. */
export const timeline = (attachments: readonly Attachment[], held: Held): Labelled[] =>
  attachments
    .flatMap(({ label }) => (held[label] ?? EMPTY_WATCH).lines.map(line => ({ label, line })))
    .sort((a, b) => a.line.at - b.line.at)

export type LogsAsk = { target?: unknown; level?: unknown; grep?: unknown; limit?: unknown }

/** The last lines that match what was asked, across the attachments or of one. */
export const logsText = (attachments: readonly Attachment[], held: Held, ask: LogsAsk): string => {
  if (attachments.length === 0) return HOW_TO_ATTACH

  const target = typeof ask.target === 'string' ? ask.target.trim() : ''

  if (target !== '' && !attachments.some(({ label }) => label === target)) {
    return `No attachment is named ${target}. They are: ${attachments.map(({ label }) => label).join(', ')}.`
  }

  const floor = RANK[ask.level === 'error' || ask.level === 'warn' ? ask.level : 'info']
  const needle = typeof ask.grep === 'string' ? ask.grep.toLowerCase() : ''
  const limit = Math.min(200, Math.max(1, typeof ask.limit === 'number' && Number.isFinite(ask.limit) ? Math.round(ask.limit) : 50))

  const matching = timeline(attachments, held).filter(
    ({ label, line }) => (target === '' || label === target) && RANK[line.level] >= floor && (needle === '' || line.message.toLowerCase().includes(needle)),
  )

  if (matching.length === 0) return 'No line matches.'

  const shown = matching.slice(-limit)

  return [
    ...(matching.length > shown.length ? [`The last ${shown.length} of ${matching.length} matching lines:`] : []),
    ...shown.map(({ label, line }) => describeLine(label, line)),
  ].join('\n')
}

/** The errors that first showed after the last edit routed to each attachment, or to the one asked for. */
export const errorsText = (attachments: readonly Attachment[], held: Held, ask: { target?: unknown }): string => {
  if (attachments.length === 0) return HOW_TO_ATTACH

  const target = typeof ask.target === 'string' ? ask.target.trim() : ''
  const asked = attachments.filter(({ label }) => target === '' || label === target)

  if (asked.length === 0) return `No attachment is named ${target}. They are: ${attachments.map(({ label }) => label).join(', ')}.`

  return asked
    .map(({ label }) => {
      const watch = held[label] ?? EMPTY_WATCH
      const standing = watch.health.state === 'up' || watch.health.state === 'unknown' ? '' : ` It is ${watch.health.state}${watch.health.detail === '' ? '' : ` (${watch.health.detail})`}.`

      if (watch.error !== '') return `${label}: could not be read: ${watch.error}`
      if (watch.edits === 0) return `${label}: no edit has been routed to it in this session.${standing}`

      const news = fresh(watch)

      if (news.length === 0) return `${label}: no new error since the edit to ${watch.editedPath}.${standing}`

      return [
        `${label}: ${news.length} new error${news.length === 1 ? '' : 's'} since the edit to ${watch.editedPath}.${standing}`,
        ...news.map(signature => `  ${clockTime(signature.lastAt)} x${signature.count} ${signature.sample}`),
      ].join('\n')
    })
    .join('\n')
}
