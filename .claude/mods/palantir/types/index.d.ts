/** Where an attachment runs, which is the command line it is read through (none for `local`: a file is read). */
export type RuntimeId = 'local' | 'docker' | 'compose' | 'kubernetes'

/** One thing palantir watches: a frontend, a backend, a broker. A session holds several. */
export type Attachment = {
  /** The name the person gave it, unique in the session: what the pane, the tools and the filter call it. */
  label: string
  runtime: RuntimeId
  /** What the runtime calls it: a log file's path, a container, a compose service, `[context/]namespace/kind/name`. */
  ref: string
  /** The source folders whose edits count against it, absolute, forward slashes; none means every edit does. */
  roots: string[]
  /** For a log file: the port its process listens on, which is how the process is found; 0 when none is named. */
  port: number
}

/** One variable of an app's environment, its value with the secrets taken out. */
export type EnvVar = {
  name: string
  /** Empty when the value is set where palantir does not look: a secret, a config map. */
  value: string
  /** Where it is set: `container`, `compose`, `api/.env`, `secret db/password`. */
  from: string
}

/** What an app consumes, as its runtime measures it. */
export type Usage = {
  /** Percent of one core; -1 while not known. */
  cpu: number
  /** Bytes of memory held; -1 while not known. */
  memory: number
  /** The memory it may hold, in bytes; 0 when it has no limit or none is known. */
  limit: number
  /** How many processes (containers, pods) the figures add up; 0 when not known. */
  processes: number
  /** For a local process: the processor seconds it had used at `at`, which the next read measures from. */
  cpuSeconds: number
  at: number
  /** Why there is no figure; empty when there is one. */
  note: string
}

/** What palantir knows of an attachment besides what it wrote. */
export type Facts = {
  env: EnvVar[]
  /** What the list is read from, or why it is empty. */
  envNote: string
  usage: Usage
}

/** One way a component came to render again: what changed, through what, down to the component. */
export type Render = {
  component: string
  /** The steps, the cause first: `beacons (ref) set`, `litCount (computed)`, `BeaconChain`. */
  chain: string[]
  /** What each step held the last time, one for one with the chain: `3 (was 2)`; empty where it was not said. */
  values?: string[]
  /** The same values whole, as JSON text, where the short one leaves some of it out; empty elsewhere. */
  whole?: string[]
  count: number
  /** How many renders of what the chain's last component is made of (a library's own parts) came with those. */
  inside?: number
  lastAt: number
  /** When it was first counted; a chain held from before this was kept has none. */
  firstAt?: number
  /** How many of them came in a report whose values were those of the report before: rendered, with nothing it holds changed. */
  same?: number
  /** What its values were in the last report, as one text, which the next is held against. */
  valuesKey?: string
  /** How many edits had been routed to the app when the chain first showed: equal to `Watch.edits`, it is new. */
  edit?: number
  /** Its count when the last edit was routed to the app: what it has rendered since is counted from there. */
  countAtEdit?: number
  /** The source file of the component the renders belong to, as the page names it; empty where it does not. */
  file?: string
}

/** Something the person did on a page, and what followed within a second and a half. */
export type Action = {
  at: number
  /** `click`, `submit`, `change`, `navigate`. */
  kind: string
  /** What it was done to, never what a field holds: `button "Light Halifirien"`, `/muster`. */
  what: string
  /** The component of the app's own it was done in; empty where none is known. */
  component: string
  /** How many times each component rendered after it, the busiest first: `BeaconChain ×8`. */
  renders: string[]
  /** What the page asked for after it: `200 /api/realm/beacons 41ms`. */
  requests: string[]
}

/** What a page asked of one address, added up. */
export type Request = {
  /** The path, with the names of what it was asked with and none of their values: `/api/realm/beacons?lit`. */
  url: string
  count: number
  /** How many got no answer, or one of 400 and over. */
  failed: number
  totalMs: number
  maxMs: number
  /** The last answer's status; 0 when there was none, -1 when the browser does not tell it (another site's). */
  lastStatus: number
  lastAt: number
  /** Its count and its time when the last edit was routed to the app. */
  countAtEdit?: number
  totalMsAtEdit?: number
}

/** How a page loaded and how it answers the hand, as the browser measures it. Milliseconds; 0 where not measured. */
export type Vitals = {
  /** When the page was loaded, milliseconds since the epoch: figures of another load are another page's. */
  loadedAt: number
  /** Until the server's first byte. */
  ttfb: number
  /** Until the largest thing on the page was painted. */
  lcp: number
  /** Until the page had loaded. */
  load: number
  /** How much the page's layout moved by itself: a score, not a time. */
  cls: number
  /** The slowest answer to a click or a key. */
  inp: number
  /** How many tasks held the page for over 50 ms, and for how long in all. */
  longTasks: number
  longMs: number
}

/** Something on a page that a reader who does not see it cannot use: what is wrong, the element, its component. */
export type DomIssue = { kind: string; tag: string; component: string }

/** One element of a page: how deep it is nested, what it is, what it is to a reader, and the text it holds itself. */
export type DomElement = {
  depth: number
  /** Its tag with its id and first classes: `main#app.grid`. */
  tag: string
  /** What says what it is or how it stands: `role="button" aria-pressed="true" disabled`. */
  attributes: string
  text: string
  /** The component of the app's own it is the outermost element of; empty for any other. */
  component: string
}

/** A page as its frontend last reported it: its elements from the top down, each after the one that holds it. */
export type Dom = {
  at: number
  url: string
  title: string
  elements: DomElement[]
  left: number
  /** What a reader who does not see the page cannot use; a page held from before these were read has none. */
  issues?: DomIssue[]
  /** The source file of each component of the app's own on the page, by its name. */
  files?: Record<string, string>
}

export type Level = 'info' | 'warn' | 'error'

export type Line = {
  /** Milliseconds since the epoch: the line's own time where it carries one, else when it was read. */
  at: number
  level: Level
  /** Secrets already taken out. */
  message: string
  /** The lines folded under it: a stack trace's frames. */
  more: number
}

export type Health = {
  state: 'up' | 'degraded' | 'down' | 'unknown'
  /** Why, in a few words: `exited (137)`, `2/3 ready`, `CrashLoopBackOff`. */
  detail: string
  restarts: number
}

/** The errors that are one error: the same message once its numbers and ids are taken out. */
export type Signature = {
  key: string
  /** The first message seen with it. */
  sample: string
  count: number
  lastAt: number
  /** How many edits had been routed to the attachment when it first showed: equal to `Watch.edits`, it is new. */
  edit: number
  /** Whether the person has been told it is new, so one toast says it. */
  isAnnounced: boolean
}

/** Where the last read stopped, so the next one takes only what came after. */
export type Cursor = {
  /** The last line's timestamp as the runtime wrote it; empty before the first read. */
  since: string
  /** The raw lines that carry that timestamp, which the runtime hands over again. For a file: the last line read. */
  seen: string[]
  /** For a file: how many characters of it are read. */
  offset: number
}

/** What palantir holds of one attachment. */
export type Watch = {
  cursor: Cursor
  lines: Line[]
  signatures: Signature[]
  health: Health
  /** How many edits were routed to it in this session. */
  edits: number
  /** The file of the last of them; empty before the first. */
  editedPath: string
  /** Why the last read failed; empty when it did not. */
  error: string
  /** The renders its frontend reported in its log, each chain once with its count. */
  renders: Render[]
  /** The page its frontend last reported in its log; none until it has. */
  dom?: Dom
  /** When the last edit was routed to it; none before the first. */
  editedAt?: number
  /** What the person last did on its page, oldest first. */
  actions?: Action[]
  /** What its page asked for, each address once. */
  requests?: Request[]
  /** How its page last loaded and answers. */
  vitals?: Vitals
  /** The same as it stood when the last edit was routed to it. */
  vitalsAtEdit?: Vitals
}

/** A tab of the browser that shows a watched app. */
export type BrowserPage = {
  /** The attachment it is the page of. */
  label: string
  address: string
  title: string
  /** Why it says no render, when it cannot: no Vue app, or a production build; empty otherwise. */
  note: string
}

/** What came of the last asking of the browser's tabs. */
export type Browser = {
  /** When it was asked, milliseconds since the epoch; 0 before the first asking. */
  at: number
  /** Why no tab shows a watched app; empty when one does. */
  note: string
  pages: BrowserPage[]
}

/**
 * What the Renders view shows: the tree of what made each component render, the page's own elements, what the
 * person did on the page and what followed, or what the page asked for and how it loaded.
 */
export type RendersAs = 'tree' | 'dom' | 'actions' | 'network'

/** How a scenario of the end-to-end checklist stands: `blocked` is one that could not be tried at all. */
export type ScenarioState = 'todo' | 'queued' | 'running' | 'passed' | 'failed' | 'blocked'

/** One thing a person does on a frontend, checked on its page by a subagent of its own. */
export type Scenario = {
  /** Its number in the checklist, which the tools and the pane name it by. */
  id: string
  name: string
  /** The label of the attachment whose page it is done on; empty when nothing is watched. */
  target: string
  /** What is done, in order, as a person would do it. */
  steps: string[]
  /** What must be seen at the end for it to pass; empty when doing the steps is all. */
  expect: string
  state: ScenarioState
  /** Why it failed or could not be tried, in a line; empty otherwise. */
  note: string
  /** The end of what its subagent answered; empty until it has. */
  report: string
  /** The subagent that runs it; empty while none does. */
  agentId: string
  /** When its subagent was started, milliseconds since the epoch; 0 before. */
  at: number
  /** How long its subagent took; 0 until it has answered. */
  ms: number
}

/** One unit test suite of the project: a command, read by how it exits. */
export type Suite = {
  /** Its number in the list, which the tools and the pane name it by. */
  id: string
  name: string
  /** The label of the attachment it tests; empty when it is of none. */
  target: string
  /** The command, as an argument vector: no shell reads it. */
  argv: string[]
  /** The folder it runs in, from the project's or absolute; empty for the project's own. */
  cwd: string
  state: ScenarioState
  /** Why it failed or did not run, in a line; empty otherwise. */
  note: string
  /** The end of what it printed; empty until it has run. */
  output: string
  /** When it was started, milliseconds since the epoch; 0 before. */
  at: number
  /** How long it ran; 0 until it has ended. */
  ms: number
}

/** What the Tests view shows: the end-to-end checklist, or the unit test suites. */
export type TestsAs = 'e2e' | 'unit'

/** What the pane shows under the table. */
export type Shown = 'logs' | 'env' | 'renders' | 'tests'

declare module 'claude-code' {
  interface PluginState {
    palantir: {
      attachments: Attachment[]
      /** Whether the compose file, the project's file and the option have been read in this session. */
      isDiscovered: boolean
      /** By attachment label. */
      watches: Record<string, Watch>
      /** The one attachment the timeline shows; empty for all of them. */
      only: string
      /** Whether the timeline shows errors alone. */
      isErrorsOnly: boolean
      /** When the attachments were last read, milliseconds since the epoch; 0 before the first read. */
      checkedAt: number
      /** By attachment label. */
      facts: Record<string, Facts>
      shown: Shown
      /** The rows of the Renders tree that are open on what they hold whole, each by its app and its steps. */
      opened: string[]
      rendersAs: RendersAs
      /** The tabs the renders and the pages were last read from. */
      browser: Browser
      /** The folder the session started in, which the project's file is read from; empty until it is first asked. */
      home: string
      /** The end-to-end checklist, in the order it was planned. */
      scenarios: Scenario[]
      /** The unit test suites, in the order they were named. */
      suites: Suite[]
      testsAs: TestsAs
    }
  }
}
