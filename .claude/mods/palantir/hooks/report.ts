import type { Action, Attachment, Baseline, Browser, BrowserPage, Dom, DomElement, Facts, Level, Line, Render, Request, Usage, Vitals, Watch } from '../types'
import { shown } from './attach'
import { describeBrowser, IN_THE_PAGE } from './browser'
import { brokerLine, KINDS } from './broker'
import { databaseLine } from './database'
import { json } from './kit/json'
import type { TreeNode } from './kit/tree'
import { clockTime, describeLine, EMPTY_WATCH, fresh, requestIds } from './lines'
import { RUNTIME_NAME } from './runtime'
import { newSince, sinceText } from './errors'
import { traceOf, traceText } from './trace'

// What the tools answer the model: the watches as text, bounded, the secrets already out of every line.

export const HOW_TO_ATTACH =
  "Nothing is attached. palantir watches a compose project's services by itself; name anything else in .claude/palantir, one per line, as label=runtime:ref@root: api=docker:my-api@api, web=local:logs/web.log@web#3000 (the port a local app listens on, which is how what it consumes is measured), kafka=k8s:staging/statefulset/kafka. Then /palantir."

/** What is handed to Claude when the person asks it to name what palantir should watch. */
export const ATTACH_PROMPT =
  'Set up what the palantir mod watches in this project. Find what runs here and how (a compose file, Kubernetes manifests or a chart, containers, dev servers that write a log), then write .claude/palantir, one line per thing as label=runtime:ref@root: runtime is local (a log file, ended with #port, the port its process listens on), docker (a container), compose (a service) or k8s ([context/]namespace/kind/name); root is the source folder whose edits count against it. A compose project\'s services are watched by themselves and need no line. Then call mcp__palantir__status and say what is watched and how it stands.'

/** What is handed to Claude when the person asks it to bring a page under palantir's eye. */
export const BROWSER_PROMPT = (port: number, labels: readonly string[]): string =>
  `palantir reads the page of a watched frontend (${labels.join(', ')}) from a Chrome that listens on the debug port ${port} of this machine's loopback, and none shows one now. Find out why and say exactly what I should run: whether a Chrome answers on that port (curl -s http://127.0.0.1:${port}/json/version), which of the watched apps is a frontend and at what address it is served, and the command that starts Chrome with --remote-debugging-port=${port} and a --user-data-dir of its own, opened on that address. docs/remote-browser.md says how to bring the port here where this machine is a remote one. Start nothing yourself that opens a window; once I say it is open, check with mcp__palantir__status.`

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
export const describeAttachment = ({ label, runtime, ref }: Attachment, watch: Watch, usage: Usage = EMPTY_USAGE, page?: BrowserPage): string => {
  const { health, error, edits, editedPath } = watch
  const news = fresh(watch).length

  return [
    `${label} (${RUNTIME_NAME[runtime]} ${ref}): ${health.state}${health.detail === '' ? '' : `, ${health.detail}`}`,
    health.restarts > 0 ? `${health.restarts} restarts` : '',
    watch.signatures.length === 0 ? 'no error' : `${errorsOf(watch)} error${errorsOf(watch) === 1 ? '' : 's'} of ${watch.signatures.length} kind${watch.signatures.length === 1 ? '' : 's'}`,
    edits === 0 ? 'no edit routed to it yet' : `${news} new since the edit to ${editedPath}`,
    error === '' ? '' : `could not be read: ${error}`,
    usage.note === '' ? describeUsage(usage) : '',
    page === undefined ? '' : `its page is read from the browser, at ${page.address}`,
  ]
    .filter(part => part !== '')
    .join('; ')
}

type Known = Record<string, Facts>

export const statusText = (attachments: readonly Attachment[], held: Held, known: Known = {}, browser?: Browser, now = 0): string => {
  if (attachments.length === 0) return HOW_TO_ATTACH

  const said = (attachment: Attachment): string => {
    const watch = held[attachment.label] ?? EMPTY_WATCH
    // The last of its tabs is the one in view
    const page = browser?.pages.filter(({ label }) => label === attachment.label).pop()
    const engine = known[attachment.label]?.engine ?? ''

    return [
      `${describeAttachment(attachment, watch, known[attachment.label]?.usage, page)}${engine === '' ? '' : `; it runs ${engine}`}`,
      brokerLine(known[attachment.label]?.broker, now),
      databaseLine(known[attachment.label]?.database),
      ...unreadNow(watch, browser, attachment.label),
    ]
      .filter(line => line !== '')
      .join('\n')
  }

  const sections = byKind(attachments, known)

  // The apps, the brokers and the databases apart, each under its name, where they are not all apps
  return sections.length === 1 && sections[0]?.kind === 'app'
    ? attachments.map(said).join('\n')
    : sections.map(({ many, members }) => [`${many[0]?.toUpperCase()}${many.slice(1)}:`, ...members.map(said)].join('\n')).join('\n\n')
}

/** The attachments parted by what they are, in the order the kinds are shown; a kind that has none is left out. */
export const byKind = (attachments: readonly Attachment[], known: Known) =>
  KINDS.map(named => ({ ...named, members: attachments.filter(({ label }) => (known[label]?.kind ?? 'app') === named.kind) })).filter(({ members }) => members.length > 0)

/**
 * Said under an app whose page was read from the browser and is not now: what is shown of the page is what was last
 * read, not how it stands. An app whose page was never read from a browser (its log says it, or nothing does) has
 * nothing to say here.
 */
export const unreadNow = (watch: Watch, browser: Browser | undefined, label: string): string[] =>
  browser === undefined || watch.vitals === undefined || browser.pages.some(page => page.label === label)
    ? []
    : [`  its page is not read from the browser now: what is said of it is what was last read. ${browser.note === '' ? 'No tab of the browser shows this app.' : browser.note}`]

/**
 * The chains of the page as it is loaded now, and how many are left of a load before it: a chain last seen before
 * the page was loaded is of a page that is gone. Where no load was measured, every chain is of now.
 */
export const rendersNow = (watch: Watch): { live: Render[]; earlier: number; loadedAt: number } => {
  const renders = watch.renders ?? []
  const loadedAt = watch.vitals?.loadedAt ?? 0
  const live = renders.filter(({ lastAt }) => lastAt >= loadedAt)

  return { live, earlier: renders.length - live.length, loadedAt }
}

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
  'No render has been reported. Renders are read from the browser itself: a tab of the Chrome that listens on its debug port, showing a watched Vue app in development, says why its components rendered, with nothing added to the app. Any other frontend may write them to its log, a JSON line each: {"palantir":"render","component":"Cart","chain":["items (ref) set","total (computed)","Cart"],"values":["[3] (was [2])","42",null],"count":1}.'

const MAX_CHAINS = 40

/** Why the components of each frontend rendered again: each chain once, the most frequent first. */
export const rendersText = (attachments: readonly Attachment[], held: Held, ask: { target?: unknown; component?: unknown }, browser?: Browser, cwd = ''): string => {
  const asked = askedOf(attachments, ask)

  if (typeof asked === 'string') return asked

  const needle = typeof ask.component === 'string' ? ask.component.toLowerCase() : ''
  const reported = asked.flatMap(({ label }) => {
    const watch = held[label] ?? EMPTY_WATCH
    const { live, earlier, loadedAt } = rendersNow(watch)
    const renders = live.filter(({ component }) => needle === '' || component.toLowerCase().includes(needle))
    const total = renders.reduce((sum, render) => sum + render.count, 0)
    const before = earlier === 0 ? [] : [`  ${earlier} chain${earlier === 1 ? '' : 's'} last seen before the page was loaded, at ${clockTime(loadedAt)}, ${earlier === 1 ? 'is' : 'are'} left out.`]

    if (renders.length === 0) return needle === '' && earlier > 0 ? [[`${label}: no render since the page was loaded.`, ...unreadNow(watch, browser, label), ...before].join('\n')] : []

    const unchanged = renders.reduce((sum, render) => sum + (render.same ?? 0), 0)
    const files = sourcesOf(renders, cwd)

    return [
      [
        `${label}: ${total} render${total === 1 ? '' : 's'} in ${renders.length} chain${renders.length === 1 ? '' : 's'}${unchanged > 0 ? `, ${unchanged} of them with nothing changed: the values the chain holds were the same as the time before` : ''}.`,
        ...unreadNow(watch, browser, label),
        ...before,
        ...[...renders]
          .sort((a, b) => b.count - a.count)
          .slice(0, MAX_CHAINS)
          .map(({ chain, values, count, inside = 0, same = 0, lastAt }) => `  x${count}${inside > 0 ? ` (+${inside} inside)` : ''}${same > 0 ? ` (${same} with nothing changed)` : ''} last ${clockTime(lastAt)} ${chainText(chain, values)}`),
        ...(files.length > 0 ? ['  written in:', ...files.map(line => `    ${line}`)] : []),
      ].join('\n'),
    ]
  })

  if (reported.length > 0) return reported.join('\n')
  if (needle !== '') return `No render of a component named like ${needle} has been reported.`

  // Why the browser said none, when it was asked
  return [HOW_TO_REPORT_RENDERS, ...(browser === undefined ? [] : describeBrowser(browser, asked.map(({ label }) => label)))].join('\n')
}

/** Where each component the renders belong to is written, once each: `BeaconChain web/components/BeaconChain.vue`. */
const sourcesOf = (renders: readonly Render[], cwd: string): string[] => [...new Set(renders.flatMap(({ component, file = '' }) => (file === '' ? [] : [`${component} ${shown(file, cwd)}`])))]

const chainText = (chain: readonly string[], values: readonly string[] | undefined): string => chain.map((step, index) => stepText(step, values?.[index])).join(' -> ')

const perMinute = (count: number, ms: number): string => {
  const rate = count / (ms / 60_000)

  return `${rate >= 10 ? Math.round(rate) : rate.toFixed(1)}/min`
}

const agoText = (ms: number): string => (ms < 90_000 ? `${Math.max(0, Math.round(ms / 1000))}s` : `${Math.round(ms / 60_000)}m`)

// Under this long, a rate says nothing
const MIN_WINDOW_MS = 10_000

/**
 * What the last edit routed to each frontend did to its renders: the chains that first showed after it, the ones
 * that rendered before it and no more since, and for the rest how often they render now against how often before.
 */
export const rendersSinceText = (attachments: readonly Attachment[], held: Held, ask: { target?: unknown }, now: number): string => {
  const asked = askedOf(attachments, ask)

  if (typeof asked === 'string') return asked

  return asked
    .map(({ label }) => {
      const watch = held[label] ?? EMPTY_WATCH
      const renders = watch.renders ?? []
      const editedAt = watch.editedAt ?? 0

      if (watch.edits === 0) return `${label}: no edit has been routed to it in this session.`
      if (renders.length === 0) return `${label}: no render has been reported, before the edit to ${watch.editedPath} or since.`

      const after = now - editedAt
      const isTimed = editedAt > 0 && after >= MIN_WINDOW_MS

      const rows = renders.map(render => {
        const before = render.countAtEdit ?? 0
        const since = render.count - before
        const span = editedAt - (render.firstAt ?? editedAt)
        const was = before > 0 && span >= MIN_WINDOW_MS ? before / span : -1
        const is = isTimed ? since / after : -1
        const kind = render.edit === watch.edits && before === 0 ? 'new' : since === 0 ? 'gone' : was < 0 || is < 0 ? 'still' : is > was * 1.25 ? 'more' : is < was * 0.75 ? 'less' : 'same'
        const rates = kind === 'new' || kind === 'gone' ? '' : was < 0 || is < 0 ? '' : `, ${perMinute(since, after)} (was ${perMinute(before, span)})`

        return { kind, since, before, text: `  ${kind.padEnd(5)} x${since}${kind === 'gone' ? ` (x${before} before)` : ''}${rates} ${chainText(render.chain, render.values)}` }
      })

      const ORDER = ['new', 'more', 'less', 'gone', 'same', 'still']
      const total = rows.reduce((sum, row) => sum + row.since, 0)
      const earlier = rows.reduce((sum, row) => sum + row.before, 0)

      return [
        `${label}: ${total} render${total === 1 ? '' : 's'} since the edit to ${watch.editedPath}${editedAt > 0 ? `, ${agoText(after)} ago` : ''}; ${earlier} before it.${isTimed ? '' : ' Too soon after the edit for a rate: ask again once the page has been used.'}`,
        ...rows
          .sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || b.since - a.since)
          .slice(0, MAX_CHAINS)
          .map(row => row.text),
      ].join('\n')
    })
    .join('\n')
}

const lineOfAction = ({ at, kind, what, component }: Action): string => `${clockTime(at)} ${kind}${what === '' ? '' : ` ${what}`}${component === '' ? '' : ` in ${component}`}`

/** How long after something was done on a page a line written anywhere is said with it. */
const FOLLOWED_MS = 2_000
const MAX_FOLLOWED = 6

// How many leading parts of a path a server behind the page may know it without: `/api/realm/beacons` is `/beacons` there
const MAX_PREFIX = 3

// The path of each thing an action asked for, as the page knows it and as a server behind a prefix may
const askedPaths = ({ requests }: Action): RegExp[] =>
  requests.flatMap(request => {
    const parts = (/(?:^| )(?:https?:\/\/[^/\s]+)?(\/[^\s?]*)(?:\?\S*)? \d+ms$/.exec(request)?.[1] ?? '').split('/').filter(part => part !== '')

    return parts.slice(0, Math.min(MAX_PREFIX + 1, parts.length)).map((_, from) => new RegExp(`/${parts.slice(from).join('/').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w/-])`))
  })

/**
 * What every watched app wrote in the two seconds after something was done on a page, the page's own app included.
 * Where lines name what the action asked for, those are its doing, with the lines that share their request id and
 * what the page's console said: what other requests wrote in that time is counted, not said.
 */
export const followedBy = (action: Action, lines: readonly Labelled[]): string[] => {
  const after = lines.filter(({ line }) => line.at >= action.at - 50 && line.at < action.at + FOLLOWED_MS)
  const paths = askedPaths(action)
  const naming = after.filter(({ line }) => paths.some(path => path.test(line.message)))
  const ids = new Set(naming.flatMap(({ line }) => requestIds(line.message)))
  const its = naming.length === 0 ? after : after.filter(entry => naming.includes(entry) || entry.line.message.startsWith(IN_THE_PAGE) || requestIds(entry.line.message).some(id => ids.has(id)))
  const others = after.length - its.length

  return [
    ...its.slice(0, MAX_FOLLOWED).map(({ label, line }) => describeLine(label, line)),
    ...(its.length > MAX_FOLLOWED ? [`and ${its.length - MAX_FOLLOWED} more lines`] : []),
    ...(others > 0 ? [`and ${others} line${others === 1 ? '' : 's'} of other requests in that time`] : []),
  ]
}

export const HOW_TO_REPORT_ACTIONS =
  'Nothing done on a page has been seen yet. What the person does is read from the browser itself, from the first time the tab is asked on: click in the app, in the Chrome that listens on its debug port, and ask again two seconds later.'

/**
 * What the person last did on each frontend's page, each with what followed: the components that rendered, what
 * the page asked for, and what every watched app wrote in the two seconds after.
 */
export const actionsText = (attachments: readonly Attachment[], held: Held, ask: { target?: unknown; limit?: unknown }, browser?: Browser): string => {
  const asked = askedOf(attachments, ask)

  if (typeof asked === 'string') return asked

  const limit = Math.min(30, Math.max(1, typeof ask.limit === 'number' && Number.isFinite(ask.limit) ? Math.round(ask.limit) : 8))
  const lines = timeline(attachments, held)
  const reported = asked.flatMap(({ label }) => {
    const actions = (held[label] ?? EMPTY_WATCH).actions ?? []

    if (actions.length === 0) return []

    return [
      [
        `${label}: the last ${Math.min(limit, actions.length)} of ${actions.length} thing${actions.length === 1 ? '' : 's'} done on its page.`,
        ...unreadNow(held[label] ?? EMPTY_WATCH, browser, label),
        ...actions.slice(-limit).flatMap(action => {
          const logged = followedBy(action, lines)

          return [
            `  ${lineOfAction(action)}`,
            `    rendered: ${action.renders.length === 0 ? 'nothing' : action.renders.join(', ')}`,
            `    asked: ${action.requests.length === 0 ? 'nothing' : action.requests.join(', ')}`,
            ...(logged.length === 0 ? ['    logged: nothing'] : ['    logged:', ...logged.map(line => `      ${line}`)]),
          ]
        }),
      ].join('\n'),
    ]
  })

  if (reported.length > 0) return reported.join('\n')

  return [HOW_TO_REPORT_ACTIONS, ...(browser === undefined ? [] : describeBrowser(browser, asked.map(({ label }) => label)))].join('\n')
}

/** What was done on a page as a tree: a row each, the latest first, and under it what rendered, what was asked and what was logged. */
export const actionTree = (actions: readonly Action[], lines: readonly Labelled[]): TreeNode[] =>
  [...actions].reverse().map(action => ({
    label: `${clockTime(action.at)} ${action.kind}`,
    tone: 'accent' as const,
    ...(action.component === '' ? {} : { meta: `<${action.component}>` }),
    ...(action.what === '' ? {} : { value: action.what }),
    children: [
      ...(action.renders.length === 0 ? [] : [{ label: 'rendered', value: action.renders.join(', ') }]),
      ...action.requests.map(request => ({ label: 'asked', value: request, ...(/^(0|[45]\d\d) /.test(request) ? { tone: 'danger' as const } : {}) })),
      ...followedBy(action, lines).map(line => ({ label: 'logged', value: line, ...(/ ERROR /.test(line) ? { tone: 'danger' as const } : {}) })),
    ],
  }))

/** A status as it is said: the number, `no answer` where there was none, `not told` for another site's that the browser keeps from the page. */
export const answerText = (status: number): string => (status === 0 ? 'no answer' : status < 0 ? 'not told' : String(status))

const average = (totalMs: number, count: number): number => (count > 0 ? Math.round(totalMs / count) : 0)

/** A page's figures in words, the ones the browser measured. */
export const vitalsText = ({ loadedAt, ttfb, lcp, load, cls, inp, longTasks, longMs }: Vitals): string =>
  [
    `loaded at ${clockTime(loadedAt)}`,
    ttfb > 0 ? `first byte ${ttfb}ms` : '',
    lcp > 0 ? `largest paint ${lcp}ms` : '',
    load > 0 ? `loaded in ${load}ms` : '',
    `layout shift ${cls}`,
    inp > 0 ? `slowest answer to a click or a key ${inp}ms` : '',
    longTasks > 0 ? `${longTasks} task${longTasks === 1 ? '' : 's'} over 50ms (${longMs}ms in all)` : 'no task over 50ms',
  ]
    .filter(part => part !== '')
    .join(', ')

/** The requests the slowest in all first: what the page waits for most. */
export const slowestFirst = (requests: readonly Request[]): Request[] => [...requests].sort((a, b) => b.totalMs - a.totalMs)

export const HOW_TO_REPORT_NETWORK =
  'No request and no load figure has been seen yet. What a page asks for and how it loads are read from the browser itself: open the app in the Chrome that listens on its debug port.'

/**
 * What each frontend's page asked for, each address once with how often, how long and how it was answered, and how
 * the page loaded, each against how it stood when the last edit was routed to the app.
 */
export const networkText = (attachments: readonly Attachment[], held: Held, ask: { target?: unknown; grep?: unknown }, browser?: Browser): string => {
  const asked = askedOf(attachments, ask)

  if (typeof asked === 'string') return asked

  const needle = typeof ask.grep === 'string' ? ask.grep.toLowerCase() : ''
  const reported = asked.flatMap(({ label }) => {
    const watch = held[label] ?? EMPTY_WATCH
    const requests = slowestFirst(watch.requests ?? []).filter(({ url }) => needle === '' || url.toLowerCase().includes(needle))
    const { vitals, vitalsAtEdit } = watch

    if (requests.length === 0 && vitals === undefined) return []

    const isEdited = watch.edits > 0

    return [
      [
        `${label}: ${requests.reduce((sum, request) => sum + request.count, 0)} request${requests.length === 1 && requests[0]?.count === 1 ? '' : 's'} to ${requests.length} address${requests.length === 1 ? '' : 'es'}${needle === '' ? '' : ` like ${needle}`}.`,
        ...unreadNow(watch, browser, label),
        ...(vitals === undefined ? [] : [`  the page: ${vitalsText(vitals)}`]),
        ...(vitals === undefined || vitalsAtEdit === undefined ? [] : [`  before the edit to ${watch.editedPath}: ${vitalsAtEdit.loadedAt === vitals.loadedAt ? 'the same load of the page: reload it to measure the edit' : vitalsText(vitalsAtEdit)}`]),
        ...requests.slice(0, MAX_CHAINS).map(({ url, count, failed, totalMs, maxMs, lastStatus, lastAt, countAtEdit = 0, totalMsAtEdit = 0 }) => {
          const since = count - countAtEdit
          const edited = !isEdited ? '' : countAtEdit === 0 ? '; first asked since the edit' : since === 0 ? '; not asked since the edit' : `; since the edit x${since} avg ${average(totalMs - totalMsAtEdit, since)}ms, before it avg ${average(totalMsAtEdit, countAtEdit)}ms`

          return `  x${count} avg ${average(totalMs, count)}ms max ${maxMs}ms${failed > 0 ? `, ${failed} failed` : ''}, last ${answerText(lastStatus)} at ${clockTime(lastAt)} ${url}${edited}`
        }),
      ].join('\n'),
    ]
  })

  if (reported.length > 0) return reported.join('\n')
  if (needle !== '') return `No request to an address like ${needle} has been seen.`

  return [HOW_TO_REPORT_NETWORK, ...(browser === undefined ? [] : describeBrowser(browser, asked.map(({ label }) => label)))].join('\n')
}

const MAX_DOM_LINES = 200

const elementText = ({ depth, tag, attributes, text, component }: DomElement): string =>
  `${'  '.repeat(depth)}${tag}${component === '' ? '' : ` <${component}>`}${attributes === '' ? '' : ` ${attributes}`}${text === '' ? '' : ` "${text}"`}`

/**
 * Each frontend's page as text: its address, what a reader who does not see it cannot use, where its components
 * are written, and its elements, nested by their indent. With `grep`, only the elements that hold the text in their
 * tag, their attributes, their words or their component's name, each under the elements that hold it.
 */
export const domText = (attachments: readonly Attachment[], held: Held, ask: { target?: unknown; grep?: unknown }, browser?: Browser, cwd = ''): string => {
  const asked = askedOf(attachments, ask)

  if (typeof asked === 'string') return asked

  const needle = typeof ask.grep === 'string' ? ask.grep.toLowerCase() : ''
  const reported = asked.flatMap(({ label }) => {
    const watch = held[label] ?? EMPTY_WATCH
    const { dom } = watch

    if (dom === undefined) return []

    const { elements, issues = [], files = {} } = dom
    const isMatch = (element: DomElement) => needle === '' || [element.tag, element.attributes, element.text, element.component].some(part => part.toLowerCase().includes(needle))
    const kept = new Set<number>()

    elements.forEach((element, index) => {
      if (!isMatch(element)) return

      kept.add(index)

      // The elements that hold it: going back, each first one less deep
      let depth = element.depth

      for (let above = index - 1; above >= 0 && depth > 0; above -= 1) {
        const holder = elements[above]

        if (holder !== undefined && holder.depth < depth) {
          kept.add(above)
          depth = holder.depth
        }
      }
    })

    const lines = elements.filter((_, index) => kept.has(index)).map(elementText)
    const matching = needle === '' ? elements.length : elements.filter(isMatch).length
    const sources = Object.entries(files).filter(([name]) => needle === '' || name.toLowerCase().includes(needle) || elements.some(element => element.component === name && isMatch(element)))

    return [
      [
        `${label}: ${dom.title === '' ? 'a page' : `"${dom.title}"`} at ${dom.url}, as it stood at ${clockTime(dom.at)}: ${needle === '' ? `${elements.length} element${elements.length === 1 ? '' : 's'}` : `${matching} of ${elements.length} elements like ${needle}`}${dom.left > 0 ? `, ${dom.left} more left out` : ''}.`,
        ...unreadNow(watch, browser, label),
        ...(issues.length === 0 ? ['  nothing found that a reader who does not see the page cannot use'] : [`  ${issues.length} thing${issues.length === 1 ? '' : 's'} a reader who does not see the page cannot use:`, ...issues.map(({ kind, tag, component }) => `    ${kind}: ${tag}${component === '' ? '' : ` in ${component}`}`)]),
        ...(sources.length === 0 ? [] : ['  written in:', ...sources.map(([name, file]) => `    ${name} ${shown(file, cwd)}`)]),
        ...lines.slice(0, MAX_DOM_LINES).map(line => `  ${line}`),
        ...(lines.length > MAX_DOM_LINES ? [`  and ${lines.length - MAX_DOM_LINES} more elements: ask with grep`] : []),
      ].join('\n'),
    ]
  })

  if (reported.length > 0) return reported.join('\n')

  return [HOW_TO_REPORT_DOM, ...(browser === undefined ? [] : describeBrowser(browser, asked.map(({ label }) => label)))].join('\n')
}

type Branch = { step: string; value: string; whole: string; valueAt: number; itself: number; inside: number; same: number; total: number; under: Map<string, Branch> }

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
    const branch = level.get(step) ?? { step, value: '', whole: '', valueAt: 0, itself: 0, inside: 0, same: 0, total: 0, under: new Map<string, Branch>() }

    level.set(step, branch)

    return branch
  }

  for (const { component, chain, values, whole, count, inside = 0, same = 0, lastAt } of renders) {
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
      if (index === chain.length - 1) Object.assign(branch, { itself: branch.itself + count, inside: branch.inside + inside, same: branch.same + same })

      level = branch.under
    })
  }

  const busiestFirst = (level: Map<string, Branch>): Branch[] => [...level.values()].sort((a, b) => b.total - a.total)

  // `trail` is the steps from the top down to the row above, `above` the count the row above says
  const nodeOf = (branch: Branch, trail: readonly string[], above: number): TreeNode => {
    const steps = [...trail, branch.step]
    const count = branch.itself > 0 ? branch.itself : branch.total
    // What rendered inside a library's component is said beside its own renders, never as rows of its own
    const within = branch.inside > 0 ? `+${branch.inside} inside` : ''
    // Rendered with the values it held the time before: nothing it shows can have changed
    const unchanged = branch.same > 0 ? `${branch.same} unchanged` : ''
    const meta = [branch.itself > 0 || (within === '' && branch.total !== above) ? `×${count}` : '', within, unchanged].filter(part => part !== '').join(' ')
    const value = branch.value === '' ? '' : `= ${branch.value}`
    const detail = branch.whole === '' ? '' : wholeText(branch.whole)
    const id = [scope, ...steps].join('\n')

    return {
      label: branch.step,
      ...(branch.same > 0 && branch.same * 2 >= branch.itself ? { tone: 'warning' as const } : branch.itself > 0 || branch.inside > 0 ? { tone: 'accent' as const } : {}),
      ...(meta === '' ? {} : { meta }),
      ...(value === '' ? {} : { value }),
      children: busiestFirst(branch.under).map(below => nodeOf(below, steps, branch.total)),
      ...(detail === '' ? {} : { id, detail, isOpen: opened.includes(id) }),
    }
  }

  return busiestFirst(top).map(branch => nodeOf(branch, [], -1))
}

export const HOW_TO_READ_RENDERS = 'Colored: it rendered, × times, + what a library\'s component is made of. Unchanged: rendered with the values of the time before. ▸ opens a value whole. The pane scrolls.'
export const HOW_TO_REPORT_DOM =
  'No page has been reported. The page is read from the browser itself: the tab of the Chrome that listens on its debug port which shows a watched app hands its elements over, with nothing added to the app. A frontend may also write its page to its log, as one JSON line: {"palantir":"dom","url":"/cart","title":"Cart","elements":[[0,"body","","",""],[1,"main#app","role=\\"main\\"","","App"],[2,"h1","","Your cart",""]],"left":0}.'

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

export type LogsAsk = { target?: unknown; level?: unknown; grep?: unknown; limit?: unknown; request?: unknown }

/** The last lines that match what was asked, across the attachments or of one. */
export const logsText = (attachments: readonly Attachment[], held: Held, ask: LogsAsk): string => {
  if (attachments.length === 0) return HOW_TO_ATTACH

  const target = typeof ask.target === 'string' ? ask.target.trim() : ''

  if (target !== '' && !attachments.some(({ label }) => label === target)) {
    return `No attachment is named ${target}. They are: ${attachments.map(({ label }) => label).join(', ')}.`
  }

  // One request, followed across every app: whatever else was asked, its lines are all said
  const request = typeof ask.request === 'string' ? ask.request.trim() : ''

  if (request !== '') return traceText(request, traceOf(timeline(attachments, held), request))

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

/**
 * The errors that first showed after the last edit routed to each attachment, or to the one asked for; or, when
 * `since` says so, after its mark or its last start.
 */
export const errorsText = (attachments: readonly Attachment[], held: Held, ask: { target?: unknown; since?: unknown }): string => {
  if (attachments.length === 0) return HOW_TO_ATTACH

  const target = typeof ask.target === 'string' ? ask.target.trim() : ''
  const asked = attachments.filter(({ label }) => target === '' || label === target)
  const baseline: Baseline = ask.since === 'mark' || ask.since === 'start' ? ask.since : 'edit'

  if (asked.length === 0) return `No attachment is named ${target}. They are: ${attachments.map(({ label }) => label).join(', ')}.`

  return asked
    .map(({ label, runtime }) => {
      const watch = held[label] ?? EMPTY_WATCH
      const standing = watch.health.state === 'up' || watch.health.state === 'unknown' ? '' : ` It is ${watch.health.state}${watch.health.detail === '' ? '' : ` (${watch.health.detail})`}.`

      if (watch.error !== '') return `${label}: could not be read: ${watch.error}`
      if (baseline === 'edit' && watch.edits === 0) return `${label}: no edit has been routed to it in this session.${standing}`
      if (baseline !== 'edit' && (baseline === 'mark' ? watch.markedAt : watch.rolledAt) === undefined) return `${label}: ${sinceText(watch, baseline)}.${standing}`

      const news = newSince(watch, baseline)
      // What runs in a container runs the edit only once it has taken it in: by reloading its source, or by starting over
      const rolled =
        baseline !== 'edit' || runtime === 'local' || watch.editedAt === undefined
          ? ''
          : watch.rolledAt !== undefined && watch.rolledAt >= watch.editedAt
            ? ` It started over at ${clockTime(watch.rolledAt)}, after the edit.`
            : news.length === 0
              ? ' It has not started over since: unless it reloads its source by itself, the edit is not what runs yet.'
              : ''

      if (news.length === 0) return `${label}: no new error ${sinceText(watch, baseline)}.${standing}${rolled}`

      return [
        `${label}: ${news.length} new error${news.length === 1 ? '' : 's'} ${sinceText(watch, baseline)}.${standing}${rolled}`,
        ...news.map(signature => `  ${clockTime(signature.lastAt)} x${signature.count} ${signature.sample}`),
      ].join('\n')
    })
    .join('\n')
}
