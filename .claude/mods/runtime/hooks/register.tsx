import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Attachment, Baseline, Broker, Browser, Cursor, Database, Peek, EnvVar, Facts, Health, History, Plans, RendersAs, Rows, Scenario, Shown, Suite, TestsAs, Usage, Watch } from '../types'
import { composeAttachments, DIRTY_ARGV, editedBetween, HEAD_ARGV, merged, movedArgv, parseList, PROJECT_FILE, routed, shown, tidy, under } from './attach'
import type { Dirty } from './attach'
import { askBrokerPrompt, brokerKind, diagnoseGroupsPrompt, brokerText, GROUPS_ARGV, kafkaBroker, KIND_NAME, kindOf, markedBroker, matching, NO_BROKER, peekArgv, peekEach, peekText, readGroups, readRecords, readTopics, settleBroker, standing, stuckFor, TOPICS_ARGV, topicsOf, unreadBroker } from './broker'
import { answerLimit, answerRowsText, askPrompt, diagnoseSessionsPrompt, byApp, byState, databaseText, HOLDS_SQL, isBlocked, isIdling, isPostgres, matchingRows, NO_DATABASE, psqlArgv, readHolds, readRows, querySql, rowsLimit, rowsSql, rowsText, sessionStanding, settleDatabase, sizeText, troubled, unreadDatabase } from './database'
import { askArgv, DEBUG_PORT, describeBrowser, EMPTY_BROWSER, readAsked } from './browser'
import type { Asked as Told } from './browser'
import { addressOf, AGENT, AGENT_TYPE, e2eText, fixPrompt, HOW_TO_PLAN, isUnderWay, PLAN_PROMPT, planned, queued, scenarioPrompt, scenarioTree, settled, stopped, tally, verdictOf } from './e2e'
import { actionLabel } from './kit/action-label'
import { badge } from './kit/badge'
import { card } from './kit/card'
import { divider } from './kit/divider'
import { paneView } from './kit/pane-text'
import { table } from './kit/table'
import type { TableCell } from './kit/table'
import { tonedText } from './kit/toned-text'
import { tree } from './kit/tree'
import { endedSuite, fixUnitPrompt, HOW_TO_PLAN_UNIT, PLAN_UNIT_PROMPT, plannedSuites, queuedSuites, SUITE_TIMEOUT_MS, suitesOf, suiteTree, unitText } from './unit'
import { around, BASELINE_NAME, BASELINES, causesOf, diagnosePrompt, guardPrompt, kindId, kindsOf, sinceText, told, untoldOf, untoldText } from './errors'
import { clockTime, EMPTY_WATCH, fresh, requestIds } from './lines'
import { ENV_FILES, isWindows, LISTENERS_ARGV, LOCAL_ENV_NOTE, localUsage, PROCESSES_ARGV, readEnvFile, readUnixProbe, readWindowsProbe, WINDOWS_PROBE_ARGV } from './local'
import type { Probe } from './local'
import { ATTACH_PROMPT, BROWSER_PROMPT, actionsText, actionTree, domText, HOW_TO_REPORT_ACTIONS, HOW_TO_REPORT_NETWORK, networkText, rendersSinceText, slowestFirst, answerText, vitalsText } from './report'
import { byKind, cpuText, domTree, EMPTY_FACTS, EMPTY_USAGE, envText, errorsText, HOW_TO_ATTACH, HOW_TO_READ_DOM, HOW_TO_READ_RENDERS, HOW_TO_REPORT_DOM, HOW_TO_REPORT_RENDERS, logsText, memoryText, renderTree, rendersNow, rendersText, statusText, timeline, usageText } from './report'
import type { LogsAsk } from './report'
import {
  COMPOSE_CONFIG_ARGV,
  COMPOSE_FILES,
  composeEnv,
  containersOf,
  ENV_NOTE,
  execArgv,
  fileHealth,
  imagesOf,
  logsArgv,
  podsArgv,
  previousArgvs,
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
import { isClimbing, offsetText, quieted, recorded, spark, tagColor, traceOf, traceSummary } from './trace'
import type { Row } from './trace'
import { endArgv, firstLine, kept, marked, markedNow, settle, TAIL, takeFile, takePrinted } from './watch'
import type { Taken } from './watch'

const PANE = 'runtime'
const TITLE = 'runtime'
const READ_TIMEOUT_MS = 8_000
// What the apps consume is asked of the machine less often than what they wrote: the asking is itself not free
const USAGE_EVERY_MS = 15_000
// How many lines of an error's trace the pane draws under it
const PANE_TRACE = 14
// A browser that did not answer is asked again by the timer this far apart, and at once by whoever asks
const BROWSER_AGAIN_MS = 30_000

const attachments = atom({ plugin: 'runtime', key: 'attachments' } as const, [] as Attachment[])
const isDiscovered = atom({ plugin: 'runtime', key: 'isDiscovered' } as const, false)
const watches = atom({ plugin: 'runtime', key: 'watches' } as const, {} as Record<string, Watch>)
const only = atom({ plugin: 'runtime', key: 'only' } as const, '')
const isErrorsOnly = atom({ plugin: 'runtime', key: 'isErrorsOnly' } as const, false)
const checkedAt = atom({ plugin: 'runtime', key: 'checkedAt' } as const, 0)
const facts = atom({ plugin: 'runtime', key: 'facts' } as const, {} as Record<string, Facts>)
const shownView = atom({ plugin: 'runtime', key: 'shown' } as const, 'logs' as Shown)
const opened = atom({ plugin: 'runtime', key: 'opened' } as const, [] as string[])
const rendersAs = atom({ plugin: 'runtime', key: 'rendersAs' } as const, 'tree' as RendersAs)
const browser = atom({ plugin: 'runtime', key: 'browser' } as const, EMPTY_BROWSER as Browser)
const home = atom({ plugin: 'runtime', key: 'home' } as const, '')
const scenarios = atom({ plugin: 'runtime', key: 'scenarios' } as const, [] as Scenario[])
const suites = atom({ plugin: 'runtime', key: 'suites' } as const, [] as Suite[])
const testsAs = atom({ plugin: 'runtime', key: 'testsAs' } as const, 'e2e' as TestsAs)
const EMPTY_PEEK: Peek = { label: '', topic: '', at: 0, note: '', records: [] }
const peek = atom({ plugin: 'runtime', key: 'peek' } as const, EMPTY_PEEK)
// How many of a topic's last records the pane reads from each partition
const PANE_PEEK = 10
const EMPTY_ROWS: Rows = { label: '', table: '', at: 0, note: '', rows: [] }
const rowsShown = atom({ plugin: 'runtime', key: 'rows' } as const, EMPTY_ROWS)
// How many of a table's last rows the pane reads
const PANE_ROWS = 10
const history = atom({ plugin: 'runtime', key: 'history' } as const, {} as Record<string, History>)
const since = atom({ plugin: 'runtime', key: 'since' } as const, 'edit' as Baseline)
const openError = atom({ plugin: 'runtime', key: 'openError' } as const, '')
const grepped = atom({ plugin: 'runtime', key: 'grep' } as const, '')
const traced = atom({ plugin: 'runtime', key: 'traced' } as const, '')
const pausedAt = atom({ plugin: 'runtime', key: 'pausedAt' } as const, 0)
const isNoisy = atom({ plugin: 'runtime', key: 'isNoisy' } as const, false)
const isHelped = atom({ plugin: 'runtime', key: 'isHelped' } as const, false)
// Empty until the person says either way in the pane: the option decides till then
const guarding = atom({ plugin: 'runtime', key: 'guarding' } as const, '' as '' | 'on' | 'off')

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
const view = paneView({ id: PANE, title: TITLE, command: '/runtime' })

const LEVEL_COLOR = { info: 'suggestion', warn: 'warning', error: 'error' } as const

const TONE = { up: 'success', degraded: 'warning', down: 'danger', unknown: 'neutral' } as const satisfies Record<Health['state'], string>

const TARGET = { type: 'string', description: 'The label of one watched attachment; left out, all of them.' } as const

// Each says first what it answers, then when to call it: the rest is in the answer itself
const TOOLS = [
  {
    name: 'status',
    description:
      'Whether what this session watches is healthy: each app, broker and database up or down and why, its restarts, its errors (the last kinds by name) and how many are new since the last edit, its CPU and memory. Reads afresh. Call it first when something running misbehaves.',
  },
  {
    name: 'logs',
    description:
      'The last log lines of the watched apps as one timeline: time, app, level, message, secrets taken out. Reads afresh. Call it instead of asking the person to paste logs. `request` follows one request id across every app, with how long after its first line each was written.',
    inputSchema: {
      type: 'object',
      properties: {
        target: TARGET,
        level: { type: 'string', enum: ['info', 'warn', 'error'], description: 'The lowest level to show; info when left out.' },
        grep: { type: 'string', description: 'Only the lines whose message holds this text, whatever its case.' },
        limit: { type: 'number', description: 'How many of the last matching lines; 50 when left out, 200 at most.' },
        request: { type: 'string', description: 'A request id (the value of rid=, request_id=, trace_id=): only the lines that name it, across every app.' },
        traces: { type: 'boolean', description: 'True to say the stack trace under each line that has one, instead of how many lines it is. With `level` "error", where each error was raised.' },
      },
    },
  },
  {
    name: 'errors_since_edit',
    description:
      "The errors a running app started writing after the last edit to its source, each kind once with its count and its stack trace: what the edit broke, apart from what was already wrong. An error that only follows another in the same request (the 500 an exception became) says which. A frontend's include its page's console, led by \"in the page:\". Reads afresh. Call it after editing a watched app, once it has reloaded, and before saying the change works. `since` counts from a mark or from the app's last start instead, or says every kind held with \"all\".",
    inputSchema: {
      type: 'object',
      properties: {
        target: TARGET,
        since: { type: 'string', enum: ['edit', 'mark', 'start', 'all'], description: 'What the errors are new since: the last edit (the default), the mark set with mcp__runtime__mark, or the last time the app started over (a restart, a rollout). "all" says every kind of error held, whatever it is new since: what is wrong with what runs, before any edit.' },
      },
    },
  },
  {
    name: 'mark',
    description:
      'Sets a mark on every watched app now: mcp__runtime__errors_since_edit with since "mark" then says the errors that first show after it. Call it before doing something that is no edit and may break what runs: a deploy, a migration, a restart, a scenario done by hand.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'resources',
    description:
      'The CPU (percent of one core) and memory of each watched app, against its limit where it has one. Reads afresh. Call it when an app is slow, restarts or may be leaking, and before and after a change meant to make it lighter. A local app needs two reads for its CPU.',
    inputSchema: { type: 'object', properties: { target: TARGET } },
  },
  {
    name: 'broker',
    description:
      "What a watched Redpanda broker holds: its topics with their record counts, and its consumer groups with state, members and lag, partition by partition where records wait, against what the lag was before the last edit. Reads afresh. Call it when what one app sends another does not arrive or arrives late. `topic` also reads that topic's last records (key, headers, value, secrets taken out) as no group, so nothing is marked as read.",
    inputSchema: {
      type: 'object',
      properties: {
        target: TARGET,
        topic: { type: 'string', description: 'A topic whose last records to read as well.' },
        limit: { type: 'number', description: 'How many of the last records of each partition of that topic; 5 when left out, 20 at most.' },
        grep: { type: 'string', description: 'Only the records of that topic whose key, headers or value hold this text, whatever its case: a request id, say.' },
      },
    },
  },
  {
    name: 'database',
    description:
      "What a watched PostgreSQL database holds: its sessions by state and by app, the ones that wait for a lock (and who holds it), idle in a transaction or running long, each with its statement, and its tables with rows, size and how they are read. Reads afresh, writing turned off. Call it when an app's queries hang, fail or are slow, or to check what an app wrote. `table` also reads that table's last rows as JSON; `sql` runs one SELECT of your own instead.",
    inputSchema: {
      type: 'object',
      properties: {
        target: TARGET,
        table: { type: 'string', description: 'A table whose last rows to read as well, by its name as this tool says it.' },
        limit: { type: 'number', description: 'How many of the last rows of that table; 5 when left out, 20 at most.' },
        grep: { type: 'string', description: 'Only the rows of that table that hold this text, whatever its case: a request id, say.' },
        sql: { type: 'string', description: 'One SELECT (or WITH, TABLE, VALUES) to run as well, with no `;` in it, writing turned off and five seconds to answer; 20 rows of its answer are read unless `limit` says otherwise, 50 at most.' },
      },
    },
  },
  {
    name: 'env',
    description:
      "The environment variables of each watched app, each with where it is set, secrets taken out. Reads afresh. Call it instead of asking the person how an app is configured: which URL it calls, which mode it runs in, whether a variable is set at all.",
    inputSchema: {
      type: 'object',
      properties: {
        target: TARGET,
        grep: { type: 'string', description: 'Only the variables whose name holds this text, whatever its case.' },
      },
    },
  },
  {
    name: 'renders',
    description:
      'Why the components of a watched Vue frontend rendered again: each reactivity chain once with its count, from the state that changed, through computed values and props, down to the component and its file. A chain "with nothing changed" is a render that could be spared. Asks the debug Chrome afresh. Call it when a page flickers, is slow or renders more than it should.',
    inputSchema: {
      type: 'object',
      properties: {
        target: TARGET,
        component: { type: 'string', description: 'Only the components whose name holds this text, whatever its case.' },
      },
    },
  },
  {
    name: 'renders_since_edit',
    description:
      "What the last edit to a watched frontend did to its renders: the chains that are new, the ones gone, and how often the others render now against before. Asks the browser afresh. Call it after an edit meant to make a page render less, once the page has been used again, and before saying it does.",
    inputSchema: { type: 'object', properties: { target: TARGET } },
  },
  {
    name: 'interactions',
    description:
      'What the person last did on a watched frontend\'s page (a click, a form sent, a field changed, a navigation; never what a field holds), each with what followed: the components that rendered, the requests the page made, and what every watched app wrote in the two seconds after. Asks the browser afresh. Call it to follow one click from the page to the server, or when the person says "when I click this, that happens".',
    inputSchema: {
      type: 'object',
      properties: {
        target: TARGET,
        limit: { type: 'number', description: 'How many of the last things done; 8 when left out, 30 at most.' },
      },
    },
  },
  {
    name: 'network',
    description:
      "What a watched frontend's page requested (fetch and XHR): each address once with its count, average and longest time, failures and last status, slowest first; and how the page loaded (first byte, largest paint, layout shift, slowest answer to a click, long tasks), each against before the last edit. Asks the browser afresh. Call it when a page is slow to load or to answer.",
    inputSchema: {
      type: 'object',
      properties: {
        target: TARGET,
        grep: { type: 'string', description: 'Only the addresses that hold this text, whatever its case.' },
      },
    },
  },
  {
    name: 'dom',
    description:
      "A watched frontend's page as it stands: its elements nested, each with its role, label, state and text, the component that draws it and that component's file; and what a screen reader cannot use (a control with no name, an image with no alt, a field with no label, a duplicate id). Never what a field holds. Asks the browser afresh. Call it to see the page without a screenshot, or to find which component draws something.",
    inputSchema: {
      type: 'object',
      properties: {
        target: TARGET,
        grep: { type: 'string', description: "Only the elements that hold this text in their tag, their attributes, their words or their component's name, each under the elements that hold it." },
      },
    },
  },
  {
    name: 'e2e_plan',
    description:
      "Writes the end-to-end checklist of a watched frontend: scenarios a person goes through on its page, each run later in the browser by a subagent that sees nothing of this conversation. Call it when asked to plan end-to-end scenarios, after reading the app's routes and pages. Write each step as one thing done, naming what is clicked or filled by the words the page shows, with the values to type. Replaces the checklist unless `add` is true. Runs nothing: mcp__runtime__e2e_run does.",
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
      'Runs scenarios of the end-to-end checklist, each on the page of the debug Chrome by a Haiku subagent, one after another. Answers at once with the run under way; mcp__runtime__e2e says what came of it. Call it after mcp__runtime__e2e_plan when asked to run the scenarios, and after a change to the frontend to check it still does what it did.',
    inputSchema: {
      type: 'object',
      properties: { ids: { type: 'array', items: { type: 'string' }, description: 'The numbers of the scenarios to run; left out, all of them.' } },
    },
  },
  {
    name: 'unit_plan',
    description:
      'Names the unit test suites of the project, one command each, for the person to run from the Tests view of the pane. Call it when asked to plan or set up the unit tests there, after reading how the project runs them (package.json, pyproject, Makefile, CI). A command is a list of arguments, never one line, with no pipe, no && and no watch mode: ["npm", "test", "--silent"]. Have it print a line per test (pytest -v, vitest --reporter=verbose, go test -v). Replaces the suites held. Runs nothing, and no tool does: the person runs them.',
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
      'The unit test suites of the runtime pane as they stand: each with its command, whether it passed when the person last ran it, how many tests passed and which failed, and the end of what a failing one printed. Call it when the person speaks of the unit tests of the pane, or of a suite that fails there.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The number of one suite, to read every test it ran and what it printed even if it passed; left out, all of them.' } },
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
      'The end-to-end checklist as it stands: each scenario with its steps, whether it passed, failed or could not be tried, why, and what its subagent reported. Call it once a run is over, before saying what works, and to see what is already planned.',
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

const take = async ($: EngineInterface, attachment: Attachment, cursor: Cursor, stand?: Stand): Promise<Taken> => {
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

  const argv = logsArgv(attachment, cursor.since, TAIL, stand?.printed)

  if (argv === undefined) return { raws: [], cursor, error: `${attachment.ref} names no workload` }

  // What a container that died wrote last is asked of the container that is gone, beside what runs now
  const [ran, ...last] = await Promise.all([$.process.run(argv, { timeoutMs: READ_TIMEOUT_MS }), ...previousArgvs(attachment, stand?.pods ?? '', cursor.since).map(previous => ask($, previous))])

  if (ran.exitCode !== 0) return { raws: [], cursor, error: firstLine(ran.stderr) || `${argv[0]} exited with ${ran.exitCode}` }

  const died = last.flatMap(previous => (previous?.exitCode === 0 ? [previous.stdout] : []))

  return takePrinted(attachment.runtime, { ...ran, stdout: [...died, ran.stdout].join('\n') }, cursor)
}

/** How an attachment stands, and what its status command printed: its environment and its containers are read off that too. */
type Stand = { health: Health; printed: string; pods: string }

const standOf = async ($: EngineInterface, attachment: Attachment, now: number): Promise<Stand> => {
  if (attachment.runtime === 'local') {
    return { health: fileHealth(await $.fs.stat(attachment.ref).then(stat => (stat.kind === 'file' ? stat.mtimeMs : undefined), () => undefined), now), printed: '', pods: '' }
  }

  const argv = statusArgv(attachment)

  if (argv === undefined) return { health: { state: 'unknown', detail: '', restarts: 0 }, printed: '', pods: '' }

  const ran = await $.process.run(argv, { timeoutMs: READ_TIMEOUT_MS }).catch(() => undefined)

  if (ran === undefined) return { health: { state: 'unknown', detail: `${argv[0]} did not answer`, restarts: 0 }, printed: '', pods: '' }

  if (ran.exitCode !== 0) {
    return { health: { state: 'down', detail: /no such|not ?found/i.test(ran.stderr) ? 'not found' : firstLine(ran.stderr).slice(0, 40), restarts: 0 }, printed: '', pods: '' }
  }

  // A workload's pods say what it does not: why one is not ready, how often its containers died
  const listing = podsArgv(attachment, ran.stdout)
  const listed = listing === undefined ? undefined : await ask($, listing)
  const pods = listed?.exitCode === 0 ? listed.stdout : attachment.runtime === 'kubernetes' ? ran.stdout : ''

  return { health: readHealth(attachment.runtime, ran.stdout, pods), printed: ran.stdout, pods }
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
 * What each broker among the attachments holds, by label, and what there is to tell the person of it: its topics
 * and its consumer groups, asked of the broker's own command line, run inside it. One that did not answer keeps
 * what it last said, with why.
 */
const brokersOf = async ($: EngineInterface, seen: readonly Seen[], known: Record<string, Facts>, now: number): Promise<{ brokers: Record<string, Broker>; said: string[] }> => {
  const said: string[] = []

  const found = await Promise.all(
    seen.map(async ({ attachment, printed }): Promise<(readonly [string, Broker])[]> => {
      const { label, runtime } = attachment
      const was = known[label]?.broker
      const kind = brokerKind(imagesOf(runtime, printed))

      // One that does not answer how it stands is still the broker it was
      if (kind === undefined) return was === undefined || printed !== '' ? [] : [[label, unreadBroker(was.kind, 'It could not be asked: what follows is what it last said.', now, was)]]
      if (kind === 'kafka') return [[label, kafkaBroker(now)]]

      const [topics, groups] = await Promise.all([ask($, execArgv(attachment, TOPICS_ARGV) ?? []), ask($, execArgv(attachment, GROUPS_ARGV) ?? [])])

      if (topics?.exitCode !== 0 || groups?.exitCode !== 0) {
        const why = topics?.exitCode !== 0 ? refusal(topics, 'rpk topic describe') : refusal(groups, 'rpk group describe')

        return [[label, unreadBroker(kind, `It could not be asked (${why})${was === undefined ? '.' : ': what follows is what it last said.'}`, now, was)]]
      }

      const settled = settleBroker(was, { topics: readTopics(topics.stdout), groups: readGroups(groups.stdout) }, label, now)

      said.push(...settled.said)

      return [[label, settled.broker]]
    }),
  )

  return { brokers: Object.fromEntries(found.flat()), said }
}

/**
 * Reads the last records of a topic for the pane's Broker view, which is then open on it. Read as no group: nothing
 * is marked as read. What cannot be read is said in their place.
 */
const peekInto = async ($: EngineInterface, label: string, topic: string): Promise<void> => {
  const attachment = (await read($, attachments)).find(held => held.label === label)
  const held = (await read($, facts))[label]?.broker?.topics.find(({ name }) => name === topic)
  const at = await $.clock.now()
  const shown = (note: string, records: Peek['records'] = []) => update($, peek, () => ({ label, topic, at, note, records }))

  if (attachment === undefined || held === undefined) return void (await shown(`${label} has no topic ${topic} now.`))

  const argv = peekArgv(held, PANE_PEEK)

  if (argv === undefined) return void (await shown('It holds no message.'))

  const ran = await ask($, execArgv(attachment, argv) ?? [])

  await (ran?.exitCode === 0 ? shown('', readRecords(ran.stdout)) : shown(`Its messages could not be read: ${refusal(ran, 'rpk topic consume')}.`))
}

/**
 * What each database among the attachments holds, by label, and what there is to tell the person of it: its
 * sessions and its tables, asked of the database's own command line, run inside it. One that did not answer keeps
 * what it last said, with why.
 */
const databasesOf = async ($: EngineInterface, seen: readonly Seen[], known: Record<string, Facts>, now: number): Promise<{ databases: Record<string, Database>; said: string[] }> => {
  const said: string[] = []

  const found = await Promise.all(
    seen.map(async ({ attachment, printed }): Promise<(readonly [string, Database])[]> => {
      const { label, runtime } = attachment
      const was = known[label]?.database

      // One that does not answer how it stands is still the database it was
      if (!isPostgres(imagesOf(runtime, printed))) return was === undefined || printed !== '' ? [] : [[label, unreadDatabase('It could not be asked: what follows is what it last said.', now, was)]]

      const ran = await ask($, execArgv(attachment, psqlArgv(HOLDS_SQL)) ?? [])
      const read = ran?.exitCode === 0 ? readHolds(ran.stdout) : undefined

      if (read === undefined) return [[label, unreadDatabase(`It could not be asked (${refusal(ran, 'psql')})${was === undefined ? '.' : ': what follows is what it last said.'}`, now, was)]]

      const settled = settleDatabase(was, read, label, now)

      said.push(...settled.said)

      return [[label, settled.database]]
    }),
  )

  return { databases: Object.fromEntries(found.flat()), said }
}

/** Reads the last rows of a table for the pane's Database view, which is then open on it. What cannot be read is said in their place. */
const rowsInto = async ($: EngineInterface, label: string, table: string): Promise<void> => {
  const attachment = (await read($, attachments)).find(held => held.label === label)
  const database = (await read($, facts))[label]?.database
  const at = await $.clock.now()
  const shown = (note: string, rows: string[] = []) => update($, rowsShown, () => ({ label, table, at, note, rows }))
  const sql = database === undefined ? undefined : rowsSql(database, table, PANE_ROWS)

  if (attachment === undefined || sql === undefined) return void (await shown(`${label} has no table ${table} now.`))

  const ran = await ask($, execArgv(attachment, psqlArgv(sql)) ?? [])

  await (ran?.exitCode === 0 ? shown('', readRows(ran.stdout)) : shown(`Its rows could not be read: ${refusal(ran, 'psql')}.`))
}

/**
 * What a read asks for besides the lines and the state: what the apps consume, the environments that take a read
 * of their own, what the brokers and the databases hold (asked for together), and what the browser says of the frontends, asked on the debug port named
 * (0 or none: not asked).
 */
type Want = { usage: boolean; env: boolean; broker?: boolean; browser?: number }

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
          // How it stands first: a workload's lines are asked of the pods its status names
          const stand = await standOf($, attachment, now)
          const lines = await take($, attachment, cursor, stand).catch((failure: unknown): Taken => ({ raws: [], cursor, error: firstLine(failure instanceof Error ? failure.message : String(failure)) }))

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
    const [usages, envs, asked, queried] = await Promise.all([
      want.usage ? usagesOf($, reads, known, now) : ({} as Record<string, Usage>),
      envsOf($, reads, want.env),
      want.broker === true ? brokersOf($, reads, known, now) : { brokers: {} as Record<string, Broker>, said: [] },
      want.broker === true ? databasesOf($, reads, known, now) : { databases: {} as Record<string, Database>, said: [] },
    ])

    if (want.usage) usageReadAt = now

    // The figures of this read, added to the line each row draws
    if (want.usage || want.broker === true) {
      await update($, history, held =>
        Object.fromEntries(
          targets.map(({ label }) => {
            const groups = asked.brokers[label]?.kind === 'redpanda' ? asked.brokers[label]?.groups : undefined

            return [label, recorded(held[label], usages[label], groups === undefined ? -1 : groups.reduce((sum, group) => sum + group.lag, 0))] as const
          }),
        ),
      )
    }

    await update($, facts, held => ({
      ...held,
      ...Object.fromEntries(
        targets.map(({ label }) => {
          // The lag kept at an edit counted while the commands ran stays
          const broker = asked.brokers[label] === undefined ? undefined : { ...asked.brokers[label], lagAtEdit: held[label]?.broker?.lagAtEdit, editedPath: held[label]?.broker?.editedPath, editedAt: held[label]?.broker?.editedAt }

          // What it is, told by its image each time its status is read; one that did not answer is what it was
          const told = reads.find(read => read.label === label)
          const kind = told === undefined ? undefined : kindOf(imagesOf(told.attachment.runtime, told.printed))

          return [label, { ...(held[label] ?? EMPTY_FACTS), ...kind, ...envs[label], ...(usages[label] === undefined ? {} : { usage: usages[label] }), ...(broker === undefined ? {} : { broker }), ...(queried.databases[label] === undefined ? {} : { database: queried.databases[label] }) }] as const
        }),
      ),
    }))

    // The topic the pane is open on is read again with its broker
    const open = await read($, peek)

    if (want.broker === true && open.topic !== '' && (await read($, shownView)) === 'broker') await peekInto($, open.label, open.topic).catch(() => undefined)

    // And the table, with its database
    const table = await read($, rowsShown)

    if (want.broker === true && table.table !== '' && (await read($, shownView)) === 'database') await rowsInto($, table.label, table.table).catch(() => undefined)

    // Settled on the watches as they stand now: an edit counted while the commands ran keeps its count
    let said: string[] = []

    await update($, watches, held => {
      const settled = settle(held, reads, now)

      said = settled.said

      return settled.watches
    })

    await update($, checkedAt, () => now)

    for (const text of [...said, ...asked.said, ...queried.said]) $.ui.toast(text)

    await guard($).catch(() => undefined)
  })

// Whether the option has Claude guard its edits, where the person has not said in the pane
let guardsByOption = false

const isGuarded = async ($: EngineInterface): Promise<boolean> => {
  const said = await read($, guarding)

  return said === '' ? guardsByOption : said === 'on'
}

// Whether a turn of the main conversation runs. A reload starts it over as none, and the next turn sets it.
let isTurnRunning = false

/**
 * The errors that are new since an edit and that Claude has not been handed, as what it reads beside something
 * else: said once. None where there is none.
 */
const handOver = async ($: EngineInterface): Promise<string | undefined> => {
  const untold = untoldOf(await read($, attachments), await read($, watches))

  if (untold.length === 0) return undefined

  await update($, watches, told)

  return untoldText(untold)
}

/**
 * Where the person has Claude guard its edits: an error that is new since one, seen while no turn runs, is handed
 * to Claude at once as a prompt. While a turn runs it is read beside the next tool's result instead.
 */
const guard = async ($: EngineInterface): Promise<void> => {
  if (isTurnRunning || !(await isGuarded($))) return

  const untold = untoldOf(await read($, attachments), await read($, watches))

  if (untold.length === 0) return

  await update($, watches, told)
  void $.prompt.submit({ text: guardPrompt(untold) })
}

const plansKey = (folder: string): string => `plans:${folder}`

// What was planned is kept by the project, so the next session finds its checklist and its suites
const keepPlans = async ($: EngineInterface): Promise<void> => {
  const plans: Plans = { scenarios: await read($, scenarios), suites: await read($, suites) }

  await $.store.set(plansKey(await homeOf($)), plans).catch(() => undefined)
}

// What a session before this one planned here, where this one has planned nothing: what ran then is to run again
const recallPlans = async ($: EngineInterface): Promise<void> => {
  if ((await read($, scenarios)).length > 0 || (await read($, suites)).length > 0) return

  const held = (await $.store.get(plansKey(await homeOf($))).catch(() => undefined)) as Partial<Plans> | undefined
  const rested = <Held extends { state: Scenario['state'] }>(list: unknown): Held[] =>
    (Array.isArray(list) ? (list as Held[]) : []).map(item => (item.state === 'running' || item.state === 'queued' ? { ...item, state: 'todo' as const } : item))

  await update($, scenarios, () => rested<Scenario>(held?.scenarios).map(scenario => ({ ...scenario, agentId: '' })))
  await update($, suites, () => rested<Suite>(held?.suites))
}

// Counts an edit against the attachments. A broker is nobody's source: an edit to any app is one it may tell of,
// since what one app sends is what another reads, so every broker keeps how its groups stood.
const mark = ($: EngineInterface, labels: readonly string[], path: string, from?: number): Promise<void> =>
  inTurn(async () => {
    const now = await $.clock.now()

    await update($, watches, held => marked(held, labels, path, now, from))
    await update($, facts, held => Object.fromEntries(Object.entries(held).map(([label, known]) => [label, known.broker === undefined ? known : { ...known, broker: markedBroker(known.broker, path, now) }])))
  })

// What git listed at the last look at the working tree, and the commit it stood on. A reload drops it with the
// module, and the next look only takes stock.
let looked: { at: number; head: string; files: Dirty } | undefined

// One look at a time: two would both count what was written since the same one before
let looking: Promise<unknown> = Promise.resolve()

// How many files one look reads the time of: a tree with more changed than that is looked at in part
const MAX_LOOKED = 400

const WATCHED_NOTE = (labels: readonly string[]): string =>
  `The runtime mod watches the running ${labels.join(', ')}, which this file is part of. Once it has reloaded, mcp__runtime__errors_since_edit says whether an edit broke it, and mcp__runtime__logs shows what it writes. For a frontend open in the debug Chrome, mcp__runtime__renders_since_edit says what the edit did to its renders, and mcp__runtime__network to its requests and its load.`

/**
 * Counts against the attachments the edits nobody announced: a file written by a shell command, a checkout or the
 * person's own editor, found by asking git what differs and reading when each such file was last written. The
 * first look only takes stock, and so does one that `isOwn`: made after an edit already counted. Answers with the
 * labels that were edited for the first time. Where the project is no git repository, nothing is found.
 */
const lookForEdits = ($: EngineInterface, isOwn = false): Promise<string[]> => {
  const work = async (): Promise<string[]> => {
    const list = await read($, attachments)

    if (list.length === 0) return []

    const cwd = await homeOf($)
    const inProject = (argv: readonly string[]): Promise<Ran> => $.process.run(argv, { cwd, timeoutMs: READ_TIMEOUT_MS }).catch(() => undefined)
    const [listed, stands] = await Promise.all([inProject(DIRTY_ARGV), inProject(HEAD_ARGV)])

    if (listed?.exitCode !== 0) return []

    const head = stands?.exitCode === 0 ? stands.stdout.trim() : ''
    const names = (text: string): string[] => text.split('\0').filter(name => name !== '')
    // A checkout, a pull: the files the two commits differ by were written though git now lists none of them
    const moved = looked !== undefined && looked.head !== '' && head !== '' && looked.head !== head ? await inProject(movedArgv(looked.head, head)) : undefined
    const dirty = names(listed.stdout)
    const paths = [...new Set([...dirty, ...Object.keys(looked?.files ?? {}), ...(moved?.exitCode === 0 ? names(moved.stdout) : [])])].slice(0, MAX_LOOKED)
    const written = await Promise.all(paths.map(path => $.fs.stat(under(cwd, path)).then(stat => (stat.kind === 'file' ? stat.mtimeMs : -1), () => -1)))
    const now: Dirty = Object.fromEntries(paths.map((path, index) => [path, written[index] ?? -1]))
    const at = await $.clock.now()
    const before = looked

    looked = { at, head, files: Object.fromEntries(Object.entries(now).filter(([path]) => dirty.includes(path))) }

    if (before === undefined || isOwn) return []

    const firsts: string[] = []

    for (const path of editedBetween(before.files, now, before.at)) {
      const labels = routed(list, path, cwd).map(({ label }) => label)

      if (labels.length === 0) continue

      const held = await read($, watches)

      firsts.push(...labels.filter(label => (held[label] ?? EMPTY_WATCH).edits === 0 && !firsts.includes(label)))
      await mark($, labels, path, (now[path] ?? -1) > 0 ? now[path] : at)
    }

    return firsts
  }

  const ran = looking.then(work, work)

  looking = ran.catch(() => undefined)

  return ran
}

/** What the options say: the attachments named there, how often to read, and the browser's debug port (0: never asked). */
type Asked = { attachments: unknown; seconds: number; port: number }

const tick = ($: EngineInterface, { seconds, port }: Asked, count: number) => {
  if (ticking !== undefined || seconds <= 0 || count === 0) return

  ticking = $.clock.every(Math.max(1, seconds) * 1000, () => {
    void $.clock
      .now()
      .then(now => pull($, undefined, { usage: now - usageReadAt >= USAGE_EVERY_MS, env: false, broker: now - usageReadAt >= USAGE_EVERY_MS, browser: isBrowserReached || now - browserAskedAt >= BROWSER_AGAIN_MS ? port : 0 }))
      // What the person wrote in their own editor meanwhile is an edit too
      .then(() => lookForEdits($))
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
  await pull($, undefined, { usage: true, env: true, broker: true, browser: asked.port }).catch(() => undefined)

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

  await keepPlans($)

  if (held.length > 0) $.ui.toast(`runtime unit tests: ${tally(held).label}`)
}

export const register: Register = (on, options) => {
  guardsByOption = options?.guard === true

  const asked: Asked = {
    attachments: options?.attachments,
    seconds: typeof options?.pollSeconds === 'number' && Number.isFinite(options.pollSeconds) ? options.pollSeconds : 5,
    port: typeof options?.browserPort === 'number' && Number.isFinite(options.browserPort) ? Math.max(0, Math.round(options.browserPort)) : DEBUG_PORT,
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'runtime', description: 'Open the pane that watches the running app: its logs, its state, its new errors, what it consumes, its environment, what a broker or a database among them holds, why its components render, what is done on its page and what the page asks for, and the end-to-end scenarios run on it, and the unit tests of the project' })

    // A host that registers no tools still starts the session
    for (const tool of [view.tool, ...TOOLS]) await $.tool.register(tool).catch(() => undefined)

    // The agent type a scenario is run by, which only the runtime mod starts
    await $.agent.register(AGENT).catch(() => undefined)

    // Taken now, before any command has moved the shell
    await homeOf($).catch(() => undefined)
    await recallPlans($).catch(() => undefined)

    return next(e)
  })

  // The pane as text, for the model
  on('tool.call', { tool: 'mcp__runtime__pane' }, $ => view.answer(() => $.ui.panes()))

  on('tool.call', { tool: 'mcp__runtime__status' }, async $ => {
    const { list, held, known, seen } = await current($, asked, { usage: true, env: false, broker: true, browser: asked.port })

    return { result: statusText(list, held, known, asked.port === 0 ? undefined : seen, await $.clock.now()) }
  })

  on('tool.call', { tool: 'mcp__runtime__broker' }, async ($, e) => {
    const { list, known } = await current($, asked, { usage: false, env: false, broker: true })
    const { target, topic, limit, grep } = e as unknown as { target?: unknown; topic?: unknown; limit?: unknown; grep?: unknown }
    const text = brokerText(list, known, { target }, await $.clock.now())
    const named = typeof topic === 'string' ? topic.trim() : ''

    if (named === '') return { result: text }

    // The topic's last records, of each broker asked about that has it
    const holders = list.filter(({ label }) => (typeof target !== 'string' || target.trim() === '' || label === target.trim()) && known[label]?.broker?.kind === 'redpanda')

    const peeks = await Promise.all(
      holders.map(async attachment => {
        const held = known[attachment.label]?.broker?.topics.find(({ name }) => name === named)

        if (held === undefined) return `${attachment.label} has no topic ${named}.`

        const argv = peekArgv(held, peekEach(limit))

        if (argv === undefined) return `${named} on ${attachment.label} holds no record.`

        const ran = await ask($, execArgv(attachment, argv) ?? [])

        return ran?.exitCode === 0 ? peekText(attachment.label, named, matching(readRecords(ran.stdout), grep), typeof grep === 'string' ? grep.trim() : '') : `The records of ${named} on ${attachment.label} could not be read: ${refusal(ran, 'rpk topic consume')}.`
      }),
    )

    return { result: [text, ...peeks].join('\n\n') }
  })

  on('tool.call', { tool: 'mcp__runtime__database' }, async ($, e) => {
    const { list, known } = await current($, asked, { usage: false, env: false, broker: true })
    const { target, table, limit, grep, sql: written } = e as unknown as { target?: unknown; table?: unknown; limit?: unknown; grep?: unknown; sql?: unknown }
    const text = databaseText(list, known, { target })
    const named = typeof table === 'string' ? table.trim() : ''
    // Each database asked about
    const holders = list.filter(({ label }) => (typeof target !== 'string' || target.trim() === '' || label === target.trim()) && known[label]?.database !== undefined)

    // A statement of the model's own: its answer alone, without what the database holds besides
    if (typeof written === 'string' && written.trim() !== '') {
      const most = answerLimit(limit)
      const query = querySql(written, most)

      if ('refused' in query) return { result: query.refused }
      if (holders.length === 0) return { result: text }

      const answers = await Promise.all(
        holders.map(async attachment => {
          const ran = await ask($, execArgv(attachment, psqlArgv(query.sql, true)) ?? [])

          return ran?.exitCode === 0 ? answerRowsText(attachment.label, most, readRows(ran.stdout, false)) : `${attachment.label} did not answer it: ${ran === undefined ? 'psql did not answer' : ran.stderr.trim().slice(0, 600) || `psql exited with ${ran.exitCode}`}`
        }),
      )

      return { result: answers.join('\n\n') }
    }

    if (named === '') return { result: text }

    const reads = await Promise.all(
      holders.map(async attachment => {
        const sql = rowsSql(known[attachment.label]?.database ?? { tables: [] }, named, rowsLimit(limit))

        if (sql === undefined) return `${attachment.label} has no table ${named}.`

        const ran = await ask($, execArgv(attachment, psqlArgv(sql)) ?? [])

        return ran?.exitCode === 0 ? rowsText(attachment.label, named, matchingRows(readRows(ran.stdout), grep), typeof grep === 'string' ? grep.trim() : '') : `The rows of ${named} on ${attachment.label} could not be read: ${refusal(ran, 'psql')}.`
      }),
    )

    return { result: [text, ...reads].join('\n\n') }
  })

  on('tool.call', { tool: 'mcp__runtime__resources' }, async ($, e) => {
    const { list, known } = await current($, asked, { usage: true, env: false })

    return { result: usageText(list, known, e as unknown as { target?: unknown }) }
  })

  on('tool.call', { tool: 'mcp__runtime__env' }, async ($, e) => {
    const { list, known } = await current($, asked, { usage: false, env: true })

    return { result: envText(list, known, e as unknown as { target?: unknown; grep?: unknown }) }
  })

  on('tool.call', { tool: 'mcp__runtime__renders' }, async ($, e) => {
    const { list, held, seen } = await current($, asked, { usage: false, env: false, browser: asked.port })

    return { result: rendersText(list, held, e as unknown as { target?: unknown; component?: unknown }, asked.port === 0 ? undefined : seen, await homeOf($)) }
  })

  on('tool.call', { tool: 'mcp__runtime__renders_since_edit' }, async ($, e) => {
    const { list, held } = await ofBrowser($, asked)

    return { result: rendersSinceText(list, held, e as unknown as { target?: unknown }, await $.clock.now()) }
  })

  on('tool.call', { tool: 'mcp__runtime__interactions' }, async ($, e) => {
    const { list, held, seen } = await ofBrowser($, asked)

    return { result: actionsText(list, held, e as unknown as { target?: unknown; limit?: unknown }, asked.port === 0 ? undefined : seen) }
  })

  on('tool.call', { tool: 'mcp__runtime__network' }, async ($, e) => {
    const { list, held, seen } = await ofBrowser($, asked)

    return { result: networkText(list, held, e as unknown as { target?: unknown; grep?: unknown }, asked.port === 0 ? undefined : seen) }
  })

  on('tool.call', { tool: 'mcp__runtime__dom' }, async ($, e) => {
    const { list, held, seen } = await ofBrowser($, asked)

    return { result: domText(list, held, e as unknown as { target?: unknown; grep?: unknown }, asked.port === 0 ? undefined : seen, await homeOf($)) }
  })

  // A scenario is started by the runtime mod alone, which is what keeps its place in the checklist
  on('agent.offer', { agent: 'runtime:e2e' }, () => ({ isOffered: false }))

  on('tool.call', { tool: 'mcp__runtime__e2e_plan' }, async ($, e) => {
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

    await keepPlans($)

    return { result: [...refused.map(line => `Left out: ${line}.`), e2eText(held), '', 'Nothing has run. mcp__runtime__e2e_run runs them, each on the page by a subagent of its own; the person can too, from the Tests view of the pane.'].join('\n') }
  })

  on('tool.call', { tool: 'mcp__runtime__e2e_run' }, async ($, e) => {
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
          : `${waiting} scenario${waiting === 1 ? ' is' : 's are'} under way, each run on the page by a subagent of its own, one after another. Nothing is to be done meanwhile: mcp__runtime__e2e says what came of them once they have answered.`,
    }
  })

  on('tool.call', { tool: 'mcp__runtime__unit_plan' }, async ($, e) => {
    const list = await ensure($, asked.attachments)
    const plan = plannedSuites(e as unknown as { suites?: unknown }, list.map(({ label }) => label))

    await update($, suites, () => plan.suites)
    await keepPlans($)
    await update($, shownView, () => 'tests' as Shown)
    await update($, testsAs, () => 'unit' as TestsAs)
    await $.ui.open({ id: PANE, title: TITLE }).catch(() => undefined)

    return { result: [...plan.refused.map(line => `Left out: ${line}.`), unitText(plan.suites), '', 'Nothing has run: the person runs them from the Tests view of the pane.'].join('\n') }
  })

  on('tool.call', { tool: 'mcp__runtime__unit' }, async ($, e) => ({ result: unitText(await read($, suites), e as unknown as { id?: unknown }) }))

  on('tool.call', { tool: 'mcp__runtime__e2e_stop' }, async $ => {
    const held = await inTurn(() => update($, scenarios, stopped))

    await keepPlans($)

    return { result: e2eText(held) }
  })

  on('tool.call', { tool: 'mcp__runtime__e2e' }, async ($, e) => ({ result: e2eText(await read($, scenarios), e as unknown as { id?: unknown }) }))

  // A subagent's answer is its turn's end: the scenario it ran is settled on it, and the next one started
  on('turn.complete', async ($, e, next) => {
    const agentId = e.agentId

    // The main conversation's turn is over. An app takes a moment to reload after the turn's last edit: what that
    // brings is handed over by the timer's next read, and what is already seen, now.
    if (agentId === undefined) {
      isTurnRunning = false

      const answer = await next(e)

      await guard($).catch(() => undefined)

      return answer
    }

    if ( !(await read($, scenarios)).some(scenario => scenario.state === 'running' && scenario.agentId === agentId)) return next(e)

    const held = await inTurn(async () => {
      await update($, scenarios, list => settled(list, agentId, verdictOf(e.answer, e.reason), e.answer, e.durationMs))
      await runNext($)

      return read($, scenarios)
    }).catch(() => undefined)

    await keepPlans($).catch(() => undefined)

    // Said once, when the last of a run has answered
    if (held !== undefined && held.length > 0 && !isUnderWay(held)) $.ui.toast(`runtime e2e: ${tally(held).label}`)

    return next(e)
  })

  on('tool.call', { tool: 'mcp__runtime__logs' }, async ($, e) => {
    const { list, held } = await current($, asked)

    return { result: logsText(list, held, e as unknown as LogsAsk) }
  })

  on('tool.call', { tool: 'mcp__runtime__errors_since_edit' }, async ($, e) => {
    const { list, held } = await current($, asked)

    // What it reads here it need not be handed again
    await update($, watches, told)

    return { result: errorsText(list, held, e as unknown as { target?: unknown; since?: unknown }) }
  })

  on('tool.call', { tool: 'mcp__runtime__mark' }, async $ => {
    const { list } = await current($, asked)
    const now = await $.clock.now()

    await inTurn(() => update($, watches, held => markedNow(held, list.map(({ label }) => label), now)))

    return { result: list.length === 0 ? HOW_TO_ATTACH : `A mark is set on ${list.map(({ label }) => label).join(', ')} at ${clockTime(now)}. mcp__runtime__errors_since_edit with since "mark" says the errors that first show from now on.` }
  })

  // While a turn of the main conversation runs, what is new is read beside a tool's result; between two, with the next prompt
  on('turn.start', ($, e, next) => {
    isTurnRunning = true

    return next(e)
  })

  // Beside the result of whatever Claude does next: the errors its edit brought, without its asking
  on('tool.call', async ($, e, next) => {
    const answer = await next(e)

    if (answer.result === undefined || String(e.tool).startsWith('mcp__runtime__')) return answer

    const news = await handOver($).catch(() => undefined)

    return news === undefined ? answer : { ...answer, context: [...(answer.context ?? []), news] }
  })

  // And with the person's next prompt, where no tool was called since
  on('prompt.submit', async ($, e, next) => {
    const news = await handOver($).catch(() => undefined)

    return next(news === undefined ? e : { ...e, context: [...(e.context ?? []), news] })
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
    // The look at the working tree takes this one for counted
    await lookForEdits($, true).catch(() => undefined)

    // Said once per attachment: the model has no other way to know that what it edits is being watched
    if (firsts.length === 0) return answer

    return { ...answer, context: [...(answer.context ?? []), WATCHED_NOTE(firsts)] }
  })

  // A command may write files too (sed, a generator, a checkout): the working tree is looked at before it and
  // after, and what was written between is its edit
  on('tool.call', { tool: ['Bash', 'NotebookEdit'] }, async ($, e, next) => {
    if ((await ensure($, asked.attachments)).length === 0) return next(e)

    await lookForEdits($).catch(() => undefined)

    const answer = await next(e)
    const firsts = await lookForEdits($).catch(() => [] as string[])

    // A call refused runs nothing, and carries no note
    return firsts.length === 0 || 'deny' in answer ? answer : { ...answer, context: [...(answer.context ?? []), WATCHED_NOTE(firsts)] }
  })

  on('command.run', { command: 'runtime' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })

    const list = await refresh($, asked)

    if (list.length === 0) return { text: HOW_TO_ATTACH }

    const held = await read($, watches)
    const down = list.filter(({ label }) => held[label]?.health.state === 'down').map(({ label }) => label)

    return { text: `The runtime mod watches ${list.map(({ label }) => label).join(', ')}.${down.length > 0 ? ` Down: ${down.join(', ')}.` : ''}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Button, Text } = elements
    // The mobile app draws no field: the question is asked of Claude in the prompt there
    const Input = 'Input' in elements ? elements.Input : undefined
    const width = e.props.bodyColumns ?? 80
    const list = await read($, attachments)
    const held = await read($, watches)
    const picked = await read($, only)
    const errorsOnly = await read($, isErrorsOnly)
    const at = await read($, checkedAt)
    const known = await read($, facts)
    const drawnAt = await $.clock.now()
    const showing = await read($, shownView)
    const open = await read($, opened)
    const drawAs = await read($, rendersAs)
    const seen = await read($, browser)
    const scenariosHeld = await read($, scenarios)
    const suitesHeld = await read($, suites)
    const testing = await read($, testsAs)
    const peeked = await read($, peek)
    const rowed = await read($, rowsShown)
    const pasts = await read($, history)
    const baseline = await read($, since)
    const openedError = await read($, openError)
    const grep = await read($, grepped)
    const follows = await read($, traced)
    const paused = await read($, pausedAt)
    const noisy = await read($, isNoisy)
    const helped = await read($, isHelped)
    const guarded = await isGuarded($)

    const watchOf = (label: string) => held[label] ?? EMPTY_WATCH
    const factsOf = (label: string) => known[label] ?? EMPTY_FACTS
    const down = list.filter(({ label }) => watchOf(label).health.state === 'down').length
    const news = list.reduce((sum, { label }) => sum + fresh(watchOf(label)).length, 0)
    // The apps, the brokers and the databases, each drawn apart
    const sections = byKind(list, known)

    const summary =
      list.length === 0
        ? badge({ label: 'nothing attached', tone: 'neutral' })
        : at === 0
          ? badge({ label: `${list.length} attached, not read yet`, tone: 'neutral' })
          : badge({
              label: `${sections.length === 1 && sections[0]?.kind === 'app' ? `${list.length} watched` : sections.map(({ one, many, members }) => `${members.length} ${members.length === 1 ? one : many}`).join(' · ')} · ${down} down · ${news} new error${news === 1 ? '' : 's'}`,
              tone: down > 0 || news > 0 ? 'danger' : 'success',
            })

    // The last figures of each, as a line beside the figure, where the pane is wide enough for both
    const hasSparks = width >= 100
    // In a side pane the table keeps its columns narrow, so its state is not squeezed out: memory says what is held alone
    const isNarrow = width < 72
    const CELL_SPARK = 6
    const figure = (past: readonly number[], text: string): string => (text === '' ? '' : hasSparks && spark(past, CELL_SPARK) !== '' ? `${spark(past, CELL_SPARK).padStart(CELL_SPARK)} ${text}` : text)
    const pastOf = (label: string): History => pasts[label] ?? { cpu: [], memory: [], lag: [] }
    // What needs no look is drawn dimly: the eye goes to what is colored
    const dim = (text: string) => (
      <Text key={`dim-${text}`} color="subtle" wrap="truncate-end">
        {text}
      </Text>
    )

    type Drawn = { name: TableCell; state: TableCell; cpu: TableCell; memory: TableCell; errors: TableCell }

    const rowOf = ({ label }: Attachment): Drawn => {
      const watch = watchOf(label)
      const total = watch.signatures.reduce((sum, signature) => sum + signature.count, 0)
      const newCount = fresh(watch).length
      const { state, detail, restarts } = watch.health
      const standing = [state, detail, restarts > 0 ? `${restarts} restarts` : ''].filter(part => part !== '').join(' · ')
      const past = pastOf(label)
      const inUse = memoryText(factsOf(label).usage)
      const memory = figure(past.memory, isNarrow ? (inUse.split(' / ')[0] ?? inUse) : inUse)

      return {
        // A row is its own filter: pressed, the views show it alone; pressed again, all
        name: (
          <Button key={`show-${label}`} plain onPress={() => update($, only, was => (was === label ? '' : label))}>
            {tonedText({ text: `${picked === label ? '▸ ' : ''}${label}`, ...(picked === label ? { tone: 'accent' as const, bold: true } : {}) })}
          </Button>
        ),
        state: watch.error !== '' ? { text: watch.error, tone: 'danger' } : state === 'up' && restarts === 0 ? dim(standing) : { text: standing, tone: TONE[state] },
        cpu: figure(past.cpu, cpuText(factsOf(label).usage)),
        // Memory that only ever grew over the last reads may be a leak
        memory: isClimbing(past.memory) ? { text: memory, tone: 'warning' } : memory,
        errors: newCount > 0 ? { text: `${total} · ${newCount} new`, tone: 'danger' } : dim(String(total)),
      }
    }

    // What a broker holds, said on its row: how many topics, and how far behind its groups are in all
    const heldBy = (label: string): TableCell[] => {
      const broker = factsOf(label).broker
      const lag = (broker?.groups ?? []).reduce((sum, group) => sum + group.lag, 0)

      if (broker === undefined || broker.kind === 'kafka') return ['', '']

      return [String(broker.topics.length), lag === 0 ? dim(figure(pastOf(label).lag, '0')) : { text: figure(pastOf(label).lag, String(lag)), tone: (broker.groups ?? []).some(group => stuckFor(group, drawnAt) > 0) ? 'danger' : 'warning' }]
    }

    // What a database holds, said on its row: its sessions of those it lets in, and how many tables
    const queriedBy = (label: string): TableCell[] => {
      const database = factsOf(label).database

      if (database === undefined || database.name === '') return ['', '']

      const isHeld = database.sessions.some(session => isBlocked(session) || isIdling(session))

      return [isHeld ? { text: `${database.sessions.length}/${database.max}`, tone: 'danger' } : `${database.sessions.length}/${database.max}`, String(database.tables.length)]
    }

    const TITLE_OF = { app: 'App', broker: 'Broker', database: 'Database' } as const

    const tableOf = ({ kind, many, members }: (typeof sections)[number]) => {
      // Where all of a kind run on the same thing, the title says it once and no column does
      const runtimes = [...new Set(members.map(({ runtime }) => RUNTIME_NAME[runtime]))]
      const isMixed = runtimes.length > 1

      return [
        <Box key={`section-${kind}`} flexDirection="row" gap={1}>
          {tonedText({ text: `${many[0]?.toUpperCase()}${many.slice(1)}`, bold: true })}
          {...(isMixed ? [] : [tonedText({ text: `on ${runtimes[0] ?? ''}`, tone: 'neutral' })])}
        </Box>,
        table({
          columns: [
            { header: TITLE_OF[kind], width: isNarrow ? 12 : 14 },
            ...(isMixed ? [{ header: 'Runs on', width: 10 }] : []),
            ...(kind === 'app' ? [] : [{ header: 'Engine', width: 11 }]),
            { header: 'State' },
            { header: 'CPU', width: hasSparks ? 13 : isNarrow ? 5 : 6 },
            { header: 'Memory', width: hasSparks ? 23 : isNarrow ? 8 : 16 },
            ...(kind === 'broker' ? [{ header: 'Topics', width: 6 }, { header: 'Lag', width: hasSparks ? 13 : 6 }] : []),
            ...(kind === 'database' ? [{ header: 'Sessions', width: 8 }, { header: 'Tables', width: 6 }] : []),
            { header: 'Errors', width: isNarrow ? 9 : 11 },
          ],
          rows: members.map((attachment): TableCell[] => {
            const { name, state, cpu, memory, errors } = rowOf(attachment)

            return [
              name,
              ...(isMixed ? [RUNTIME_NAME[attachment.runtime]] : []),
              ...(kind === 'app' ? [] : [factsOf(attachment.label).engine ?? '']),
              state,
              cpu,
              memory,
              ...(kind === 'broker' ? heldBy(attachment.label) : []),
              ...(kind === 'database' ? queriedBy(attachment.label) : []),
              errors,
            ]
          }),
        }),
      ]
    }

    const everything = timeline(list, held)
    const lines = everything.filter(({ label, line }) => (picked === '' || label === picked) && (!errorsOnly || line.level === 'error'))
    // As many lines as the pane has rows for, under the tables
    const room = Math.max(8, Math.min(40, (e.viewport?.rows ?? 36) - list.length - 14))
    const isTagged = list.length > 1 && picked === ''
    const tagWidth = Math.min(12, Math.max(0, ...list.map(({ label }) => label.length))) + 1
    const colorOf = (label: string): string => tagColor(list.findIndex(attachment => attachment.label === label))

    // A button's label says its key: a pane has no other place to
    const keyed = (hotkey: string, text: string): string => `${hotkey} ${text}`

    const tab = (name: Shown, text: string, hotkey: string) => (
      <Button
        key={`view-${name}`}
        hotkey={hotkey}
        onPress={async () => {
          await update($, shownView, () => name)
          // A compose service's and a local app's environment take a read of their own, made when it is looked at
          if (name === 'env') await pull($, undefined, { usage: false, env: true }).catch(() => undefined)
          if (name === 'database') await pull($, undefined, { usage: false, env: false, broker: true }).catch(() => undefined)
          if (name === 'broker') await pull($, undefined, { usage: false, env: false, broker: true }).catch(() => undefined)
          // The browser is asked at once, whenever it last failed to answer
          if (name === 'renders' || name === 'tests') await pull($, undefined, { usage: false, env: false, browser: asked.port }).catch(() => undefined)
        }}
      >
        {actionLabel({ text: keyed(hotkey, text), primary: showing === name })}
      </Button>
    )

    // How a view is read, said only when asked for
    const help = (text: string) => (helped ? [tonedText({ text, tone: 'neutral', wrap: true })] : [])
    // An empty view says in a sentence what is missing; the whole of how to fill it is its help
    const gist = (text: string): string => (helped ? text : `${text.split('. ')[0]?.replace(/\.$/, '') ?? text}.`)

    // A request is followed in the timeline, wherever its line was pressed
    const follow = async (rid: string) => {
      await update($, traced, () => rid)
      await update($, shownView, () => 'logs' as Shown)
    }

    // One line of the timeline: its time (or, of a request followed, how long after its first line), its level, its
    // app in the app's own color, what it says, and the request it names, which a press follows across the apps
    const lineRow = ({ label, line, times }: Row, key: string, { from = 0, isNamed = isTagged }: { from?: number; isNamed?: boolean } = {}) => {
      const [rid] = from > 0 ? [] : requestIds(line.message)

      return (
        <Box key={key} flexDirection="row">
          <Box key="head" width={17} flexShrink={0} flexDirection="row" gap={2}>
            <Text key="at" color="subtle">
              {from > 0 ? offsetText(line.at, from).padEnd(8).slice(0, 8) : clockTime(line.at)}
            </Text>
            <Text key="level" color={LEVEL_COLOR[line.level]}>
              {line.level.toUpperCase().padEnd(5)}
            </Text>
          </Box>
          <Box key="said" flexGrow={1} flexShrink={1}>
            <Text key="message">
              {...(isNamed ? [<Text key="tag" color={colorOf(label)}>{`[${label}] `}</Text>] : [])}
              {`${line.message}${line.more > 0 ? ` (+${line.more} lines)` : ''}`}
              {...(times > 1 ? [<Text key="times" color="subtle">{` ×${times}`}</Text>] : [])}
            </Text>
          </Box>
          {...(rid === undefined
            ? []
            : [
                <Box key="rid" flexShrink={0} marginLeft={1}>
                  <Button key={`${key}-follow`} label={`Follow request ${rid}`} plain onPress={() => follow(rid)}>
                    <Text key="chip" color="subtle">
                      ⇢
                    </Text>
                  </Button>
                </Box>,
              ])}
        </Box>
      )
    }

    const picks = list.filter(({ label }) => picked === '' || label === picked)

    const logsBody = () => {
      // A request followed is followed through every app, whichever is picked
      const following = follows === '' ? undefined : traceOf(everything, follows)
      const needle = grep.toLowerCase()
      const matching = (following ?? lines).filter(({ line }) => (paused === 0 || line.at <= paused) && (needle === '' || line.message.toLowerCase().includes(needle)))
      // Nothing is folded away of a request that is followed, of a search, or of the errors alone
      const { rows, hidden } = quieted(matching, noisy || following !== undefined || needle !== '' || errorsOnly)
      const from = following?.[0]?.line.at ?? 0
      const notes = [
        paused === 0 ? '' : `paused at ${clockTime(paused)}`,
        needle === '' ? '' : `${matching.length} line${matching.length === 1 ? '' : 's'} hold "${grep}"`,
        hidden === 0 ? '' : `${hidden} health check${hidden === 1 ? '' : 's'} left out`,
        rows.length > room ? `the last ${room} of ${rows.length}` : '',
      ].filter(note => note !== '')

      return [
        <Box key="logs-actions" flexDirection="row" flexWrap="wrap" columnGap={2}>
          <Button key="errors-only" hotkey="e" onPress={() => update($, isErrorsOnly, value => !value)}>
            {actionLabel({ text: keyed('e', 'Errors only'), primary: errorsOnly })}
          </Button>
          <Button key="pause" hotkey="p" onPress={async () => {
            const now = await $.clock.now()

            await update($, pausedAt, was => (was === 0 ? now : 0))
          }}>
            {actionLabel({ text: keyed('p', paused === 0 ? 'Pause' : 'Resume'), primary: paused !== 0 })}
          </Button>
          <Button key="noise" hotkey="h" onPress={() => update($, isNoisy, value => !value)}>
            {actionLabel({ text: keyed('h', noisy ? 'Fold repeats' : 'Every line') })}
          </Button>
          {...(following === undefined
            ? []
            : [
                <Button key="unfollow" hotkey="f" onPress={() => update($, traced, () => '')}>
                  {actionLabel({ text: keyed('f', 'Stop following'), primary: true })}
                </Button>,
              ])}
        </Box>,
        // What is typed here is the text a line must hold; sent empty, every line is shown again
        ...(Input === undefined
          ? []
          : [<Input key="logs-grep" label="Filter" placeholder="text a line must hold: a word, a path, a request id" value={grep} submitLabel="filter" onSubmit={(text: string) => update($, grepped, () => text.trim())} />]),
        ...(following === undefined ? [] : [tonedText({ text: traceSummary(follows, following), bold: true, wrap: true })]),
        ...(rows.length === 0
          ? [tonedText({ text: following !== undefined || needle !== '' || errorsOnly ? 'No line matches.' : 'No events yet.', tone: 'neutral' })]
          : rows.slice(-room).map((row, index) => lineRow(row, `line-${index}`, following === undefined ? {} : { from, isNamed: true }))),
        ...(notes.length === 0 ? [] : [tonedText({ text: notes.join(' · '), tone: 'neutral' })]),
        ...help('⇢ at the end of a line follows its request across every app, each line then said with how long after the first it was written. Health checks are left out, and a line written several times running is said once with ×n: h shows every line. p holds the timeline still while it is read.'),
      ]
    }

    // Every kind of error once, the new ones first: a row opens on the last time it was written, with what led to it
    const errorsBody = () => {
      const kinds = kindsOf(picks, held, baseline)
      const news = kinds.filter(({ isNew }) => isNew).length
      const isByApp = picks.length > 1
      const open = kinds.find(kind => kindId(kind) === openedError)
      const led = open === undefined ? [] : around(open, everything)
      const followed = open === undefined ? undefined : causesOf(picks, held, everything)[kindId(open)]
      const [rid] = led.flatMap(({ line }) => requestIds(line.message))

      return [
        <Box key="errors-actions" flexDirection="row" flexWrap="wrap" columnGap={2}>
          <Button key="errors-since" hotkey="b" onPress={() => update($, since, was => BASELINES[(BASELINES.indexOf(was) + 1) % BASELINES.length] ?? 'edit')}>
            {actionLabel({ text: keyed('b', `New since ${BASELINE_NAME[baseline]}`) })}
          </Button>
          <Button key="errors-guard" hotkey="g" onPress={() => update($, guarding, () => (guarded ? 'off' : 'on'))}>
            {actionLabel({ text: keyed('g', guarded ? 'Guarding edits' : 'Guard edits'), primary: guarded })}
          </Button>
        </Box>,
        badge({
          label: `${kinds.length} kind${kinds.length === 1 ? '' : 's'} of error · ${news} new ${picks.length === 1 && picks[0] !== undefined ? sinceText(watchOf(picks[0].label), baseline) : `since ${BASELINE_NAME[baseline]}`}`,
          tone: news > 0 ? 'danger' : kinds.length > 0 ? 'neutral' : 'success',
        }),
        table({
          columns: [...(isByApp ? [{ header: 'App', width: tagWidth }] : []), { header: 'Error' }, { header: '×', width: 6 }, { header: 'First', width: 8 }, { header: 'Last', width: 8 }],
          rows: kinds.slice(0, room).map((kind, index): TableCell[] => {
            const isOpen = kind === open
            const { sample, count, firstAt, lastAt } = kind.signature

            return [
              ...(isByApp ? [{ type: 'Text', props: { color: colorOf(kind.label), wrap: 'truncate-end' }, children: [kind.label] } as unknown as TableCell] : []),
              <Button key={`error-${index}`} plain onPress={() => update($, openError, () => (isOpen ? '' : kindId(kind)))}>
                {tonedText({ text: `${isOpen ? '▾' : '▸'} ${kind.isNew ? 'new · ' : ''}${sample}`, ...(kind.isNew ? { tone: 'danger' as const } : isOpen ? { tone: 'accent' as const } : {}), bold: isOpen })}
              </Button>,
              String(count),
              firstAt === undefined ? '' : clockTime(firstAt),
              clockTime(lastAt),
            ]
          }),
          empty: 'No error has been written.',
        }),
        ...(kinds.length > room ? [tonedText({ text: `and ${kinds.length - room} more: show one app`, tone: 'neutral' })] : []),
        ...(open === undefined
          ? []
          : [
              divider(),
              tonedText({ text: open.signature.sample, tone: 'danger', wrap: true }),
              tonedText({ text: led.length === 0 ? 'The lines kept no longer hold it.' : rid === undefined ? `The last time, with what ${open.label} wrote just before:` : 'The last time, with every line of its request:', tone: 'neutral' }),
              ...led.map((entry, index) => lineRow({ ...entry, times: 1 }, `led-${index}`, { isNamed: true })),
              ...(followed === undefined ? [] : [tonedText({ text: `It follows, in the same request, ${followed.label}'s: ${followed.sample}`, tone: 'warning', wrap: true })]),
              // Where it was raised: the end of its trace, which is where most languages say it
              ...(open.signature.trace ?? []).slice(-PANE_TRACE).map((frame, index) => (
                <Text key={`frame-${index}`} color="subtle" wrap="truncate-end">
                  {`  ${frame}`}
                </Text>
              )),
              <Box key="error-actions" flexDirection="row" flexWrap="wrap" columnGap={2}>
                <Button key="error-diagnose" hotkey="d" onPress={() => $.prompt.submit({ text: diagnosePrompt(open, watchOf(open.label), led) })}>
                  {actionLabel({ text: keyed('d', 'Diagnose with Claude'), primary: true })}
                </Button>
                {...(rid === undefined
                  ? []
                  : [
                      <Button key="error-follow" hotkey="f" onPress={() => follow(rid)}>
                        {actionLabel({ text: keyed('f', 'Follow its request') })}
                      </Button>,
                    ])}
              </Box>,
            ]),
        ...help('An error is one kind with another when they say the same but for their numbers and ids. New is counted since the last edit to the app, since the mark (m sets one now, on every app) or since the app last started over: b goes from one to the next. While Claude guards the edits, an error that is new since one is handed to it at once; otherwise it reads it beside its next tool result or the next prompt.'),
      ]
    }

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
        ...(variables.length > room ? [tonedText({ text: `and ${variables.length - room} more: show one app, or ask mcp__runtime__env`, tone: 'neutral' })] : []),
        ...notes.map(note => tonedText({ text: note, tone: 'neutral', wrap: true })),
      ]
    }

    // What each broker holds: its topics, and its consumer groups with how far behind each is
    const brokerBody = () => {
      const brokers = picks.flatMap(({ label }) => (factsOf(label).broker === undefined ? [] : [{ label, broker: factsOf(label).broker as Broker }]))
      const isByApp = brokers.length > 1
      const app = isByApp ? [{ header: 'Broker', width: 12 }] : []

      if (brokers.length === 0) return [tonedText({ text: picked === '' ? NO_BROKER : `${picked} is not a broker: show all, or the broker itself.`, tone: 'neutral', wrap: true })]

      return [
        // What is typed here is handed to Claude as a prompt, which answers it by reading the broker
        ...(Input === undefined
          ? []
          : [
              <Input
                key="broker-ask"
                label="Ask Claude"
                placeholder="a question about what the broker holds"
                submitLabel="ask"
                onSubmit={(question: string) => {
                  if (question.trim() !== '') void $.prompt.submit({ text: askBrokerPrompt(brokers, question) })
                }}
              />,
            ]),
        ...brokers.flatMap(({ label, broker: { kind, note, at } }) => [
          tonedText({ text: `${label}: ${KIND_NAME[kind]}, asked at ${clockTime(at)}`, bold: true }),
          ...(note === '' ? [] : [tonedText({ text: note, tone: 'warning', wrap: true })]),
        ]),
        table({
          columns: [...app, { header: 'Topic' }, { header: 'Partitions', width: 11 }, { header: 'Held', width: 9 }, { header: 'Written', width: 9 }],
          rows: brokers.flatMap(({ label, broker }) =>
            broker.topics.map(({ name, sizes, end }): TableCell[] => {
              const isOpen = peeked.label === label && peeked.topic === name

              return [
                ...(isByApp ? [label] : []),
                // Pressed, a topic opens on its last messages under the tables; pressed again, it closes
                <Button key={`topic-${label}-${name}`} plain onPress={() => (isOpen ? update($, peek, () => EMPTY_PEEK) : peekInto($, label, name))}>
                  {tonedText({ text: `${isOpen ? '▾' : '▸'} ${name}`, tone: isOpen ? 'accent' : 'neutral', bold: isOpen })}
                </Button>,
                String(sizes.length),
                String(sizes.reduce((sum, size) => sum + size, 0)),
                String(end),
              ]
            }),
          ),
          empty: 'No topic.',
        }),
        ...(peeked.topic === '' || !brokers.some(({ label }) => label === peeked.label)
          ? [tonedText({ text: 'A topic opens on its last messages.', tone: 'neutral' })]
          : [
              tonedText({
                text: `${peeked.topic}${isByApp ? ` on ${peeked.label}` : ''}: its last ${peeked.records.length} message${peeked.records.length === 1 ? '' : 's'}, oldest first, read at ${clockTime(peeked.at)} as no group, secrets taken out`,
                bold: true,
                wrap: true,
              }),
              ...(peeked.note === ''
                ? [
                    table({
                      columns: [{ header: 'Written', width: 8 }, { header: 'At', width: 8 }, { header: 'Key', width: 14 }, { header: 'Headers', width: 16 }, { header: 'Value', wrap: true }],
                      rows: peeked.records.slice(-room).map(({ at: written, partition, offset, key, headers, value }): TableCell[] => [clockTime(written), `${partition}@${offset}`, key, headers, value]),
                      empty: 'No message.',
                    }),
                  ]
                : [tonedText({ text: peeked.note, tone: 'warning', wrap: true })]),
            ]),
        table({
          columns: [...app, { header: 'Group' }, { header: 'Reads', width: 18 }, { header: 'State', width: 20 }, { header: 'Members', width: 8 }, { header: 'Lag', width: 7 }, { header: 'Standing', width: 34 }],
          rows: brokers.flatMap(({ label, broker }) =>
            broker.groups.map((group): TableCell[] => {
              const isStuck = stuckFor(group, drawnAt) > 0 || (group.members === 0 && group.lag > 0)

              return [
                ...(isByApp ? [label] : []),
                group.name,
                topicsOf(group).join(', '),
                group.state === 'Stable' ? group.state : { text: group.state, tone: 'warning' },
                group.members === 0 ? { text: '0', tone: 'warning' } : String(group.members),
                group.lag === 0 ? '0' : { text: String(group.lag), tone: isStuck ? 'danger' : 'warning' },
                { text: standing(group, broker, drawnAt), tone: isStuck ? 'danger' : 'neutral' },
              ]
            }),
          ),
          empty: 'No consumer group.',
        }),
        // A group that does not keep up is Claude's to look into, as a failed test is
        ...brokers
          .filter(({ broker }) => broker.groups.some(group => stuckFor(group, drawnAt) > 0 || (group.members === 0 && group.lag > 0)))
          .map(({ label, broker }) => (
            <Box key={`broker-diagnose-row-${label}`} flexDirection="row">
              <Button key={`broker-diagnose-${label}`} onPress={() => $.prompt.submit({ text: diagnoseGroupsPrompt(label, broker, drawnAt) })}>
                {actionLabel({ text: `Diagnose ${isByApp ? `${label}'s` : 'the'} stuck groups with Claude`, primary: true })}
              </Button>
            </Box>
          )),
        ...help('Lag is how many messages wait to be read. At is the partition and the offset. mcp__runtime__broker says the lag partition by partition, and searches the last messages of a topic. A question typed after Ask Claude is handed to Claude, which answers it by reading the broker through that tool.'),
      ]
    }

    // What each database holds: its sessions, those that wait first, and its tables
    const databaseBody = () => {
      const databases = picks.flatMap(({ label }) => (factsOf(label).database === undefined ? [] : [{ label, database: factsOf(label).database as Database }]))
      const isByApp = databases.length > 1
      const app = isByApp ? [{ header: 'Database', width: 12 }] : []

      if (databases.length === 0) return [tonedText({ text: picked === '' ? NO_DATABASE : `${picked} is not a database: show all, or the database itself.`, tone: 'neutral', wrap: true })]

      return [
        // What is typed here is handed to Claude as a prompt, which answers it by reading the database
        ...(Input === undefined
          ? []
          : [
              <Input
                key="database-ask"
                label="Ask Claude"
                placeholder="a question about what the database holds"
                submitLabel="ask"
                onSubmit={(question: string) => {
                  if (question.trim() !== '') void $.prompt.submit({ text: askPrompt(databases, question) })
                }}
              />,
            ]),
        ...databases.flatMap(({ label, database }) => [
          tonedText({ text: `${label}: PostgreSQL${database.name === '' ? '' : ` ${database.version}, database ${database.name}, ${sizeText(database.bytes)}`}, asked at ${clockTime(database.at)}`, bold: true }),
          ...(database.note === '' ? [] : [tonedText({ text: database.note, tone: 'warning', wrap: true })]),
          ...(database.name === '' ? [] : [tonedText({ text: `${database.sessions.length} of the ${database.max} sessions it lets in${database.sessions.length === 0 ? '' : `: ${byState(database)}; by app: ${byApp(database)}`}`, tone: 'neutral', wrap: true })]),
        ]),
        table({
          columns: [...app, { header: 'Pid', width: 8 }, { header: 'App', width: 12 }, { header: 'Standing', width: 44 }, { header: 'Statement', wrap: true }],
          rows: databases.flatMap(({ label, database }) =>
            troubled(database).map((session): TableCell[] => [
              ...(isByApp ? [label] : []),
              String(session.pid),
              session.app || session.user,
              { text: sessionStanding(session), tone: isBlocked(session) || isIdling(session) ? 'danger' : 'warning' },
              session.query,
            ]),
          ),
          empty: 'No session waits for a lock, sits idle in an open transaction or runs a long statement.',
        }),
        table({
          columns: [...app, { header: 'Table' }, { header: 'Rows', width: 9 }, { header: 'Size', width: 9 }, { header: 'Dead', width: 7 }, { header: 'Written', width: 9 }, { header: 'Scans', width: 8 }, { header: 'By index', width: 9 }],
          rows: databases.flatMap(({ label, database }) =>
            database.tables.map(({ name, rows, dead, bytes, scans, lookups, written }): TableCell[] => {
              const isOpen = rowed.label === label && rowed.table === name

              return [
                ...(isByApp ? [label] : []),
                // Pressed, a table opens on its last rows under the tables; pressed again, it closes
                <Button key={`table-${label}-${name}`} plain onPress={() => (isOpen ? update($, rowsShown, () => EMPTY_ROWS) : rowsInto($, label, name))}>
                  {tonedText({ text: `${isOpen ? '▾' : '▸'} ${name}`, tone: isOpen ? 'accent' : 'neutral', bold: isOpen })}
                </Button>,
                String(rows),
                sizeText(bytes),
                String(dead),
                String(written),
                String(scans),
                String(lookups),
              ]
            }),
          ),
          empty: 'No table.',
        }),
        ...(rowed.table === '' || !databases.some(({ label }) => label === rowed.label)
          ? [tonedText({ text: 'A table opens on its last rows.', tone: 'neutral' })]
          : [
              tonedText({ text: `${rowed.table}${isByApp ? ` on ${rowed.label}` : ''}: its last ${rowed.rows.length} row${rowed.rows.length === 1 ? '' : 's'}, oldest first, read at ${clockTime(rowed.at)}, secrets taken out`, bold: true, wrap: true }),
              ...(rowed.note === '' ? (rowed.rows.length === 0 ? [tonedText({ text: 'It holds no row.', tone: 'neutral' })] : rowed.rows.slice(-room).map(row => tonedText({ text: row, tone: 'neutral', wrap: true }))) : [tonedText({ text: rowed.note, tone: 'warning', wrap: true })]),
            ]),
        ...databases
          .filter(({ database }) => troubled(database).length > 0)
          .map(({ label, database }) => (
            <Box key={`database-diagnose-row-${label}`} flexDirection="row">
              <Button key={`database-diagnose-${label}`} onPress={() => $.prompt.submit({ text: diagnoseSessionsPrompt(label, database) })}>
                {actionLabel({ text: `Diagnose ${isByApp ? `${label}'s` : 'the'} held sessions with Claude`, primary: true })}
              </Button>
            </Box>
          )),
        ...help('Rows is what the database last counted, near the truth. Dead is the rows whose room is not taken back yet. Scans is how often a table was read whole. A question typed after Ask Claude is handed to Claude, which answers it by reading the database through mcp__runtime__database.'),
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

    // What an empty view of the page offers: Claude sets up the Chrome it is read from, where none answers
    const setUp = () =>
      asked.port === 0 || seen.pages.length > 0
        ? []
        : [
            <Box key="browser-setup-row" flexDirection="row">
              <Button key="browser-setup" hotkey="s" onPress={() => $.prompt.submit({ text: BROWSER_PROMPT(asked.port, list.map(({ label }) => label)) })}>
                {actionLabel({ text: keyed('s', 'Set up with Claude'), primary: true })}
              </Button>
            </Box>,
          ]

    // The page each frontend last reported, its elements nested as the document nests them
    const domBody = (rowWidth: number) => {
      const pages = picks.flatMap(({ label }) => {
        const { dom } = watchOf(label)

        return dom === undefined ? [] : [{ label, dom }]
      })

      if (pages.length === 0) return [tonedText({ text: gist(HOW_TO_REPORT_DOM), tone: 'neutral', wrap: true }), ...source(false), ...setUp()]

      return [
        ...source(true),
        ...help(HOW_TO_READ_DOM),
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

      if (acted.length === 0) return [tonedText({ text: gist(HOW_TO_REPORT_ACTIONS), tone: 'neutral', wrap: true }), ...source(false), ...setUp()]

      return [
        ...help('What was done on the page, the latest first: what rendered, what the page asked for, and what every app wrote in the two seconds after.'),
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

      if (asking.length === 0) return [tonedText({ text: gist(HOW_TO_REPORT_NETWORK), tone: 'neutral', wrap: true }), ...source(false), ...setUp()]

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
        ...(asks.length > room ? [tonedText({ text: `and ${asks.length - room} more: ask mcp__runtime__network`, tone: 'neutral' })] : []),
        ...source(true),
      ]
    }

    // The end-to-end checklist: each scenario on a row with how it stands, why under it, and its steps when opened
    const e2eBody = () => {
      const planned = scenariosHeld.length
      // Of the app that is picked, as the logs are
      const checklist = suitesOf(scenariosHeld, picked)
      const { label, tone } = tally(checklist)
      const isRunning = isUnderWay(checklist)
      const undone = checklist.filter(({ state }) => state === 'failed' || state === 'blocked').map(({ id }) => id)
      const isByApp = new Set(checklist.map(({ target }) => target)).size > 1
      // A scenario that could not be tried is no fault of the code: only what failed is Claude's to fix
      const failed = checklist.filter(({ state }) => state === 'failed')
      const toggle = (id: string) => update($, opened, ids => (ids.includes(id) ? ids.filter(known => known !== id) : [...ids, id]))

      return [
        <Box key="e2e-actions" flexDirection="row" flexWrap="wrap" columnGap={2}>
          <Button key="e2e-plan" hotkey="p" onPress={() => $.prompt.submit({ text: PLAN_PROMPT })}>
            {actionLabel({ text: keyed('p', planned === 0 ? 'Plan' : 'Plan again'), primary: planned === 0 })}
          </Button>
          {...(checklist.length === 0 || isRunning
            ? []
            : [
                <Button key="e2e-run" hotkey="g" onPress={() => runScenarios($, picked === '' ? [] : checklist.map(({ id }) => id), asked.port)}>
                  {actionLabel({ text: keyed('g', 'Run all'), primary: undone.length === 0 })}
                </Button>,
              ])}
          {...(undone.length === 0 || isRunning
            ? []
            : [
                <Button key="e2e-rerun" hotkey="f" onPress={() => runScenarios($, undone, asked.port)}>
                  {actionLabel({ text: keyed('f', `Run the ${undone.length} not passed`), primary: true })}
                </Button>,
              ])}
          {...(failed.length < 2 || isRunning
            ? []
            : [
                <Button key="e2e-fix" hotkey="x" onPress={() => $.prompt.submit({ text: fixPrompt(failed) })}>
                  {actionLabel({ text: keyed('x', `Fix all ${failed.length} with Claude`) })}
                </Button>,
              ])}
          {...(isRunning
            ? [
                <Button key="e2e-stop" hotkey="s" onPress={() => inTurn(() => update($, scenarios, stopped))}>
                  {actionLabel({ text: keyed('s', 'Stop'), primary: true })}
                </Button>,
              ]
            : [])}
        </Box>,
        ...(checklist.length === 0
          ? [tonedText({ text: planned === 0 ? HOW_TO_PLAN : `No scenario is done on ${picked}: the checklist has ${planned} for the other apps.`, tone: 'neutral', wrap: true })]
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
              ...help('A row opens on its steps and on what the subagent that ran it reported. What is planned is kept for the next session in this project.'),
            ]),
        // Said only when it stands in the way: a run needs the browser
        ...(asked.port === 0 || seen.at === 0 || seen.pages.length > 0 ? [] : describeBrowser(seen, list.map(({ label: app }) => app)).map(line => tonedText({ text: line, tone: 'warning', wrap: true }))),
      ]
    }

    // The unit test suites: each a command on a row with how it last exited and the tests it ran under it, run one
    // by one or all at once
    const unitBody = () => {
      // Of the app that is picked, as the logs are
      const named = suitesOf(suitesHeld, picked)
      const { label, tone } = tally(named)
      const isRunning = isUnderWay(named)
      const undone = named.filter(({ state }) => state === 'failed' || state === 'blocked').map(({ id }) => id)
      const failed = named.filter(({ state }) => state === 'failed')
      const toggle = (id: string) => update($, opened, ids => (ids.includes(id) ? ids.filter(known => known !== id) : [...ids, id]))

      return [
        <Box key="unit-actions" flexDirection="row" flexWrap="wrap" columnGap={2}>
          <Button key="unit-plan" hotkey="p" onPress={() => $.prompt.submit({ text: PLAN_UNIT_PROMPT })}>
            {actionLabel({ text: keyed('p', suitesHeld.length === 0 ? 'Plan' : 'Plan again'), primary: suitesHeld.length === 0 })}
          </Button>
          {...(named.length === 0
            ? []
            : [
                <Button key="unit-run" hotkey="g" onPress={() => runSuites($, picked === '' ? [] : named.map(({ id }) => id))}>
                  {actionLabel({ text: keyed('g', picked === '' ? 'Run all' : `Run all of ${picked}`), primary: undone.length === 0 && !isRunning })}
                </Button>,
              ])}
          {...(undone.length === 0 || isRunning
            ? []
            : [
                <Button key="unit-rerun" hotkey="f" onPress={() => runSuites($, undone)}>
                  {actionLabel({ text: keyed('f', `Run the ${undone.length} not passed`), primary: true })}
                </Button>,
              ])}
          {...(failed.length < 2 || isRunning
            ? []
            : [
                <Button key="unit-fix" hotkey="x" onPress={() => $.prompt.submit({ text: fixUnitPrompt(failed) })}>
                  {actionLabel({ text: keyed('x', `Fix all ${failed.length} with Claude`) })}
                </Button>,
              ])}
        </Box>,
        ...(named.length === 0
          ? [tonedText({ text: suitesHeld.length === 0 ? HOW_TO_PLAN_UNIT : `No suite tests ${picked}: the list has ${suitesHeld.length} for the other apps.`, tone: 'neutral', wrap: true })]
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
              ...help('Under a suite, the tests it ran, read off what it printed. A row opens on its command and on the end of that.'),
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
        <Box key="tests-as" flexDirection="row" flexWrap="wrap" columnGap={2}>
          {as('e2e', keyed('e', 'E2E'), 'e', suitesOf(scenariosHeld, picked))}
          {as('unit', keyed('u', 'Unit tests'), 'u', suitesOf(suitesHeld, picked))}
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
        <Box key="renders-as" flexDirection="row" flexWrap="wrap" columnGap={2}>
          {as('tree', keyed('t', 'Renders'), 't')}
          {as('dom', keyed('d', 'DOM'), 'd')}
          {as('actions', keyed('a', 'Actions'), 'a')}
          {as('network', keyed('n', 'Network'), 'n')}
        </Box>
      )

      if (drawAs === 'dom') return [switcher, ...domBody(rowWidth)]
      if (drawAs === 'actions') return [switcher, ...actionsBody(rowWidth)]
      if (drawAs === 'network') return [switcher, ...networkBody()]
      if (reporting.length === 0) return [switcher, tonedText({ text: gist(HOW_TO_REPORT_RENDERS), tone: 'neutral', wrap: true }), ...source(false), ...setUp()]

      return [
        switcher,
        ...source(true),
        ...help(HOW_TO_READ_RENDERS),
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
          // Where to look, by number
          <Box key="views" flexDirection="row" flexWrap="wrap" columnGap={2}>
            {tab('logs', 'Logs', '1')}
            {tab('errors', news > 0 ? `Errors · ${news} new` : 'Errors', '2')}
            {tab('renders', 'Page', '3')}
            {tab('tests', 'Tests', '4')}
            {tab('env', 'Env', '5')}
            {...(list.some(({ label }) => factsOf(label).broker !== undefined) ? [tab('broker', 'Broker', '6')] : [])}
            {...(list.some(({ label }) => factsOf(label).database !== undefined) ? [tab('database', 'Database', '7')] : [])}
          </Box>,
          // What is done to all of it, by letter
          <Box key="actions" flexDirection="row" flexWrap="wrap" columnGap={2}>
            <Button key="refresh" hotkey="r" onPress={() => refresh($, asked)}>
              {actionLabel({ text: keyed('r', 'Refresh') })}
            </Button>
            <Button
              key="mark"
              hotkey="m"
              onPress={async () => {
                const now = await $.clock.now()

                await inTurn(() => update($, watches, was => markedNow(was, list.map(({ label }) => label), now)))
                await update($, since, () => 'mark' as Baseline)
                $.ui.toast(`runtime: mark set at ${clockTime(now)}`)
              }}
            >
              {actionLabel({ text: keyed('m', 'Mark now') })}
            </Button>
            <Button key="help" hotkey="i" onPress={() => update($, isHelped, value => !value)}>
              {actionLabel({ text: keyed('i', 'Help'), primary: helped })}
            </Button>
            {...(picked === ''
              ? []
              : [
                  <Button key="show-all" hotkey="0" onPress={() => update($, only, () => '')}>
                    {actionLabel({ text: keyed('0', `All, not ${picked} alone`), primary: true })}
                  </Button>,
                ])}
          </Box>,
          ...(list.length === 0
            ? showing === 'tests'
              ? [divider(), ...testsBody()]
              : [
                  tonedText({ text: HOW_TO_ATTACH, tone: 'neutral', wrap: true }),
                  <Box key="attach-row" flexDirection="row">
                    <Button key="attach" hotkey="a" onPress={() => $.prompt.submit({ text: ATTACH_PROMPT })}>
                      {actionLabel({ text: keyed('a', 'Attach with Claude'), primary: true })}
                    </Button>
                  </Box>,
                ]
            : [
                ...sections.flatMap(tableOf),
                ...help('A row, pressed, shows that one alone in every view; pressed again, or 0, all. A dim row needs no look. The bars beside a figure are its last reads, the lowest at the foot.'),
                divider(),
                ...(showing === 'env' ? envBody() : showing === 'errors' ? errorsBody() : showing === 'renders' ? rendersBody() : showing === 'tests' ? testsBody() : showing === 'broker' ? brokerBody() : showing === 'database' ? databaseBody() : logsBody()),
              ]),
        ],
      }),
      width,
    )
  })
}
