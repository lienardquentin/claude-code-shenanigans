import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Attachment, Browser, Cursor, EnvVar, Facts, Health, RendersAs, Scenario, Shown, Suite, TestsAs, Usage, Watch } from '../types'
import { composeAttachments, merged, parseList, PROJECT_FILE, routed, shown, tidy, under } from './attach'
import { askArgv, DEBUG_PORT, describeBrowser, EMPTY_BROWSER, readAsked } from './browser'
import type { Asked as Told } from './browser'
import { addressOf, AGENT, AGENT_TYPE, e2eText, fixPrompt, HOW_TO_PLAN, isUnderWay, PLAN_PROMPT, planned, queued, scenarioPrompt, scenarioTree, settled, stopped, tally, verdictOf } from './e2e'
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
import { endedSuite, fixUnitPrompt, HOW_TO_PLAN_UNIT, PLAN_UNIT_PROMPT, plannedSuites, queuedSuites, SUITE_TIMEOUT_MS, suiteTree, unitText } from './unit'
import { clockTime, EMPTY_WATCH, fresh } from './lines'
import { ENV_FILES, isWindows, LISTENERS_ARGV, LOCAL_ENV_NOTE, localUsage, PROCESSES_ARGV, readEnvFile, readUnixProbe, readWindowsProbe, WINDOWS_PROBE_ARGV } from './local'
import type { Probe } from './local'
import { actionsText, actionTree, domText, HOW_TO_REPORT_ACTIONS, HOW_TO_REPORT_NETWORK, networkText, rendersSinceText, slowestFirst, answerText, vitalsText } from './report'
import { cpuText, domTree, EMPTY_FACTS, EMPTY_USAGE, envText, errorsText, HOW_TO_ATTACH, HOW_TO_READ_DOM, HOW_TO_READ_RENDERS, HOW_TO_REPORT_DOM, HOW_TO_REPORT_RENDERS, logsText, memoryText, renderTree, rendersNow, rendersText, statusText, timeline, usageText } from './report'
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
const home = atom({ plugin: 'palantir', key: 'home' } as const, '')
const scenarios = atom({ plugin: 'palantir', key: 'scenarios' } as const, [] as Scenario[])
const suites = atom({ plugin: 'palantir', key: 'suites' } as const, [] as Suite[])
const testsAs = atom({ plugin: 'palantir', key: 'testsAs' } as const, 'e2e' as TestsAs)

/**
 * The project the shell stands in: the nearest folder, from the session's own up, that holds the project's file;
 * the session's own where none does. A mod loaded again while the shell is deep in the project still finds it.
 */
const projectOf = async ($: EngineInterface): Promise<string> => {
  const cwd = tidy(await $.session.cwd())
  const parts = cwd.split('/')

  for (let depth = parts.length; depth > 1; depth -= 1) {
    const folder = parts.slice(0, depth).join('/')

    if (await $.fs.exists(`${folder}/${PROJECT_FILE}`).catch(() => false)) return folder
  }

  return cwd
}

/**
 * The folder the session started in: where the project's file is looked for and what every path is said from. The
 * session's own folder is not asked each time, as it follows the shell: a `cd` Claude runs would move the project
 * from under what is watched.
 */
const homeOf = async ($: EngineInterface): Promise<string> => {
  const held = await read($, home)

  if (held !== '') return held

  const cwd = await projectOf($)

  await update($, home, () => cwd)

  return cwd
}

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
      "The errors a running app started writing after the last edit to its source in this session, each kind once with its count: what the edit broke, apart from what was already wrong. A frontend's include what its page's console holds (an uncaught error, a Vue warning, a hydration mismatch, a file that did not load), read from the browser and led by \"in the page:\". Reads the apps afresh. Call it after editing the code of a watched app, once the app has had the time to reload, and before saying the change works.",
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
      "Why the components of a watched frontend rendered again, as the browser itself says it: each reactivity chain once, with its count, from the state that changed, through the computed values and the props that carried it, down to the component. Asks the tabs of the Chrome that listens on its debug port afresh; nothing is added to the app. Call it when a page flickers, is slow, or renders more than it should, and to see what a change of state reaches. A chain marked \"with nothing changed\" rendered while the values it holds were the same as the time before: a render that could be spared. Each component is said with the file it is written in. Only a Vue app in development, open in that Chrome, has any; the answer says so when there is none.",
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'The label of one watched app; left out, all of them.' },
        component: { type: 'string', description: 'Only the components whose name holds this text, whatever its case.' },
      },
    },
  },
  {
    name: 'renders_since_edit',
    description:
      "What the last edit to a watched frontend's source did to its renders: the chains that first showed after it, the ones that rendered before and no more since, and for the others how often they render now against before. Asks the browser afresh. Call it after an edit meant to make a page render less, once the page has been used again, and before saying it does.",
    inputSchema: {
      type: 'object',
      properties: { target: { type: 'string', description: 'The label of one watched app; left out, all of them.' } },
    },
  },
  {
    name: 'interactions',
    description:
      "What the person last did on a watched frontend's page (a click, a form sent, a field changed, a move to another address; never what a field holds), each with what followed: which components rendered and how often, what the page asked for with its status and time, and what every watched app wrote in the two seconds after, the backend included. Asks the browser afresh. Call it to follow one click from the page to the server, or when the person says \"when I click this, that happens\".",
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'The label of one watched app; left out, all of them.' },
        limit: { type: 'number', description: 'How many of the last things done; 8 when left out, 30 at most.' },
      },
    },
  },
  {
    name: 'network',
    description:
      "What a watched frontend's page asked for from the browser (fetch and XHR), each address once with how often, the average and the longest time, the failures and the last status, the slowest in all first; and how the page loaded: first byte, largest paint, layout shift, the slowest answer to a click, long tasks. After an edit, each is said against how it stood before it. Asks the browser afresh. Call it when a page is slow to load or to answer, to see what it waits for, and before and after a change meant to make it faster.",
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'The label of one watched app; left out, all of them.' },
        grep: { type: 'string', description: 'Only the addresses that hold this text, whatever its case.' },
      },
    },
  },
  {
    name: 'dom',
    description:
      "A watched frontend's page as it stands in the browser: its elements nested, each with what it is to a reader (role, label, state), the text it holds, and the component of the app's own that draws it, with the file that component is written in; and what a reader who does not see the page cannot use (a button or a link with no name, an image with no alt, a field with no label, an id used twice). Never what a field holds. Asks the browser afresh. Call it to see what is on the page without a screenshot, to find which component draws something, and to check a page after changing its markup.",
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'The label of one watched app; left out, all of them.' },
        grep: { type: 'string', description: "Only the elements that hold this text in their tag, their attributes, their words or their component's name, each under the elements that hold it." },
      },
    },
  },
  {
    name: 'e2e_plan',
    description:
      "Writes the end-to-end checklist of a watched frontend: the scenarios a person goes through on its page, each to be run in the browser by a subagent of its own that sees nothing of this conversation. Call it when asked to plan or write end-to-end scenarios, after reading the app's routes and pages. Write each step as one thing done on the page, naming what is clicked or filled by the words the page shows, with the values to type, and say in `expect` what must be seen at the end. It takes the place of the checklist held, unless `add` is true. Nothing is run: mcp__palantir__e2e_run does that, and the person can from the pane.",
    inputSchema: {
      type: 'object',
      required: ['scenarios'],
      properties: {
        scenarios: {
          type: 'array',
          items: {
            type: 'object',
            required: ['name', 'steps'],
            properties: {
              name: { type: 'string', description: 'What the person sets out to do, in a few words.' },
              steps: { type: 'array', items: { type: 'string' }, description: 'What is done on the page, in order, one thing a step.' },
              expect: { type: 'string', description: 'What the page must show at the end for the scenario to pass.' },
              target: { type: 'string', description: 'The label of the watched app whose page it is done on; the first one when left out.' },
            },
          },
        },
        add: { type: 'boolean', description: 'True to add the scenarios after the ones held, which keep what came of them.' },
      },
    },
  },
  {
    name: 'e2e_run',
    description:
      'Runs scenarios of the end-to-end checklist: each is done on the page of the debug Chrome by a Haiku subagent of its own, one after another as they share the page. Answers at once, with the run under way; mcp__palantir__e2e says what came of it once the subagents have answered. Call it after mcp__palantir__e2e_plan when asked to run the scenarios, and after a change to the frontend to check it still does what it did.',
    inputSchema: {
      type: 'object',
      properties: { ids: { type: 'array', items: { type: 'string' }, description: 'The numbers of the scenarios to run; left out, all of them.' } },
    },
  },
  {
    name: 'unit_plan',
    description:
      "Names the unit test suites of the project, which the person then runs from the Tests view of the palantir pane: one suite per command. Call it when asked to plan, find or set up the unit tests there, after reading how the project runs them (package.json scripts, pyproject, Makefile, CI). A command is a list of arguments, as no shell reads it: [\"npm\", \"test\", \"--silent\"], never one line, and no pipe or &&. It takes the place of the suites held. Nothing is run by it, and palantir has no tool that runs a suite: the person does, from the pane.",
    inputSchema: {
      type: 'object',
      required: ['suites'],
      properties: {
        suites: {
          type: 'array',
          items: {
            type: 'object',
            required: ['name', 'command'],
            properties: {
              name: { type: 'string', description: 'What the suite tests, in a few words.' },
              command: { type: 'array', items: { type: 'string' }, description: 'The command, one argument an item; it must end by itself, so no watch mode.' },
              cwd: { type: 'string', description: "The folder it runs in, from the project's root; the root when left out." },
              target: { type: 'string', description: 'The label of the watched app it tests, when it is of one.' },
            },
          },
        },
      },
    },
  },
  {
    name: 'unit',
    description:
      "The unit test suites named in the palantir pane as they stand: each with its command, whether it passed or failed when the person last ran it, and the end of what a failing one printed. Call it when the person speaks of the unit tests of the pane, or of a suite that fails there.",
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The number of one suite, to read what it printed even if it passed; left out, all of them.' } },
    },
  },
  {
    name: 'e2e_stop',
    description:
      'Stops the run of the end-to-end checklist: the scenarios that wait go back to being to run, and the one that runs is given up on. Call it when a run cannot come to anything, such as every scenario blocked on the same cause.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'e2e',
    description:
      'The end-to-end checklist of the watched frontend as it stands: each scenario with its steps, whether it passed, failed or could not be tried, why, and what the subagent that ran it reported. Call it once a run is over, before saying what works, and to see what is already planned.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The number of one scenario, to read the whole of what its subagent reported; left out, all of them.' } },
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
    const findIn = async (cwd: string): Promise<Attachment[]> => {
      const composeFiles = await Promise.all(COMPOSE_FILES.map(file => $.fs.exists(`${cwd}/${file}`).catch(() => false)))
      // Docker is asked only in a project that has a compose file
      const project = composeFiles.some(Boolean) ? await $.process.run(COMPOSE_CONFIG_ARGV, { timeoutMs: 15_000 }).catch(() => undefined) : undefined
      const listed = await $.fs.read(`${cwd}/${PROJECT_FILE}`).catch(() => '')

      return merged(
        project?.exitCode === 0 ? composeAttachments(project.stdout, cwd) : [],
        parseList(typeof listed === 'string' ? listed : '', cwd),
        parseList(typeof asked === 'string' ? asked : '', cwd),
      )
    }

    const held = await homeOf($)
    let found = await findIn(held)

    // A folder that holds nothing to watch was taken for the project by mistake: the shell's project is looked at
    if (found.length === 0) {
      const project = await projectOf($)

      if (project !== held) {
        found = await findIn(project)
        if (found.length > 0) await update($, home, () => project)
      }
    }

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
    const found = locals.some(({ attachment }) => attachment.port > 0) ? await probe($, await homeOf($)) : undefined

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
  const cwd = await homeOf($)
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
    const now = await $.clock.now()

    await update($, watches, held => marked(held, labels, path, now))
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

// What only the browser says is asked of it afresh
const ofBrowser = ($: EngineInterface, asked: Asked) => current($, asked, { usage: false, env: false, browser: asked.port })

// The project's file and its compose file are read again, so a line added to either is taken up
const refresh = async ($: EngineInterface, asked: Asked) => {
  const list = await discover($, asked.attachments)

  tick($, asked, list.length)
  await pull($, undefined, { usage: true, env: true, browser: asked.port }).catch(() => undefined)

  return list
}

/**
 * Starts the subagent of the first scenario that waits, unless one runs: they share one page. A scenario whose
 * subagent would not start is said blocked, and the next one is tried.
 */
const runNext = async ($: EngineInterface): Promise<void> => {
  for (;;) {
    const held = await read($, scenarios)
    const next = held.find(({ state }) => state === 'queued')

    if (next === undefined || held.some(({ state }) => state === 'running')) return

    const started = await $.agent
      .spawn({ subagentType: AGENT_TYPE, description: `e2e: ${next.name}`.slice(0, 60), prompt: scenarioPrompt(next, addressOf(next, await read($, browser), await read($, attachments))) })
      .catch((failure: unknown) => ({ deny: firstLine(failure instanceof Error ? failure.message : String(failure)), agentId: undefined }))
    const agentId = started.agentId
    const now = await $.clock.now()

    await update($, scenarios, list =>
      list.map((scenario): Scenario =>
        scenario.id !== next.id || scenario.state !== 'queued'
          ? scenario
          : agentId === undefined
            ? { ...scenario, state: 'blocked', note: `its subagent did not start: ${started.deny ?? 'no reason given'}`.slice(0, 300) }
            : { ...scenario, state: 'running', agentId, at: now },
      ),
    )
  }
}

/**
 * The scenarios named (all, when none is) are queued and the first is started. The browser is asked first: where
 * no Chrome answers, they are said blocked on that and no subagent is started to find it out.
 */
const runScenarios = ($: EngineInterface, ids: readonly string[], port: number): Promise<Scenario[]> =>
  inTurn(async () => {
    const told = port > 0 && !isUnderWay(await read($, scenarios)) ? await askBrowser($, await read($, attachments), port, await $.clock.now()) : undefined

    if (told !== undefined) await update($, browser, () => told.browser)

    if (told?.isReached === false) {
      await update($, scenarios, held => queued(held, ids).map((scenario): Scenario => (scenario.state === 'queued' ? { ...scenario, state: 'blocked', note: told.browser.note.slice(0, 300), ms: 0 } : scenario)))

      return read($, scenarios)
    }

    await update($, scenarios, held => queued(held, ids))
    await runNext($)

    return read($, scenarios)
  })

// Whether the loop below runs. A reload ends it with the module, and the next run starts it over.
let isRunningSuites = false

/**
 * Runs the suites named (all, when none is), one after another, each read by how its command exits. Asked while
 * some run, it only adds to what waits. A suite a reload left running is run again.
 */
const runSuites = async ($: EngineInterface, ids: readonly string[]): Promise<void> => {
  await update($, suites, held => queuedSuites(isRunningSuites ? held : held.map((suite): Suite => (suite.state === 'running' ? { ...suite, state: 'todo' } : suite)), ids))

  if (isRunningSuites) return

  isRunningSuites = true

  try {
    const cwd = await homeOf($)

    for (;;) {
      const next = (await read($, suites)).find(({ state }) => state === 'queued')

      if (next === undefined) break

      const at = await $.clock.now()

      await update($, suites, held => held.map((suite): Suite => (suite.id === next.id ? { ...suite, state: 'running', at } : suite)))

      const ended = await $.process
        .run(next.argv, { cwd: next.cwd === '' ? cwd : under(cwd, next.cwd), timeoutMs: SUITE_TIMEOUT_MS })
        .catch((failure: unknown) => ({ failure: firstLine(failure instanceof Error ? failure.message : String(failure)) || 'it did not start, or ran past ten minutes' }))
      const ms = (await $.clock.now()) - at

      // Settled only if it is still the one that runs: a plan made meanwhile has other suites
      await update($, suites, held => held.map(suite => (suite.id === next.id && suite.state === 'running' && suite.at === at ? endedSuite(suite, ended, ms) : suite)))
    }
  } finally {
    isRunningSuites = false
  }

  const held = await read($, suites)

  if (held.length > 0) $.ui.toast(`palantir unit tests: ${tally(held).label}`)
}

export const register: Register = (on, options) => {
  const asked: Asked = {
    attachments: options?.attachments,
    seconds: typeof options?.pollSeconds === 'number' && Number.isFinite(options.pollSeconds) ? options.pollSeconds : 5,
    port: typeof options?.browserPort === 'number' && Number.isFinite(options.browserPort) ? Math.max(0, Math.round(options.browserPort)) : DEBUG_PORT,
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'palantir', description: 'Open the pane that watches the running app: its logs, its state, its new errors, what it consumes, its environment, why its components render, what is done on its page and what the page asks for, and the end-to-end scenarios run on it, and the unit tests of the project' })

    // A host that registers no tools still starts the session
    for (const tool of [view.tool, ...TOOLS]) await $.tool.register(tool).catch(() => undefined)

    // The agent type a scenario is run by, which only palantir starts
    await $.agent.register(AGENT).catch(() => undefined)

    // Taken now, before any command has moved the shell
    await homeOf($).catch(() => undefined)

    return next(e)
  })

  // The pane as text, for the model
  on('tool.call', { tool: 'mcp__palantir__pane' }, $ => view.answer(() => $.ui.panes()))

  on('tool.call', { tool: 'mcp__palantir__status' }, async $ => {
    const { list, held, known, seen } = await current($, asked, { usage: true, env: false, browser: asked.port })

    return { result: statusText(list, held, known, asked.port === 0 ? undefined : seen) }
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

    return { result: rendersText(list, held, e as unknown as { target?: unknown; component?: unknown }, asked.port === 0 ? undefined : seen, await homeOf($)) }
  })

  on('tool.call', { tool: 'mcp__palantir__renders_since_edit' }, async ($, e) => {
    const { list, held } = await ofBrowser($, asked)

    return { result: rendersSinceText(list, held, e as unknown as { target?: unknown }, await $.clock.now()) }
  })

  on('tool.call', { tool: 'mcp__palantir__interactions' }, async ($, e) => {
    const { list, held, seen } = await ofBrowser($, asked)

    return { result: actionsText(list, held, e as unknown as { target?: unknown; limit?: unknown }, asked.port === 0 ? undefined : seen) }
  })

  on('tool.call', { tool: 'mcp__palantir__network' }, async ($, e) => {
    const { list, held, seen } = await ofBrowser($, asked)

    return { result: networkText(list, held, e as unknown as { target?: unknown; grep?: unknown }, asked.port === 0 ? undefined : seen) }
  })

  on('tool.call', { tool: 'mcp__palantir__dom' }, async ($, e) => {
    const { list, held, seen } = await ofBrowser($, asked)

    return { result: domText(list, held, e as unknown as { target?: unknown; grep?: unknown }, asked.port === 0 ? undefined : seen, await homeOf($)) }
  })

  // A scenario is started by palantir alone, which is what keeps its place in the checklist
  on('agent.offer', { agent: 'palantir:e2e' }, () => ({ isOffered: false }))

  on('tool.call', { tool: 'mcp__palantir__e2e_plan' }, async ($, e) => {
    const list = await ensure($, asked.attachments)
    const seen = await read($, browser)
    // The apps a tab shows first: a scenario that names no app is of a frontend
    const labels = [...new Set([...seen.pages.map(({ label }) => label), ...list.map(({ label }) => label)])]
    let refused: string[] = []

    await inTurn(() =>
      update($, scenarios, held => {
        // What runs is kept, whatever the plan: its subagent is still on the page
        const plan = planned(held, e as unknown as { scenarios?: unknown; add?: unknown }, labels)
        const running = held.filter(({ state, id }) => state === 'running' && !plan.scenarios.some(scenario => scenario.id === id))

        refused = plan.refused

        return [...running.map(scenario => ({ ...scenario, id: `was ${scenario.id}` })), ...plan.scenarios]
      }),
    )

    await update($, shownView, () => 'tests' as Shown)
    await update($, testsAs, () => 'e2e' as TestsAs)
    await $.ui.open({ id: PANE, title: TITLE }).catch(() => undefined)

    const held = await read($, scenarios)

    return { result: [...refused.map(line => `Left out: ${line}.`), e2eText(held), '', 'Nothing has run. mcp__palantir__e2e_run runs them, each on the page by a subagent of its own; the person can too, from the Tests view of the pane.'].join('\n') }
  })

  on('tool.call', { tool: 'mcp__palantir__e2e_run' }, async ($, e) => {
    const ids = ((e as unknown as { ids?: unknown }).ids instanceof Array ? ((e as unknown as { ids: unknown[] }).ids) : []).map(String)
    const before = await read($, scenarios)
    const unknown = ids.filter(id => !before.some(scenario => scenario.id === id))

    if (before.length === 0 || unknown.length > 0) return { result: before.length === 0 ? e2eText(before) : `No scenario ${unknown.join(', ')}. The checklist has ${before.map(({ id }) => id).join(', ')}.`, isError: true }

    const held = await runScenarios($, ids, asked.port)
    const waiting = held.filter(({ state }) => state === 'queued' || state === 'running').length

    return {
      result:
        waiting === 0
          ? e2eText(held)
          : `${waiting} scenario${waiting === 1 ? ' is' : 's are'} under way, each run on the page by a subagent of its own, one after another. Nothing is to be done meanwhile: mcp__palantir__e2e says what came of them once they have answered.`,
    }
  })

  on('tool.call', { tool: 'mcp__palantir__unit_plan' }, async ($, e) => {
    const list = await ensure($, asked.attachments)
    const plan = plannedSuites(e as unknown as { suites?: unknown }, list.map(({ label }) => label))

    await update($, suites, () => plan.suites)
    await update($, shownView, () => 'tests' as Shown)
    await update($, testsAs, () => 'unit' as TestsAs)
    await $.ui.open({ id: PANE, title: TITLE }).catch(() => undefined)

    return { result: [...plan.refused.map(line => `Left out: ${line}.`), unitText(plan.suites), '', 'Nothing has run: the person runs them from the Tests view of the pane.'].join('\n') }
  })

  on('tool.call', { tool: 'mcp__palantir__unit' }, async ($, e) => ({ result: unitText(await read($, suites), e as unknown as { id?: unknown }) }))

  on('tool.call', { tool: 'mcp__palantir__e2e_stop' }, async $ => ({ result: e2eText(await inTurn(() => update($, scenarios, stopped))) }))

  on('tool.call', { tool: 'mcp__palantir__e2e' }, async ($, e) => ({ result: e2eText(await read($, scenarios), e as unknown as { id?: unknown }) }))

  // A subagent's answer is its turn's end: the scenario it ran is settled on it, and the next one started
  on('turn.complete', async ($, e, next) => {
    const agentId = e.agentId

    if (agentId === undefined || !(await read($, scenarios)).some(scenario => scenario.state === 'running' && scenario.agentId === agentId)) return next(e)

    const held = await inTurn(async () => {
      await update($, scenarios, list => settled(list, agentId, verdictOf(e.answer, e.reason), e.answer, e.durationMs))
      await runNext($)

      return read($, scenarios)
    }).catch(() => undefined)

    // Said once, when the last of a run has answered
    if (held !== undefined && held.length > 0 && !isUnderWay(held)) $.ui.toast(`palantir e2e: ${tally(held).label}`)

    return next(e)
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
    const cwd = await homeOf($)
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
        `palantir watches the running ${firsts.join(', ')}, which this file is part of. Once it has reloaded, mcp__palantir__errors_since_edit says whether an edit broke it, and mcp__palantir__logs shows what it writes. For a frontend open in the debug Chrome, mcp__palantir__renders_since_edit says what the edit did to its renders, and mcp__palantir__network to its requests and its load.`,
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
    const checklist = await read($, scenarios)
    const named = await read($, suites)
    const testing = await read($, testsAs)

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
          if (name === 'renders' || name === 'tests') await pull($, undefined, { usage: false, env: false, browser: asked.port }).catch(() => undefined)
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
      // A page that was read from the browser and is not now: what is shown is what was last read, and that is said
      const wasRead = picks.some(({ label }) => watchOf(label).vitals !== undefined)

      if (asked.port === 0 || (isReported && !isRead && !wasRead)) return []

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
          ...(dom.issues ?? []).map(({ kind, tag, component }) => tonedText({ text: `${kind}: ${tag}${component === '' ? '' : ` in ${component}`}`, tone: 'warning', wrap: true })),
          // The whole of it, however tall: the pane's body scrolls
          tree({ nodes: domTree(dom), width: rowWidth }),
          ...(dom.left > 0 ? [tonedText({ text: `${dom.left} more element${dom.left === 1 ? '' : 's'} than a report holds ${dom.left === 1 ? 'is' : 'are'} left out.`, tone: 'warning', wrap: true })] : []),
        ]),
      ]
    }

    // What the person did on each frontend's page, the latest first, each with what followed
    const actionsBody = (rowWidth: number) => {
      const acted = picks.map(({ label }) => ({ label, actions: watchOf(label).actions ?? [] })).filter(({ actions }) => actions.length > 0)
      const everything = timeline(list, held)

      if (acted.length === 0) return [tonedText({ text: HOW_TO_REPORT_ACTIONS, tone: 'neutral', wrap: true }), ...source(false)]

      return [
        tonedText({ text: 'What was done on the page, the latest first: what rendered, what the page asked for, and what every app wrote in the two seconds after.', tone: 'neutral', wrap: true }),
        tree({
          nodes: acted.length === 1 ? actionTree(acted[0]?.actions ?? [], everything) : acted.map(({ label, actions }) => ({ label, children: actionTree(actions, everything) })),
          width: rowWidth,
          key: 'actions',
        }),
        ...source(true),
      ]
    }

    // What each frontend's page asked for, the slowest in all first, and how the page loaded
    const networkBody = () => {
      const asking = picks.map(({ label }) => ({ label, watch: watchOf(label) })).filter(({ watch }) => (watch.requests ?? []).length > 0 || watch.vitals !== undefined)
      const isByApp = asking.length > 1

      if (asking.length === 0) return [tonedText({ text: HOW_TO_REPORT_NETWORK, tone: 'neutral', wrap: true }), ...source(false)]

      const asks = asking.flatMap(({ label, watch }) => slowestFirst(watch.requests ?? []).map(request => ({ label, request })))

      return [
        ...asking.flatMap(({ label, watch: { vitals, vitalsAtEdit, editedPath } }) => [
          ...(vitals === undefined ? [] : [tonedText({ text: `${isByApp ? `${label}: ` : ''}The page ${vitalsText(vitals)}.`, wrap: true })]),
          ...(vitals === undefined || vitalsAtEdit === undefined || vitalsAtEdit.loadedAt === vitals.loadedAt
            ? []
            : [tonedText({ text: `Before the edit to ${editedPath}: ${vitalsText(vitalsAtEdit)}.`, tone: 'neutral', wrap: true })]),
        ]),
        table({
          columns: [...(isByApp ? [{ header: 'App', width: 12 }] : []), { header: 'Asked for' }, { header: '×', width: 5 }, { header: 'Avg', width: 8 }, { header: 'Max', width: 8 }, { header: 'Last', width: 16 }],
          rows: asks.slice(0, room).map(({ label, request: { url, count, failed, totalMs, maxMs, lastStatus } }): TableCell[] => [
            ...(isByApp ? [label] : []),
            url,
            String(count),
            `${Math.round(totalMs / Math.max(1, count))}ms`,
            `${maxMs}ms`,
            failed > 0 ? { text: `${answerText(lastStatus)} · ${failed} failed`, tone: 'danger' } : answerText(lastStatus),
          ]),
          empty: 'No request.',
        }),
        ...(asks.length > room ? [tonedText({ text: `and ${asks.length - room} more: ask mcp__palantir__network`, tone: 'neutral' })] : []),
        ...source(true),
      ]
    }

    // The end-to-end checklist: each scenario on a row with how it stands, why under it, and its steps when opened
    const e2eBody = () => {
      const { label, tone } = tally(checklist)
      const isRunning = isUnderWay(checklist)
      const undone = checklist.filter(({ state }) => state === 'failed' || state === 'blocked').map(({ id }) => id)
      const isByApp = new Set(checklist.map(({ target }) => target)).size > 1
      // A scenario that could not be tried is no fault of the code: only what failed is Claude's to fix
      const failed = checklist.filter(({ state }) => state === 'failed')
      const toggle = (id: string) => update($, opened, ids => (ids.includes(id) ? ids.filter(known => known !== id) : [...ids, id]))

      return [
        <Box key="e2e-actions" flexDirection="row" gap={2}>
          <Button key="e2e-plan" hotkey="p" onPress={() => $.prompt.submit({ text: PLAN_PROMPT })}>
            {actionLabel({ text: checklist.length === 0 ? 'Plan' : 'Plan again', primary: checklist.length === 0 })}
          </Button>
          {...(checklist.length === 0 || isRunning
            ? []
            : [
                <Button key="e2e-run" hotkey="g" onPress={() => runScenarios($, [], asked.port)}>
                  {actionLabel({ text: 'Run all', primary: undone.length === 0 })}
                </Button>,
              ])}
          {...(undone.length === 0 || isRunning
            ? []
            : [
                <Button key="e2e-rerun" hotkey="f" onPress={() => runScenarios($, undone, asked.port)}>
                  {actionLabel({ text: `Run the ${undone.length} not passed`, primary: true })}
                </Button>,
              ])}
          {...(failed.length < 2 || isRunning
            ? []
            : [
                <Button key="e2e-fix" hotkey="a" onPress={() => $.prompt.submit({ text: fixPrompt(failed) })}>
                  {actionLabel({ text: `Fix all ${failed.length} with Claude` })}
                </Button>,
              ])}
          {...(isRunning
            ? [
                <Button key="e2e-stop" hotkey="s" onPress={() => inTurn(() => update($, scenarios, stopped))}>
                  {actionLabel({ text: 'Stop', primary: true })}
                </Button>,
              ]
            : [])}
        </Box>,
        ...(checklist.length === 0
          ? [tonedText({ text: HOW_TO_PLAN, tone: 'neutral', wrap: true })]
          : [
              badge({ label, tone }),
              // A scenario a tree of its own, so that one that failed has its button under it
              ...scenarioTree(checklist, { opened: open, isByApp }).flatMap((node, index) => {
                const scenario = checklist[index]

                return [
                  tree({ nodes: [node], width: width - 4, key: `e2e-row-${scenario?.id ?? index}`, Button, onToggle: toggle }),
                  ...(scenario?.state === 'failed' && !isRunning
                    ? [
                        <Box key={`e2e-fix-row-${scenario.id}`} flexDirection="row" paddingLeft={3}>
                          <Button key={`e2e-fix-${scenario.id}`} onPress={() => $.prompt.submit({ text: fixPrompt([scenario]) })}>
                            {actionLabel({ text: 'Fix with Claude' })}
                          </Button>
                        </Box>,
                      ]
                    : []),
                ]
              }),
              tonedText({ text: 'A row opens on its steps and on what the subagent that ran it reported.', tone: 'neutral', wrap: true }),
            ]),
        // Said only when it stands in the way: a run needs the browser
        ...(asked.port === 0 || seen.at === 0 || seen.pages.length > 0 ? [] : describeBrowser(seen, list.map(({ label: app }) => app)).map(line => tonedText({ text: line, tone: 'warning', wrap: true }))),
      ]
    }

    // The unit test suites: each a command on a row with how it last exited, run one by one or all at once
    const unitBody = () => {
      const { label, tone } = tally(named)
      const isRunning = isUnderWay(named)
      const undone = named.filter(({ state }) => state === 'failed' || state === 'blocked').map(({ id }) => id)
      const failed = named.filter(({ state }) => state === 'failed')
      const toggle = (id: string) => update($, opened, ids => (ids.includes(id) ? ids.filter(known => known !== id) : [...ids, id]))

      return [
        <Box key="unit-actions" flexDirection="row" gap={2}>
          <Button key="unit-plan" hotkey="p" onPress={() => $.prompt.submit({ text: PLAN_UNIT_PROMPT })}>
            {actionLabel({ text: named.length === 0 ? 'Plan' : 'Plan again', primary: named.length === 0 })}
          </Button>
          {...(named.length === 0
            ? []
            : [
                <Button key="unit-run" hotkey="g" onPress={() => runSuites($, [])}>
                  {actionLabel({ text: 'Run all', primary: undone.length === 0 && !isRunning })}
                </Button>,
              ])}
          {...(undone.length === 0 || isRunning
            ? []
            : [
                <Button key="unit-rerun" hotkey="f" onPress={() => runSuites($, undone)}>
                  {actionLabel({ text: `Run the ${undone.length} not passed`, primary: true })}
                </Button>,
              ])}
          {...(failed.length < 2 || isRunning
            ? []
            : [
                <Button key="unit-fix" hotkey="a" onPress={() => $.prompt.submit({ text: fixUnitPrompt(failed) })}>
                  {actionLabel({ text: `Fix all ${failed.length} with Claude` })}
                </Button>,
              ])}
        </Box>,
        ...(named.length === 0
          ? [tonedText({ text: HOW_TO_PLAN_UNIT, tone: 'neutral', wrap: true })]
          : [
              badge({ label, tone }),
              ...suiteTree(named, open).flatMap((node, index) => {
                const suite = named[index]

                return [
                  tree({ nodes: [node], width: width - 4, key: `unit-row-${suite?.id ?? index}`, Button, onToggle: toggle }),
                  ...(suite?.state === 'failed' && !isRunning
                    ? [
                        <Box key={`unit-fix-row-${suite.id}`} flexDirection="row" paddingLeft={3}>
                          <Button key={`unit-fix-${suite.id}`} onPress={() => $.prompt.submit({ text: fixUnitPrompt([suite]) })}>
                            {actionLabel({ text: 'Fix with Claude' })}
                          </Button>
                        </Box>,
                      ]
                    : []),
                ]
              }),
              tonedText({ text: 'A row opens on its command and on the end of what it printed.', tone: 'neutral', wrap: true }),
            ]),
      ]
    }

    // The Tests view: the end-to-end checklist or the unit test suites, each said with how it stands
    const testsBody = () => {
      const as = (name: TestsAs, text: string, hotkey: string, held: readonly { state: Scenario['state'] }[]) => (
        <Button key={`tests-${name}`} hotkey={hotkey} onPress={() => update($, testsAs, () => name)}>
          {actionLabel({ text: held.length === 0 ? text : `${text} ${held.filter(({ state }) => state === 'passed').length}/${held.length}`, primary: testing === name })}
        </Button>
      )

      return [
        <Box key="tests-as" flexDirection="row" gap={2}>
          {as('e2e', 'E2E', '1', checklist)}
          {as('unit', 'Unit tests', '2', named)}
        </Box>,
        ...(testing === 'unit' ? unitBody() : e2eBody()),
      ]
    }

    const rendersBody = () => {
      // The chains of the page as it is loaded now: one last seen before that load is of a page that is gone
      const reporting = picks.map(({ label }) => ({ label, renders: rendersNow(watchOf(label)).live })).filter(({ renders }) => renders.length > 0)

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
          {as('actions', 'Actions', 'a')}
          {as('network', 'Network', 'n')}
        </Box>
      )

      if (drawAs === 'dom') return [switcher, ...domBody(rowWidth)]
      if (drawAs === 'actions') return [switcher, ...actionsBody(rowWidth)]
      if (drawAs === 'network') return [switcher, ...networkBody()]
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
            {tab('tests', 'Tests', 'x')}
          </Box>,
          ...(list.length === 0
            ? showing === 'tests'
              ? [divider(), ...testsBody()]
              : [tonedText({ text: HOW_TO_ATTACH, tone: 'neutral', wrap: true })]
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
                ...(showing === 'env' ? envBody() : showing === 'renders' ? rendersBody() : showing === 'tests' ? testsBody() : logsBody()),
              ]),
        ],
      }),
    )
  })
}
