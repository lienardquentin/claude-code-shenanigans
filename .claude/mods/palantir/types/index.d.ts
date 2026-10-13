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
  lastAt: number
}

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
export type Dom = { at: number; url: string; title: string; elements: DomElement[]; left: number }

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
  /** The raw lines that carry that timestamp, which the runtime hands over again. */
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
}

/** What the Renders view shows: the tree of what made each component render, or the page's own elements. */
export type RendersAs = 'tree' | 'dom'

/** What the pane shows under the table. */
export type Shown = 'logs' | 'env' | 'renders'

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
    }
  }
}
