import type { Attachment, Browser, BrowserPage } from '../types'

// What the browser itself says of the watched frontends: why their components rendered and how their page stands,
// asked of the tabs of a Chrome that listens on a debug port. The asking is done by a Node script of the mod's
// own (`browser/ask.mjs`), which speaks the DevTools protocol; here is its command line and the reading of what
// it prints. Text in, values out.

/** The port Chrome's DevTools protocol is asked on, on this machine's loopback, unless the option names another. */
export const DEBUG_PORT = 9222

export const EMPTY_BROWSER: Browser = { at: 0, note: 'The browser has not been asked yet.', pages: [] }

/** The command that asks every tab of the browser which watched app it shows, and what that page says. */
export const askArgv = (root: string, port: number, attachments: readonly Attachment[]): string[] => [
  'node',
  `${root}/browser/ask.mjs`,
  String(port),
  JSON.stringify(attachments.map(({ label, roots, port: listens }) => ({ label, roots, port: listens }))),
]

const HOW_TO_OPEN = (port: number): string =>
  `No Chrome answers on 127.0.0.1:${port}. Renders and the page are read from the browser itself: start Chrome with --remote-debugging-port=${port} on a profile of its own and open the app in it.`

type Printed = { exitCode: number; stdout: string } | undefined

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

type Told = { label?: unknown; address?: unknown; isVisible?: unknown; vue?: unknown; isDev?: unknown; renders?: unknown; dom?: unknown; actions?: unknown; requests?: unknown; vitals?: unknown; said?: unknown }

const objects = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null) : [])

/** What a line the page's console holds is led with in the timeline, so that it is told from what the server wrote. */
export const IN_THE_PAGE = 'in the page: '

// What the page's console said, as a line its app would have written: its level, its words, where it was raised
const consoleLine = ({ level, text: words, at, where }: Record<string, unknown>): string =>
  JSON.stringify({ level: level === 'error' ? 'error' : 'warn', msg: `${IN_THE_PAGE}${text(words).slice(0, 400)}`, ...(typeof at === 'number' ? { time: at } : {}), ...(text(where) === '' ? {} : { at: text(where).slice(0, 120) }) })

// Why a page that is one of the apps says no render
const silence = ({ vue, isDev }: Told): string =>
  text(vue) === '' ? 'no Vue app on it: only its elements are read' : isDev === true ? '' : 'a production build, where Vue names no trigger: only its elements are read'

export type Asked = {
  browser: Browser
  /** Whether Chrome answered at all: one that did not is asked again less often. */
  isReached: boolean
  /** By attachment label: what its pages said, as the lines a frontend would have written in its log. */
  raws: Record<string, string[]>
}

/**
 * What the asking came to. Each page of a watched app hands its renders and its elements over as the JSON lines
 * The runtime mod counts renders and keeps pages by, so that what the browser says is read as what a log says; what the
 * person did on it, what it asked for and how it loaded likewise, and what its console holds of errors and
 * warnings as lines of the app's own, which are counted as its errors are. A page
 * the person is looking at is taken last: where two tabs show one app, the page kept is that one.
 */
export const readAsked = (ran: Printed, attachments: readonly Attachment[], port: number, now: number): Asked => {
  const failed = (note: string): Asked => ({ browser: { at: now, note, pages: [] }, isReached: false, raws: {} })

  if (ran === undefined) return failed('node did not start: the browser is asked through it.')
  if (ran.exitCode !== 0) return failed(ran.exitCode === 127 ? 'node was not found: the browser is asked through it.' : `The browser could not be asked: node exited with ${ran.exitCode}.`)

  let answer: { error?: unknown; tabs?: unknown; pages?: unknown }

  try {
    answer = JSON.parse(ran.stdout.trim().split('\n').pop() ?? '') as typeof answer
  } catch {
    return failed('The browser could not be asked: what was printed does not read.')
  }

  if (answer?.error === 'no-browser') return failed(HOW_TO_OPEN(port))
  if (typeof answer?.error === 'string') return failed(`The browser could not be asked: ${answer.error.slice(0, 160)}.`)

  const told = (Array.isArray(answer?.pages) ? (answer.pages as Told[]) : [])
    .filter(page => attachments.some(({ label }) => label === page?.label))
    .sort((a, b) => Number(a.isVisible === true) - Number(b.isVisible === true))

  const raws: Record<string, string[]> = {}
  const pages: BrowserPage[] = []

  for (const page of told) {
    const label = text(page.label)
    const dom = (typeof page.dom === 'object' && page.dom !== null ? page.dom : {}) as { title?: unknown }

    pages.push({ label, address: text(page.address).slice(0, 200), title: text(dom.title).slice(0, 120), note: silence(page) })
    raws[label] = [
      ...(raws[label] ?? []),
      ...objects(page.said).map(consoleLine),
      ...objects(page.renders).map(render => JSON.stringify({ ...render, runtime: 'render' })),
      ...objects(page.actions).map(action => JSON.stringify({ ...action, runtime: 'action' })),
      ...objects(page.requests).map(request => JSON.stringify({ ...request, runtime: 'request' })),
      ...(typeof page.vitals === 'object' && page.vitals !== null ? [JSON.stringify({ ...page.vitals, runtime: 'vitals' })] : []),
      JSON.stringify({ ...dom, runtime: 'dom' }),
    ]
  }

  const tabs = typeof answer?.tabs === 'number' ? answer.tabs : 0
  const note = pages.length > 0 ? '' : `Chrome answers on 127.0.0.1:${port}, and none of its ${tabs} tab${tabs === 1 ? '' : 's'} shows a watched app: open the app in it.`

  return { browser: { at: now, note, pages }, isReached: true, raws }
}

/** Where what the Renders view shows is read from, or why there is nothing: a line per page, for one app or all. */
export const describeBrowser = ({ note, pages }: Browser, labels: readonly string[]): string[] => {
  const shown = pages.filter(({ label }) => labels.includes(label))

  if (shown.length === 0) return [note === '' ? 'No tab of the browser shows this app.' : note]

  return shown.map(({ label, address, title, note: why }) => `${label}: read from the tab ${title === '' ? '' : `"${title}" `}at ${address}${why === '' ? '' : ` (${why})`}`)
}
