import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Attachment, Browser, Cursor, EnvVar, Facts, Health, RendersAs, Shown, Usage, Watch } from '../types'
import { composeAttachments, merged, parseList, PROJECT_FILE, routed, shown, tidy, under } from './attach'
import { askArgv, DEBUG_PORT, describeBrowser, EMPTY_BROWSER, readAsked } from './browser'
import type { Asked as Told } from './browser'
import { actionLabel } from './kit/action-label'
import { badge } from './kit/badge'
import { card } from './kit/card'
import { divider } from './kit/divider'
import { logLines } from './kit/log-lines'
import { paneView } from './kit/pane-text'
import { table } from './kit/table'
import type { TableCell } from './kit/table'
import { tonedText } from './kit/toned-text'
import { tree } from './kit/tree'
import { clockTime, EMPTY_WATCH, fresh } from './lines'
import { ENV_FILES, isWindows, LISTENERS_ARGV, LOCAL_ENV_NOTE, localUsage, PROCESSES_ARGV, readEnvFile, readUnixProbe, readWindowsProbe, WINDOWS_PROBE_ARGV } from './local'
import type { Probe } from './local'
import { cpuText, domTree, EMPTY_FACTS, EMPTY_USAGE, envText, errorsText, HOW_TO_ATTACH, HOW_TO_READ_DOM, HOW_TO_READ_RENDERS, HOW_TO_REPORT_DOM, HOW_TO_REPORT_RENDERS, logsText, memoryText, renderTree, rendersText, statusText, timeline, usageText } from './report'
import type { LogsAsk } from './report'
import {
  COMPOSE_CONFIG_ARGV,
  COMPOSE_FILES,
  composeEnv,
  containersOf,
  ENV_NOTE,
  fileHealth,
  logsArgv,
  readEnv,
  readHealth,
  readStats,
  readTop,
  RUNTIME_NAME,
  statsArgv,
  statusArgv,
  summed,
  topArgv,
} from './runtime'
import type { Measure } from './runtime'
import { endArgv, firstLine, kept, marked, settle, TAIL, takeFile, takePrinted } from './watch'
import type { Taken } from './watch'

const PANE = 'palantir'
const TITLE = 'palantir'
const READ_TIMEOUT_MS = 8_000
// What the apps consume is asked of the machine less often than what they wrote: the asking is itself not free
const USAGE_EVERY_MS = 15_000
// A browser that did not answer is asked again by the timer this far apart, and at once by whoever asks
const BROWSER_AGAIN_MS = 30_000

const attachments = atom({ plugin: 'palantir', key: 'attachments' } as const, [] as Attachment[])
const isDiscovered = atom({ plugin: 'palantir', key: 'isDiscovered' } as const, false)
const watches = atom({ plugin: 'palantir', key: 'watches' } as const, {} as Record<string, Watch>)
const only = atom({ plugin: 'palantir', key: 'only' } as const, '')
const isErrorsOnly = atom({ plugin: 'palantir', key: 'isErrorsOnly' } as const, false)
const checkedAt = atom({ plugin: 'palantir', key: 'checkedAt' } as const, 0)
const facts = atom({ plugin: 'palantir', key: 'facts' } as const, {} as Record<string, Facts>)
const shownView = atom({ plugin: 'palantir', key: 'shown' } as const, 'logs' as Shown)
const opened = atom({ plugin: 'palantir', key: 'opened' } as const, [] as string[])
const rendersAs = atom({ plugin: 'palantir', key: 'rendersAs' } as const, 'tree' as RendersAs)
const browser = atom({ plugin: 'palantir', key: 'browser' } as const, EMPTY_BROWSER as Browser)

// What the pane last drew, for the model to read: it sees nothing of a pane otherwise
const view = paneView({ id: PANE, title: TITLE, command: '/palantir' })

const TONE = { up: 'success', degraded: 'warning', down: 'danger', unknown: 'neutral' } as const satisfies Record<Health['state'], string>

const TOOLS = [
  {
    name: 'status',
    description:
      'How the running apps this session watches stand right now (a frontend, a backend, a broker; local, Docker, Compose or Kubernetes): up or down and why, restarts, error counts, and how many errors are new since the last edit to their source. Reads them afresh. Call it to know whether what runs is healthy.',
  },
  {
    name: 'logs',
    description:
      "The last log lines of the running apps this session watches, as one timeline across them, each line with its time, its app and its level, secrets taken out. Reads them afresh. Call it instead of asking the person to paste logs: to see what an app wrote, to follow an error across the frontend and the backend, or to search the logs for a word.",
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'The label of one watched app; left out, all of them.' },
        level: { type: 'string', enum: ['info', 'warn', 'error'], description: 'The lowest level to show; info when left out.' },
        grep: { type: 'string', description: 'Only the lines whose message holds this text, whatever its case.' },
        limit: { type: 'number', description: 'How many of the last matching lines; 50 when left out, 200 at most.' },
      },
    },
  },
  {
    name: 'errors_since_edit',
    description:
      'The errors a running app started writing after the last edit to its source in this session, each kind once with its count: what the edit broke, apart from what was already wrong. Reads the apps afresh. Call it after editing the code of a watched app, once the app has had the time to reload, and before saying the change works.',
    inputSchema: {
      type: 'object',
      properties: { target: { type: 'string', description: 'The label of one watched app; left out, all of them.' } },
    },
  },
  {
    name: 'resources',
    description:
      'What the running apps this session watches consume right now: processor share (of one core) and memory, against its limit where there is one, as Docker, the cluster or the machine measures them. Reads them afresh. Call it when an app is slow, restarts, or may be leaking, and before and after a change meant to make it lighter. A local app is measured through the port it listens on, with the processes it started; its processor share needs two reads.',
    inputSchema: {
      type: 'object',
      properties: { target: { type: 'string', description: 'The label of one watched app; left out, all of them.' } },
    },
  },
  {
    name: 'env',
    description:
      "The environment variables of the running apps this session watches, each with where it is set, secrets taken out: a container's own, a compose service's as compose resolves it, a Kubernetes workload's as its spec sets it, and for a local app the env files of its source. Reads them afresh. Call it instead of asking the person what an app is configured with: which URL it calls, which mode it runs in, whether a variable is set at all.",
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'The label of one watched app; left out, all of them.' },
        grep: { type: 'string', description: 'Only the variables whose name holds this text, whatever its case.' },
      },
    },
  },
  {
    name: 'renders',
    description:
      "Why the components of a watched frontend rendered again, as the browser itself says it: each reactivity chain once, with its count, from the state that changed, through the computed values and the props that carried it, down to the component. Asks the tabs of the Chrome that listens on its debug port afresh; nothing is added to the app. Call it when a page flickers, is slow, or renders more than it should, and to see what a change of state reaches. Only a Vue app in development, open in that Chrome, has any; the answer says so when there is none.",
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'The label of one watched app; left out, all of them.' },
        component: { type: 'string', description: 'Only the components whose name holds this text, whatever its case.' },
      },
    },
  },
] as const

// The timer that reads the attachments while there are some. A reload drops it with the module, and the next ask
// starts it again.
let ticking: { cancel: () => void } | undefined

// One thing at a time: two reads of one attachment would both take the lines past the same cursor. A reload
// starts the queue over, with nothing in flight.
let queue: Promise<unknown> = Promise.resolve()

const inTurn = <T,>(work: () => Promise<T>): Promise<T> => {
  const ran = queue.then(work, work)

  queue = ran.catch(() => undefined)

  return ran
}

/**
 * Reads what the session watches: the compose project's services, then the project's own file, then the option,
 * a later one taking the place of an earlier one of the same label. The watch of an attachment that is gone goes.
 */
const discover = ($: EngineInterface, asked: unknown): Promise<Attachment[]> =>
  inTurn(async () => {
    const cwd = tidy(await $.session.cwd())
    const composeFiles = await Promise.all(COMPOSE_FILES.map(file => $.fs.exists(`${cwd}/${file}`).catch(() => false)))
    // Docker is asked only in a project that has a compose file
    const project = composeFiles.some(Boolean) ? await $.process.run(COMPOSE_CONFIG_ARGV, { timeoutMs: 15_000 }).catch(() => undefined) : undefined
    const listed = await $.fs.read(`${cwd}/${PROJECT_FILE}`).catch(() => '')

    const found = merged(
      project?.exitCode === 0 ? composeAttachments(project.stdout, cwd) : [],
      parseList(typeof listed === 'string' ? listed : '', cwd),
      parseList(typeof asked === 'string' ? asked : '', cwd),
    )

    await update($, attachments, () => found)
    await update($, watches, held => kept(held, found))
    await update($, facts, held => Object.fromEntries(found.flatMap(({ label }) => (held[label] === undefined ? [] : [[label, held[label]] as const]))))
    await update($, only, label => (found.some(attachment => attachment.label === label) ? label : ''))
    await update($, isDiscovered, () => true)

    return found
  })

// The attachments, discovered on the first ask of a session and held after
const ensure = async ($: EngineInterface, asked: unknown): Promise<Attachment[]> =>
  (await read($, isDiscovered)) ? read($, attachments) : discover($, asked)

const take = async ($: EngineInterface, attachment: Attachment, cursor: Cursor): Promise<Taken> => {
  if (attachment.runtime === 'local') {
    const text = await $.fs.read(attachment.ref).catch(async (failure: unknown) => {
      // Too large to be read whole: its end is asked of the machine
      if (!/limit/i.test(failure instanceof Error ? failure.message : String(failure))) throw failure

      const ended = await $.process.run(endArgv(attachment.ref), { timeoutMs: READ_TIMEOUT_MS }).catch(() => undefined)

      if (ended?.exitCode !== 0) throw failure

      return { end: ended.stdout }
    })

    if (typeof text === 'object' && text !== null && 'end' in text) return takeFile(text.end, cursor, true)
    if (typeof text !== 'string') throw new Error('no such file')

    return takeFile(text, cursor)
  }

  const argv = logsArgv(attachment, cursor.since, TAIL)

  if (argv === undefined) return { raws: [], cursor, error: `${attachment.ref} names no workload` }

  const ran = await $.process.run(argv, { timeoutMs: READ_TIMEOUT_MS })

  if (ran.exitCode !== 0) return { raws: [], cursor, error: firstLine(ran.stderr) || `${argv[0]} exited with ${ran.exitCode}` }

  return takePrinted(attachment.runtime, ran, cursor)
}

/** How an attachment stands, and what its status command printed: its environment and its containers are read off that too. */
type Stand = { health: Health; printed: string }

const standOf = async ($: EngineInterface, attachment: Attachment, now: number): Promise<Stand> => {
  if (attachment.runtime === 'local') {
    return { health: fileHealth(await $.fs.stat(attachment.ref).then(stat => (stat.kind === 'file' ? stat.mtimeMs : undefined), () => undefined), now), printed: '' }
  }

  const argv = statusArgv(attachment)

  if (argv === undefined) return { health: { state: 'unknown', detail: '', restarts: 0 }, printed: '' }

  const ran = await $.process.run(argv, { timeoutMs: READ_TIMEOUT_MS }).catch(() => undefined)

  if (ran === undefined) return { health: { state: 'unknown', detail: `${argv[0]} did not answer`, restarts: 0 }, printed: '' }

  if (ran.exitCode !== 0) {
    return { health: { state: 'down', detail: /no such|not ?found/i.test(ran.stderr) ? 'not found' : firstLine(ran.stderr).slice(0, 40), restarts: 0 }, printed: '' }
  }

  return { health: readHealth(attachment.runtime, ran.stdout), printed: ran.stdout }
}

type Seen = { attachment: Attachment; printed: string }
type Ran = Awaited<ReturnType<EngineInterface['process']['run']>> | undefined

const ask = ($: EngineInterface, argv: readonly string[]): Promise<Ran> => $.process.run(argv, { timeoutMs: READ_TIMEOUT_MS }).catch(() => undefined)

const refusal = (ran: Ran, command: string): string => (ran === undefined ? `${command} did not answer` : firstLine(ran.stderr).slice(0, 80) || `${command} exited with ${ran.exitCode}`)

const measured = (measure: Measure | undefined, why: string, now: number): Usage =>
  measure === undefined ? { ...EMPTY_USAGE, at: now, note: why } : { ...measure, cpuSeconds: 0, at: now, note: '' }

// Who listens where and every process, asked once for all the local apps
const probe = async ($: EngineInterface, cwd: string): Promise<Probe | string> => {
  if (isWindows(cwd)) {
    const ran = await ask($, WINDOWS_PROBE_ARGV)

    return ran?.exitCode === 0 ? readWindowsProbe(ran.stdout) : refusal(ran, WINDOWS_PROBE_ARGV[0])
  }

  const [listening, processes] = await Promise.all([ask($, LISTENERS_ARGV), ask($, PROCESSES_ARGV)])

  // `lsof` exits with 1 when nothing listens at all, having printed nothing
  if (listening === undefined || (listening.exitCode !== 0 && listening.stdout.trim() === '' && listening.stderr.trim() !== '')) return refusal(listening, LISTENERS_ARGV[0])
  if (processes?.exitCode !== 0) return refusal(processes, PROCESSES_ARGV[0])

  return readUnixProbe(listening.stdout, processes.stdout)
}

/**
 * What each attachment consumes, by label: the containers asked of Docker in one command, each workload's pods of
 * the cluster's metrics, the local apps of the machine in one probe. What cannot be measured says why.
 */
const usagesOf = async ($: EngineInterface, seen: readonly Seen[], known: Record<string, Facts>, now: number): Promise<Record<string, Usage>> => {
  const contained = seen.filter(({ attachment }) => attachment.runtime === 'docker' || attachment.runtime === 'compose')
  const workloads = seen.filter(({ attachment }) => attachment.runtime === 'kubernetes')
  const locals = seen.filter(({ attachment }) => attachment.runtime === 'local')

  const ofContainers = async (): Promise<(readonly [string, Usage])[]> => {
    const names = [...new Set(contained.flatMap(({ attachment, printed }) => containersOf(attachment, printed)))]
    const ran = names.length === 0 ? undefined : await ask($, statsArgv(names))
    const stats = ran?.exitCode === 0 ? readStats(ran.stdout) : {}

    return contained.map(({ attachment, printed }) => {
      const own = containersOf(attachment, printed)
      const why = own.length === 0 ? 'not running' : ran?.exitCode === 0 ? `${RUNTIME_NAME.docker} has no figure for it` : refusal(ran, statsArgv([])[0] ?? '')

      return [attachment.label, measured(summed(own.flatMap(name => stats[name] ?? [])), why, now)] as const
    })
  }

  const ofWorkloads = (): Promise<(readonly [string, Usage])[]> =>
    Promise.all(
      workloads.map(async ({ attachment, printed }) => {
        const argv = topArgv(attachment, printed)

        if (argv === undefined) return [attachment.label, measured(undefined, 'no pod to measure', now)] as const

        const ran = await ask($, argv)

        return [attachment.label, measured(ran?.exitCode === 0 ? readTop(ran.stdout, printed) : undefined, ran?.exitCode === 0 ? 'no pod to measure' : refusal(ran, argv[0] ?? ''), now)] as const
      }),
    )

  const ofLocals = async (): Promise<(readonly [string, Usage])[]> => {
    const found = locals.some(({ attachment }) => attachment.port > 0) ? await probe($, await $.session.cwd()) : undefined

    return locals.map(({ attachment: { label, port } }) => {
      if (!(port > 0)) return [label, measured(undefined, `no port named: end its line in ${PROJECT_FILE} with #<port>`, now)] as const
      if (found === undefined || typeof found === 'string') return [label, measured(undefined, found ?? 'not asked', now)] as const

      return [label, localUsage(found, port, known[label]?.usage, now)] as const
    })
  }

  return Object.fromEntries((await Promise.all([ofContainers(), ofWorkloads(), ofLocals()])).flat())
}

type Environment = Pick<Facts, 'env' | 'envNote'>

/**
 * Each attachment's environment, by label. A container's and a workload's are in what their status command printed.
 * A compose service's and a local app's take reads of their own, made only when the environment is asked for.
 */
const envsOf = async ($: EngineInterface, seen: readonly Seen[], isAsked: boolean): Promise<Record<string, Environment>> => {
  const cwd = tidy(await $.session.cwd())
  const services = seen.filter(({ attachment }) => attachment.runtime === 'compose')
  const resolved = isAsked && services.length > 0 ? await $.process.run(COMPOSE_CONFIG_ARGV, { timeoutMs: 15_000 }).catch(() => undefined) : undefined

  const ofFiles = async ({ roots }: Attachment): Promise<Environment> => {
    const folders = roots.length > 0 ? roots : [cwd]
    const paths = folders.flatMap(folder => ENV_FILES.map(file => under(folder, file)))
    const texts = await Promise.all(paths.map(path => $.fs.read(path).catch(() => undefined)))
    const byName = new Map<string, EnvVar>()

    texts.forEach((text, index) => {
      if (typeof text === 'string') for (const variable of readEnvFile(text, shown(paths[index] ?? '', cwd))) byName.set(variable.name, variable)
    })

    return { env: [...byName.values()], envNote: `${LOCAL_ENV_NOTE}${byName.size === 0 ? ` No env file under ${folders.map(folder => (folder === cwd ? 'the working directory' : shown(folder, cwd))).join(', ')}.` : ''}` }
  }

  const found = await Promise.all(
    seen.map(async ({ attachment, printed }): Promise<(readonly [string, Environment])[]> => {
      const { label, runtime, ref } = attachment

      if (runtime === 'local') return isAsked ? [[label, await ofFiles(attachment)]] : []
      if (runtime === 'compose') return resolved === undefined ? [] : [[label, resolved.exitCode === 0 ? { env: composeEnv(resolved.stdout, ref), envNote: ENV_NOTE.compose } : { env: [], envNote: `Could not be read: ${refusal(resolved, COMPOSE_CONFIG_ARGV[0])}.` }]]

      // An attachment that did not answer keeps the environment it last showed
      return printed === '' ? [] : [[label, { env: readEnv(runtime, printed) ?? [], envNote: ENV_NOTE[runtime] }]]
    }),
  )

  return Object.fromEntries(found.flat())
}

/**
 * What a read asks for besides the lines and the state: what the apps consume, the environments that take a read
 * of their own, and what the browser says of the frontends, asked on the debug port named (0 or none: not asked).
 */
type Want = { usage: boolean; env: boolean; browser?: number }

const LINES_ONLY: Want = { usage: false, env: false }

// When what the apps consume was last asked. A reload starts it over, and the next tick asks.
let usageReadAt = 0

// When the browser was last asked, and whether it answered. A reload starts both over, and the next tick asks.
let browserAskedAt = 0
let isBrowserReached = true

const askBrowser = async ($: EngineInterface, list: readonly Attachment[], port: number, now: number): Promise<Told> =>
  readAsked(await $.process.run(askArgv(tidy($.plugin.root), port, list), { timeoutMs: READ_TIMEOUT_MS }).catch(() => undefined), list, port, now)

/**
 * Reads the attachments (those labelled, or all): what each wrote since its last read, and how it stands. The
 * person is told once when one goes down, and once of each error that is new since the last edit routed to it.
 */
const pull = ($: EngineInterface, labels?: readonly string[], want: Want = LINES_ONLY): Promise<void> =>
  inTurn(async () => {
    const targets = (await read($, attachments)).filter(({ label }) => labels === undefined || labels.includes(label))

    if (targets.length === 0) return

    const before = await read($, watches)
    const now = await $.clock.now()

    // The browser empties what a page counted as it hands it over: it is asked only by a read of every attachment
    const port = labels === undefined ? (want.browser ?? 0) : 0

    const [written, told] = await Promise.all([
      Promise.all(
        targets.map(async attachment => {
          const cursor = (before[attachment.label] ?? EMPTY_WATCH).cursor
          const [lines, stand] = await Promise.all([
            take($, attachment, cursor).catch((failure: unknown): Taken => ({ raws: [], cursor, error: firstLine(failure instanceof Error ? failure.message : String(failure)) })),
            standOf($, attachment, now),
          ])

          return { attachment, label: attachment.label, ...lines, ...stand }
        }),
      ),
      port > 0 ? askBrowser($, targets, port, now) : undefined,
    ])

    // What a page said is taken in with what its app wrote
    const reads = written.map(read => ({ ...read, raws: [...read.raws, ...(told?.raws[read.label] ?? [])] }))

    if (told !== undefined) {
      browserAskedAt = now
      isBrowserReached = told.isReached
      await update($, browser, () => told.browser)
    }

    const known = await read($, facts)
    const [usages, envs] = await Promise.all([want.usage ? usagesOf($, reads, known, now) : ({} as Record<string, Usage>), envsOf($, reads, want.env)])

    if (want.usage) usageReadAt = now

    await update($, facts, held => ({
      ...held,
      ...Object.fromEntries(
        targets.map(({ label }) => [label, { ...(held[label] ?? EMPTY_FACTS), ...envs[label], ...(usages[label] === undefined ? {} : { usage: usages[label] }) }] as const),
      ),
    }))

    // Settled on the watches as they stand now: an edit counted while the commands ran keeps its count
    let said: string[] = []

    await update($, watches, held => {
      const settled = settle(held, reads, now)

      said = settled.said

      return settled.watches
    })

    await update($, checkedAt, () => now)

    for (const text of said) $.ui.toast(text)
  })

// Counts an edit against the attachments
const mark = ($: EngineInterface, labels: readonly string[], path: string): Promise<void> =>
  inTurn(async () => {
    await update($, watches, held => marked(held, labels, path))
  })

/** What the options say: the attachments named there, how often to read, and the browser's debug port (0: never asked). */
type Asked = { attachments: unknown; seconds: number; port: number }

const tick = ($: EngineInterface, { seconds, port }: Asked, count: number) => {
  if (ticking !== undefined || seconds <= 0 || count === 0) return

  ticking = $.clock.every(Math.max(1, seconds) * 1000, () => {
    void $.clock
      .now()
      .then(now => pull($, undefined, { usage: now - usageReadAt >= USAGE_EVERY_MS, env: false, browser: isBrowserReached || now - browserAskedAt >= BROWSER_AGAIN_MS ? port : 0 }))
      .catch(() => undefined)
  })
}

// The attachments and what they wrote, both read afresh: what every tool answers from. The project's file may
// have gained a line since the session last looked, and a tool that asks should see it.
const current = async ($: EngineInterface, asked: Asked, want: Want = LINES_ONLY) => {
  const list = await discover($, asked.attachments)

  tick($, asked, list.length)
  await pull($, undefined, want).catch(() => undefined)

  return { list, held: await read($, watches), known: await read($, facts), seen: await read($, browser) }
}

// The project's file and its compose file are read again, so a line added to either is taken up
const refresh = async ($: EngineInterface, asked: Asked) => {
  const list = await discover($, asked.attachments)

  tick($, asked, list.length)
  await pull($, undefined, { usage: true, env: true, browser: asked.port }).catch(() => undefined)

  return list
}

export const register: Register = (on, options) => {
  const asked: Asked = {
    attachments: options?.attachments,
    seconds: typeof options?.pollSeconds === 'number' && Number.isFinite(options.pollSeconds) ? options.pollSeconds : 5,
    port: typeof options?.browserPort === 'number' && Number.isFinite(options.browserPort) ? Math.max(0, Math.round(options.browserPort)) : DEBUG_PORT,
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'palantir', description: 'Open the pane that watches the running app: its logs, its state, its new errors, what it consumes, its environment and why its components render' })

    // A host that registers no tools still starts the session
    for (const tool of [view.tool, ...TOOLS]) await $.tool.register(tool).catch(() => undefined)

    return next(e)
  })

  // The pane as text, for the model
  on('tool.call', { tool: 'mcp__palantir__pane' }, $ => view.answer(() => $.ui.panes()))

  on('tool.call', { tool: 'mcp__palantir__status' }, async $ => {
    const { list, held, known } = await current($, asked, { usage: true, env: false })

    return { result: statusText(list, held, known) }
  })

  on('tool.call', { tool: 'mcp__palantir__resources' }, async ($, e) => {
    const { list, known } = await current($, asked, { usage: true, env: false })

    return { result: usageText(list, known, e as unknown as { target?: unknown }) }
  })

  on('tool.call', { tool: 'mcp__palantir__env' }, async ($, e) => {
    const { list, known } = await current($, asked, { usage: false, env: true })

    return { result: envText(list, known, e as unknown as { target?: unknown; grep?: unknown }) }
  })

  on('tool.call', { tool: 'mcp__palantir__renders' }, async ($, e) => {
    const { list, held, seen } = await current($, asked, { usage: false, env: false, browser: asked.port })

    return { result: rendersText(list, held, e as unknown as { target?: unknown; component?: unknown }, asked.port === 0 ? undefined : seen) }
  })

  on('tool.call', { tool: 'mcp__palantir__logs' }, async ($, e) => {
    const { list, held } = await current($, asked)

    return { result: logsText(list, held, e as unknown as LogsAsk) }
  })

  on('tool.call', { tool: 'mcp__palantir__errors_since_edit' }, async ($, e) => {
    const { list, held } = await current($, asked)

    return { result: errorsText(list, held, e as unknown as { target?: unknown }) }
  })

  // An edit to an attachment's source is counted against it. The attachment is read first, so what was already
  // wrong is known before the edit and never taken for its doing.
  on('tool.call', { tool: ['Edit', 'Write'] }, async ($, e, next) => {
    const list = await ensure($, asked.attachments)
    const cwd = await $.session.cwd()
    const labels = routed(list, e.file_path, cwd).map(({ label }) => label)

    if (labels.length === 0) return next(e)

    tick($, asked, list.length)
    await pull($, labels).catch(() => undefined)

    const firsts = await read($, watches).then(held => labels.filter(label => (held[label] ?? EMPTY_WATCH).edits === 0))
    const answer = await next(e)

    if (answer.result === undefined || answer.isError === true) return answer

    await mark($, labels, shown(e.file_path, cwd))

    // Said once per attachment: the model has no other way to know that what it edits is being watched
    if (firsts.length === 0) return answer

    return {
      ...answer,
      context: [
        ...(answer.context ?? []),
        `palantir watches the running ${firsts.join(', ')}, which this file is part of. Once it has reloaded, mcp__palantir__errors_since_edit says whether an edit broke it, and mcp__palantir__logs shows what it writes.`,
      ],
    }
  })

  on('command.run', { command: 'palantir' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })

    const list = await refresh($, asked)

    if (list.length === 0) return { text: HOW_TO_ATTACH }

    const held = await read($, watches)
    const down = list.filter(({ label }) => held[label]?.health.state === 'down').map(({ label }) => label)

    return { text: `palantir watches ${list.map(({ label }) => label).join(', ')}.${down.length > 0 ? ` Down: ${down.join(', ')}.` : ''}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button } = $.ui.resolve(e)
    const width = e.props.bodyColumns ?? 80
    const list = await read($, attachments)
    const held = await read($, watches)
    const picked = await read($, only)
    const errorsOnly = await read($, isErrorsOnly)
    const at = await read($, checkedAt)
    const known = await read($, facts)
    const showing = await read($, shownView)
    const open = await read($, opened)
    const drawAs = await read($, rendersAs)
    const seen = await read($, browser)

    const watchOf = (label: string) => held[label] ?? EMPTY_WATCH
    const factsOf = (label: string) => known[label] ?? EMPTY_FACTS
    const down = list.filter(({ label }) => watchOf(label).health.state === 'down').length
    const news = list.reduce((sum, { label }) => sum + fresh(watchOf(label)).length, 0)

    const summary =
      list.length === 0
        ? badge({ label: 'nothing attached', tone: 'neutral' })
        : at === 0
          ? badge({ label: `${list.length} attached, not read yet`, tone: 'neutral' })
          : badge({
              label: `${list.length} watched · ${down} down · ${news} new error${news === 1 ? '' : 's'}`,
              tone: down > 0 || news > 0 ? 'danger' : 'success',
            })

    const rows = list.map(({ label, runtime }): TableCell[] => {
      const watch = watchOf(label)
      const total = watch.signatures.reduce((sum, signature) => sum + signature.count, 0)
      const newCount = fresh(watch).length
      const { state, detail, restarts } = watch.health

      return [
        label,
        RUNTIME_NAME[runtime],
        watch.error !== ''
          ? { text: watch.error, tone: 'danger' }
          : { text: [state, detail, restarts > 0 ? `${restarts} restarts` : ''].filter(part => part !== '').join(' · '), tone: TONE[state] },
        cpuText(factsOf(label).usage),
        memoryText(factsOf(label).usage),
        newCount > 0 ? { text: `${total} · ${newCount} new`, tone: 'danger' } : total > 0 ? { text: String(total), tone: 'warning' } : '0',
      ]
    })

    const lines = timeline(list, held).filter(({ label, line }) => (picked === '' || label === picked) && (!errorsOnly || line.level === 'error'))
    // As many lines as the pane has rows for, under the table
    const room = Math.max(8, Math.min(40, (e.viewport?.rows ?? 36) - list.length - 12))
    const isTagged = list.length > 1 && picked === ''

    const filter = (label: string, text: string) => (
      <Button key={`show-${label === '' ? 'all' : label}`} plain onPress={() => update($, only, () => label)}>
        {tonedText({ text, tone: picked === label ? 'accent' : 'neutral', bold: picked === label })}
      </Button>
    )

    const tab = (name: Shown, text: string, hotkey: string) => (
      <Button
        key={`view-${name}`}
        hotkey={hotkey}
        onPress={async () => {
          await update($, shownView, () => name)
          // A compose service's and a local app's environment take a read of their own, made when it is looked at
          if (name === 'env') await pull($, undefined, { usage: false, env: true }).catch(() => undefined)
          // The browser is asked at once, whenever it last failed to answer
          if (name === 'renders') await pull($, undefined, { usage: false, env: false, browser: asked.port }).catch(() => undefined)
        }}
      >
        {actionLabel({ text, primary: showing === name })}
      </Button>
    )

    const picks = list.filter(({ label }) => picked === '' || label === picked)

    const logsBody = () => [
      logLines({
        entries: lines.slice(-room).map(({ label, line }) => ({
          at: clockTime(line.at),
          level: line.level,
          message: `${isTagged ? `[${label}] ` : ''}${line.message}${line.more > 0 ? ` (+${line.more} lines)` : ''}`,
        })),
      }),
    ]

    const envBody = () => {
      const variables = picks.flatMap(({ label }) => factsOf(label).env.map(variable => ({ label, ...variable })))
      const notes = [...new Set(picks.map(({ label }) => factsOf(label).envNote))]
      const isByApp = picks.length > 1

      return [
        table({
          columns: [...(isByApp ? [{ header: 'App', width: 12 }] : []), { header: 'Variable', width: 30 }, { header: 'Value' }, { header: 'Set in', width: 26 }],
          rows: variables
            .slice(0, room)
            .map(({ label, name, value, from }): TableCell[] => [...(isByApp ? [label] : []), name, value === '***' ? { text: value, tone: 'warning' } : value, from]),
          empty: 'No variable.',
        }),
        ...(variables.length > room ? [tonedText({ text: `and ${variables.length - room} more: show one app, or ask mcp__palantir__env`, tone: 'neutral' })] : []),
        ...notes.map(note => tonedText({ text: note, tone: 'neutral', wrap: true })),
      ]
    }

    // Where the renders and the page are read from: the tab of each app, or why the browser says nothing
    // Why it says nothing is left unsaid where a log said what there is to show
    const source = (isReported: boolean) => {
      const labels = picks.map(({ label }) => label)
      const isRead = seen.pages.some(({ label }) => labels.includes(label))

      if (asked.port === 0 || (isReported && !isRead)) return []

      return describeBrowser(seen, labels).map(line => tonedText({ text: line, tone: isRead ? 'neutral' : 'warning', wrap: true }))
    }

    // The page each frontend last reported, its elements nested as the document nests them
    const domBody = (rowWidth: number) => {
      const pages = picks.flatMap(({ label }) => {
        const { dom } = watchOf(label)

        return dom === undefined ? [] : [{ label, dom }]
      })

      if (pages.length === 0) return [tonedText({ text: HOW_TO_REPORT_DOM, tone: 'neutral', wrap: true }), ...source(false)]

      return [
        ...source(true),
        tonedText({ text: HOW_TO_READ_DOM, tone: 'neutral', wrap: true }),
        ...pages.flatMap(({ label, dom }) => [
          tonedText({
            text: `${pages.length > 1 ? `${label}: ` : ''}${dom.title === '' ? 'A page' : dom.title} at ${dom.url}, ${dom.elements.length} element${dom.elements.length === 1 ? '' : 's'}, as it stood at ${clockTime(dom.at)}`,
            bold: true,
            wrap: true,
          }),
          // The whole of it, however tall: the pane's body scrolls
          tree({ nodes: domTree(dom), width: rowWidth }),
          ...(dom.left > 0 ? [tonedText({ text: `${dom.left} more element${dom.left === 1 ? '' : 's'} than a report holds ${dom.left === 1 ? 'is' : 'are'} left out.`, tone: 'warning', wrap: true })] : []),
        ]),
      ]
    }

    const rendersBody = () => {
      const reporting = picks.map(({ label }) => ({ label, renders: watchOf(label).renders ?? [] })).filter(({ renders }) => renders.length > 0)

      // What the card leaves of the pane's width to a row
      const rowWidth = width - 4

      const as = (name: RendersAs, text: string, hotkey: string) => (
        <Button key={`renders-${name}`} hotkey={hotkey} onPress={() => update($, rendersAs, () => name)}>
          {actionLabel({ text, primary: drawAs === name })}
        </Button>
      )

      const switcher = (
        <Box key="renders-as" flexDirection="row" gap={2}>
          {as('tree', 'Tree', 't')}
          {as('dom', 'DOM', 'd')}
        </Box>
      )

      if (drawAs === 'dom') return [switcher, ...domBody(rowWidth)]
      if (reporting.length === 0) return [switcher, tonedText({ text: HOW_TO_REPORT_RENDERS, tone: 'neutral', wrap: true }), ...source(false)]

      return [
        switcher,
        ...source(true),
        tonedText({ text: HOW_TO_READ_RENDERS, tone: 'neutral', wrap: true }),
        // The whole of it, however tall: the pane's body scrolls, and the chains a watch keeps are counted
        tree({
          // Two frontends each have a tree of their own, under their name
          nodes:
            reporting.length === 1
              ? renderTree(reporting[0]?.renders ?? [], { opened: open })
              : reporting.map(({ label, renders }) => ({ label, children: renderTree(renders, { scope: label, opened: open }) })),
          width: rowWidth,
          key: 'value',
          Button,
          onToggle: id => update($, opened, ids => (ids.includes(id) ? ids.filter(known => known !== id) : [...ids, id])),
        }),
      ]
    }

    return view.keep(
      card({
        width,
        title: TITLE,
        meta: at === 0 ? undefined : `read ${clockTime(at)}`,
        children: [
          summary,
          <Box key="actions" flexDirection="row" gap={2}>
            <Button key="refresh" hotkey="r" onPress={() => refresh($, asked)}>
              {actionLabel({ text: 'Refresh' })}
            </Button>
            <Button key="errors-only" hotkey="e" onPress={() => update($, isErrorsOnly, value => !value)}>
              {actionLabel({ text: errorsOnly ? 'All levels' : 'Errors only' })}
            </Button>
            {tab('logs', 'Logs', 'l')}
            {tab('env', 'Env', 'v')}
            {tab('renders', 'Renders', 'c')}
          </Box>,
          ...(list.length === 0
            ? [tonedText({ text: HOW_TO_ATTACH, tone: 'neutral', wrap: true })]
            : [
                table({
                  columns: [
                    { header: 'App', width: 12 },
                    { header: 'Runs on', width: 10 },
                    { header: 'State' },
                    { header: 'CPU', width: 6 },
                    { header: 'Memory', width: 16 },
                    { header: 'Errors', width: 11 },
                  ],
                  rows,
                }),
                ...(list.length > 1
                  ? [
                      <Box key="filter" flexDirection="row" gap={2}>
                        {[filter('', 'all'), ...list.map(({ label }) => filter(label, label))]}
                      </Box>,
                    ]
                  : []),
                divider(),
                ...(showing === 'env' ? envBody() : showing === 'renders' ? rendersBody() : logsBody()),
              ]),
        ],
      }),
    )
  })
}
