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

/** A topic of a broker, its partitions as one. */
export type Topic = {
  name: string
  /** The records each partition holds now, by its number: what was written to it less what it no longer keeps. */
  sizes: number[]
  /** How many records were ever written to it: its partitions' end offsets, added up. */
  end: number
}

/** Where a consumer group stands on one partition it reads. */
export type GroupPartition = {
  topic: string
  partition: number
  /** The offset the group has marked as read; -1 when it has marked none. */
  offset: number
  /** The partition's end offset: where the next record written will stand. */
  end: number
  /** How many records wait to be read. */
  lag: number
}

/** A consumer group of a broker: who reads its topics, and how far behind. */
export type Group = {
  name: string
  /** As the broker says it: `Stable`, `Empty`, `PreparingRebalance`, `CompletingRebalance`, `Dead`. */
  state: string
  members: number
  /** How many records wait to be read, over all its partitions. */
  lag: number
  partitions: GroupPartition[]
  /** The offsets it has marked as read, added up: it moves when the group takes a record. */
  taken: number
  /** When `taken` last moved, or when the group was first read. */
  movedAt: number
}

/** What a broker holds, as its own command line says it: an attachment that is one has it among its facts. */
export type Broker = {
  /** What it is, told by its image. A `kafka` is known for one and not read: only Redpanda's `rpk` is asked. */
  kind: 'redpanda' | 'kafka'
  /** When it was last asked, milliseconds since the epoch. */
  at: number
  /** Why there is nothing to say, or what could not be read; empty otherwise. */
  note: string
  topics: Topic[]
  groups: Group[]
  /** Each group's lag when the last edit was routed to any watched app, by the group's name. */
  lagAtEdit?: Record<string, number>
  /** The file of that edit, and when it was. */
  editedPath?: string
  editedAt?: number
}

/** One record of a topic as it is shown: the secrets out of its key, its headers and its value. */
export type BrokerRecord = {
  partition: number
  offset: number
  /** When it was written, milliseconds since the epoch. */
  at: number
  key: string
  /** Its headers as `name=value`, parted by spaces. */
  headers: string
  value: string
}

/** The topic the pane's Broker view is open on, and its last records as they were last read. */
export type Peek = {
  /** The broker's label and the topic's name; both empty while no topic is open. */
  label: string
  topic: string
  /** When the records were read, milliseconds since the epoch. */
  at: number
  /** Why there is no record to show; empty when there are some. */
  note: string
  records: BrokerRecord[]
}

/** One client's session on a database, as the database says it. */
export type DbSession = {
  pid: number
  user: string
  /** The name the client gave itself, where it gave one: `gondor`, `psql`. */
  app: string
  /** As the database says it: `active`, `idle`, `idle in transaction`, `idle in transaction (aborted)`. */
  state: string
  /** What kind of thing it waits for, where it waits: `Lock`, `Client`, `IO`. */
  wait: string
  /** The sessions that hold a lock it waits for, by pid; none for one that waits for no lock. */
  blockers: number[]
  /** How long it has been in its state, in seconds. */
  seconds: number
  /** Its last statement, the secrets taken out, cut to a line. */
  query: string
}

/** A table of a database, with what the database counted of it. */
export type DbTable = {
  /** Its name, led by its schema where that is not `public`. */
  name: string
  /** How many rows it holds, as the database last counted: near the truth, not it. */
  rows: number
  /** The rows deleted or rewritten whose room is not taken back yet. */
  dead: number
  /** What it takes on disk, its indexes with it. */
  bytes: number
  /** How often it was read whole, and how often through an index. */
  scans: number
  lookups: number
  /** The rows ever inserted, updated and deleted, added up. */
  written: number
}

/** What a database holds, as its own command line says it: an attachment that is one has it among its facts. */
export type Database = {
  /** What it is, told by its image. Only PostgreSQL's `psql` is asked. */
  engine: 'postgresql'
  /** When it was last asked, milliseconds since the epoch. */
  at: number
  /** Why there is nothing to say, or what could not be read; empty otherwise. */
  note: string
  /** The one database read, which the image was started with; empty until it has answered once. */
  name: string
  version: string
  bytes: number
  /** How many sessions it lets in at once. */
  max: number
  /** Its clients' sessions on that database, palantir's own left out. */
  sessions: DbSession[]
  tables: DbTable[]
}

/** The table the pane's Database view is open on, and its last rows as they were last read. */
export type Rows = {
  /** The database's label and the table's name; both empty while no table is open. */
  label: string
  table: string
  /** When the rows were read, milliseconds since the epoch. */
  at: number
  /** Why there is no row to show; empty when there are some. */
  note: string
  /** Each row as one JSON object, the secrets taken out, oldest first. */
  rows: string[]
}

/**
 * What an attachment is, told by the image it runs: a broker, a database, or an app, which is anything else and
 * what a log file is taken for.
 */
export type Kind = 'app' | 'broker' | 'database'

/** What palantir knows of an attachment besides what it wrote. */
export type Facts = {
  /** What it is; none until its status has been read, and it is shown among the apps till then. */
  kind?: Kind
  /** What it runs, for a broker or a database: `Redpanda`, `Kafka`, `PostgreSQL`. */
  engine?: string
  env: EnvVar[]
  /** What the list is read from, or why it is empty. */
  envNote: string
  usage: Usage
  /** What it holds, when it is a broker; none for anything else. */
  broker?: Broker
  /** What it holds, when it is a database palantir reads; none for anything else. */
  database?: Database
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
  /** What tells one run of it from the next (when its container started, the revision of its workload): a change is a rollout. Empty where nothing says. */
  started?: string
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
  /** When it first showed; one held from before this was kept has none. */
  firstAt?: number
  /** Whether Claude has been told it is new, so it is handed over once. */
  isTold?: boolean
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
  /** When the person or Claude last set a mark on it: what first shows from then on is new since the mark. */
  markedAt?: number
  /** When it was last seen to start over: a restart, or a rollout of a new revision. */
  rolledAt?: number
}

/** What an error is new since: the last edit routed to its app, the last mark set, or the app's last start. */
export type Baseline = 'edit' | 'mark' | 'start'

/** The last figures read of an attachment, oldest first, which its row draws as a line: -1 where one was not known. */
export type History = { cpu: number[]; memory: number[]; lag: number[] }

/** What was planned in a project, kept from one session to the next. */
export type Plans = { scenarios: Scenario[]; suites: Suite[] }

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

/** One test of a suite, as the suite's command printed it. */
export type Case = {
  /** Its name as it was printed, the file it is in first. */
  name: string
  state: 'passed' | 'failed' | 'skipped'
  /** How long it took, when the command said; 0 otherwise. */
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
  /** The tests it ran, read off what it printed, a line a test; none until it has run, or when it names none. */
  tests?: Case[]
  /** When it was started, milliseconds since the epoch; 0 before. */
  at: number
  /** How long it ran; 0 until it has ended. */
  ms: number
}

/** What the Tests view shows: the end-to-end checklist, or the unit test suites. */
export type TestsAs = 'e2e' | 'unit'

/** What the pane shows under the table. */
export type Shown = 'logs' | 'errors' | 'env' | 'renders' | 'tests' | 'broker' | 'database'

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
      /** The topic the Broker view is open on, with its last records. */
      peek: Peek
      /** The table the Database view is open on, with its last rows. */
      rows: Rows
      /** By attachment label. */
      history: Record<string, History>
      /** What the Errors view counts an error as new since. */
      since: Baseline
      /** The error kind the Errors view is open on, as its app's label, a line break, and its key; empty for none. */
      openError: string
      /** The text the timeline's lines must hold; empty for every line. */
      grep: string
      /** The request id the timeline follows across the apps; empty for none. */
      traced: string
      /** When the timeline was paused, milliseconds since the epoch: lines written after are not drawn. 0 while it runs. */
      pausedAt: number
      /** Whether the timeline shows the health checks too, and every repeat of a line. */
      isNoisy: boolean
      /** Whether each view says how it is read. */
      isHelped: boolean
      /** Whether Claude is asked to look at once when an edit brings new errors and no turn runs: empty until the person says in the pane, and the option decides till then. */
      guarding: '' | 'on' | 'off'
    }
  }
}
