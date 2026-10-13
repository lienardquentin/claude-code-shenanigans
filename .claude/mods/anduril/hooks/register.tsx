import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AndurilRun, AndurilTarget } from '../types'
import { badge } from './kit/badge'
import { paneView } from './kit/pane-text'
import { table } from './kit/table'
import type { TableCell } from './kit/table'
import {
  HOME,
  HOW_TO_WATCH,
  PROJECT_FILE,
  binDir,
  clock,
  commandLine,
  drawable,
  duration,
  ending,
  excerpt,
  launcher,
  names,
  parseRun,
  parseTargets,
  prelude,
  remarks,
  runText,
  runsText,
  size,
  tidy,
  trimmed,
} from './record'

type $ = EngineInterface

const PANE = 'anduril'
const TITLE = 'Anduril'
// How many runs the session holds, and how much of each stream: the files under .anduril/runs hold the rest
const KEPT_RUNS = 200
const KEPT_CHARS = 8_000
// How many lines of a stream the pane draws of the run it shows in full: half from its start, half from its end
const DRAWN_LINES = 40

const targets = atom({ plugin: 'anduril', key: 'targets' } as const, [] as AndurilTarget[])
const runs = atom({ plugin: 'anduril', key: 'runs' } as const, [] as AndurilRun[])
const selected = atom({ plugin: 'anduril', key: 'selected' } as const, '')
const isFailedOnly = atom({ plugin: 'anduril', key: 'isFailedOnly' } as const, false)
const note = atom({ plugin: 'anduril', key: 'note' } as const, '')
const home = atom({ plugin: 'anduril', key: 'home' } as const, '')

/**
 * The folder the session started in: where the project's file is looked for and the records are kept. The session's
 * own folder is not asked each time, as it follows the shell: a `cd` Claude runs would move the project from under
 * what is watched.
 */
const homeOf = async ($: $): Promise<string> => {
  const held = await read($, home)

  if (held !== '') return held

  const cwd = tidy(await $.session.cwd())

  await update($, home, () => cwd)

  return cwd
}

// What the pane last drew, for the model to read
const view = paneView({ id: PANE, title: TITLE, command: '/anduril' })

const TOOLS = [
  {
    name: 'runs',
    description:
      "The recorded runs of the command-line tool being written, oldest first: when, who ran it (Claude or the person in a terminal of their own), how it exited, how long it took, and the command line. Reads afresh. Call it to see what was run and what failed, instead of asking the person what they ran or what it printed; `run` then says one in full.",
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Only the runs of this tool, by the name it is run by; every watched tool when left out.' },
        failed: { type: 'boolean', description: 'True for only the runs that did not exit with 0.' },
        grep: { type: 'string', description: 'Only the runs whose command line holds this text.' },
        limit: { type: 'number', description: 'How many of the last matching runs; 20 when left out, 200 at most.' },
      },
    },
  },
  {
    name: 'run',
    description:
      'One recorded run in full: its command line and working directory, its exit code or the signal that ended it, its duration, processor time and peak memory, whether each stream was a terminal, and what it wrote to stdout and to stderr, kept apart. Reads afresh. Without an id, the last run.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The id of the run, as `runs` lists it; the last run when left out.' },
        max: { type: 'number', description: 'How many characters of each stream; 4000 when left out, 60000 at most.' },
      },
    },
  },
] as const

// The tools watched, as the system prompt's section reads them: a module's own copy, set again at each load
let watched: readonly AndurilTarget[] = []

const sectionText = (list: readonly AndurilTarget[]): string => {
  const labels = list.map(({ label }) => `\`${label}\``).join(', ')

  return [
    `The anduril mod records every run of ${labels} made by that name: its arguments, exit code, duration and what it wrote to stdout and stderr.`,
    `In a shell command, run ${list.length === 1 ? 'it' : 'each'} by its name (\`${list[0]?.label ?? 'tool'} --help\`), which is on the PATH there, and not by the path of its binary or through the build tool: a run made any other way is not recorded.`,
    `The name runs the binary as it was last built (${list.map(({ label, binary }) => `${label}: ${binary}`).join('; ')}), so build before running.`,
    'mcp__anduril__runs lists the recorded runs, the person\'s own among them, and mcp__anduril__run says one in full.',
  ].join(' ')
}

/**
 * Reads what the project watches and puts a launcher in place for each: a file named as the tool, which hands a
 * run to the shim. A launcher that already says the same is left alone.
 */
const setUp = async ($: $): Promise<AndurilTarget[]> => {
  const cwd = await homeOf($)
  const list = parseTargets(await $.fs.read(`${cwd}/${PROJECT_FILE}`).catch(() => ''), cwd)
  const problems: string[] = []

  watched = list
  await update($, targets, () => list)

  if (list.length === 0) {
    await update($, note, () => '')

    return list
  }

  const shim = `${tidy($.plugin.root)}/shim/anduril_shim.py`
  // Nothing under the folder is the repo's: it says so itself, and the project's own ignore file is left alone
  const ignore = `${cwd}/${HOME}/.gitignore`
  if (!(await $.fs.exists(ignore).catch(() => false))) await $.fs.write(ignore, '*\n').catch(() => undefined)

  for (const target of list) {
    const path = `${binDir(cwd)}/${target.label}`
    const wanted = launcher({ shim, cwd, target })

    if ((await $.fs.read(path).catch(() => undefined)) !== wanted) {
      const made = await $.fs
        .write(path, wanted)
        .then(() => $.process.run(['chmod', '+x', path]))
        .then(({ exitCode }) => exitCode === 0)
        .catch(() => false)

      if (!made) problems.push(`The launcher of ${target.label} could not be written to ${path}.`)
    }

    if (!(await $.fs.exists(target.binary).catch(() => false))) problems.push(`${target.label} is not built: ${target.binary} is not there.`)
  }

  await update($, note, () => problems.join(' '))

  return list
}

// The files that held no record when read, by name: a file half written reads on the next look, and is asked once more
const unread = new Map<string, number>()
let pulling: Promise<void> | undefined

/** Reads the records written since the last look into the session, oldest first. */
const pull = ($: $): Promise<void> => {
  pulling ??= (async () => {
    const folder = `${await homeOf($)}/${HOME}/runs`
    const entries = await $.fs.list(folder).catch(() => [])
    const held = new Set((await read($, runs)).map(({ id }) => id))
    const fresh = entries
      .filter(({ name, kind }) => kind === 'file' && name.endsWith('.json') && !held.has(name.slice(0, -5)) && (unread.get(name) ?? 0) < 2)
      .map(({ name }) => name)
      .sort()
      .slice(-KEPT_RUNS)
    const found: AndurilRun[] = []

    for (const name of fresh) {
      const run = parseRun(await $.fs.read(`${folder}/${name}`).catch(() => ''))

      if (run === undefined) unread.set(name, (unread.get(name) ?? 0) + 1)
      else found.push(trimmed(run, KEPT_CHARS))
    }

    if (found.length > 0) {
      await update($, runs, list => [...list.filter(({ id }) => !found.some(run => run.id === id)), ...found].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(-KEPT_RUNS))
    }
  })().finally(() => {
    pulling = undefined
  })

  return pulling
}

const integer = (value: unknown, otherwise: number, most: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.min(most, Math.floor(value)) : otherwise

export const register: Register = (on, options) => {
  const seconds = typeof options?.pollSeconds === 'number' && Number.isFinite(options.pollSeconds) ? Math.max(0, options.pollSeconds) : 3

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'anduril', description: 'Open the pane of the runs of the command-line tool being written: each run with its arguments, how it exited, how long it took and what it wrote' })

    // A host that registers no tools still starts the session
    for (const tool of [view.tool, ...TOOLS]) await $.tool.register(tool).catch(() => undefined)

    const list = await setUp($).catch(() => [])

    if (list.length > 0) {
      await pull($).catch(() => undefined)
      // A run made in another terminal shows without being asked for
      if (seconds > 0) $.clock.every(Math.max(1, seconds) * 1000, () => void pull($).catch(() => undefined))
    }

    return next(e)
  })

  // Claude is told the tool is run by its name, which is the one way a run of its own is recorded
  on('prompt.compose', async (_$, e, next) => {
    const composed = await next(e)

    return watched.length === 0 ? composed : { sections: [...composed.sections, { id: 'anduril:watch', text: sectionText(watched), scope: 'session' as const }] }
  })

  // A command of Claude's that names a watched tool finds its launcher first on the PATH
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!names(e.command, watched)) return next(e)

    const ran = await next({ ...e, command: `${prelude(await homeOf($))}${e.command}` })
    await pull($).catch(() => undefined)

    return ran
  }).catch((_$, e, next) => next(e))

  on('tool.call', { tool: 'mcp__anduril__pane' }, $ => view.answer(() => $.ui.panes()))

  on('tool.call', { tool: 'mcp__anduril__runs' }, async ($, e) => {
    const asked = e as unknown as { target?: unknown; failed?: unknown; grep?: unknown; limit?: unknown }

    if ((await read($, targets)).length === 0) return { result: HOW_TO_WATCH }

    await pull($).catch(() => undefined)

    const all = await read($, runs)
    const grep = typeof asked.grep === 'string' ? asked.grep : ''
    const matching = all.filter(
      run => (typeof asked.target !== 'string' || run.label === asked.target) && (asked.failed !== true || run.exitCode !== 0) && (grep === '' || commandLine(run).includes(grep)),
    )

    return { result: all.length === 0 ? 'No run is recorded yet.' : runsText(matching.slice(-integer(asked.limit, 20, KEPT_RUNS)), all.length) }
  })

  on('tool.call', { tool: 'mcp__anduril__run' }, async ($, e) => {
    const asked = e as unknown as { id?: unknown; max?: unknown }

    if ((await read($, targets)).length === 0) return { result: HOW_TO_WATCH }

    await pull($).catch(() => undefined)

    const all = await read($, runs)
    const held = typeof asked.id === 'string' && asked.id !== '' ? all.find(({ id }) => id === asked.id) : all.at(-1)

    if (held === undefined) return { result: all.length === 0 ? 'No run is recorded yet.' : `No run ${String(asked.id)} is recorded. \`runs\` lists them.` }

    // The session holds the head of each stream: the record's file has what the shim kept
    const whole = parseRun(await $.fs.read(`${await homeOf($)}/${HOME}/runs/${held.id}.json`).catch(() => '')) ?? held

    return { result: runText(whole, integer(asked.max, 4000, 60_000)) }
  })

  on('command.run', { command: 'anduril' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })

    const list = await setUp($)

    if (list.length === 0) return { text: HOW_TO_WATCH }

    await pull($)

    const held = await read($, runs)
    const problems = await read($, note)

    return { text: `anduril watches ${list.map(({ label }) => label).join(', ')}: ${held.length} ${held.length === 1 ? 'run' : 'runs'} recorded.${problems !== '' ? ` ${problems}` : ''}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Code, Text } = $.ui.resolve(e)
    const list = await read($, targets)
    const all = await read($, runs)
    const openId = await read($, selected)
    const failedOnly = await read($, isFailedOnly)
    const problems = await read($, note)
    const room = Math.max(5, (e.viewport?.rows ?? 30) - 12)

    // Reads the project's file again too: the way to have a tool watched once it is named there
    const refresh = (
      <Button
        key="refresh"
        hotkey="r"
        onPress={async () => {
          await setUp($).catch(() => undefined)
          await pull($).catch(() => undefined)
        }}
      >
        Refresh
      </Button>
    )

    if (list.length === 0) {
      return view.keep(
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="row" gap={2}>
            {badge({ label: 'no tool watched', tone: 'neutral' })}
            {refresh}
          </Box>
          <Text>{HOW_TO_WATCH}</Text>
        </Box>,
      )
    }

    const failed = all.filter(run => run.exitCode !== 0)
    const shown = (failedOnly ? failed : all).slice(-room).reverse()
    const open = all.find(({ id }) => id === openId)

    const rows = shown.map((run): TableCell[] => [
      clock(run.startedAt),
      run.by === 'claude' ? 'claude' : 'you',
      { text: ending(run), tone: run.exitCode === 0 ? 'success' : 'danger' },
      duration(run.durationMs),
      <Button key={`run-${run.id}`} plain onPress={() => update($, selected, was => (was === run.id ? '' : run.id))}>
        {run.id === openId ? '▸ ' : ''}
        {commandLine(run)}
      </Button>,
    ])

    const stream = (name: string, kept: string, bytes: number, isTty: boolean) => {
      if (bytes === 0) return <Text dimColor>{name}: nothing</Text>

      const lines = drawable(kept).trimEnd().split('\n')

      return (
        <Box flexDirection="column">
          <Text bold>
            {name} <Text dimColor>{`${size(bytes)}${isTty ? ', to a terminal' : ''}${lines.length > DRAWN_LINES ? `, the first and last ${DRAWN_LINES / 2} of ${lines.length} lines` : ''}`}</Text>
          </Text>
          <Code source={excerpt(lines, DRAWN_LINES).join('\n')} />
        </Box>
      )
    }

    return view.keep(
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={2}>
          {badge({ label: `${all.length} ${all.length === 1 ? 'run' : 'runs'} · ${failed.length} failed`, tone: failed.length > 0 ? 'warning' : 'success' })}
          {refresh}
          <Button key="failed-only" hotkey="f" variant={failedOnly ? 'primary' : 'secondary'} onPress={() => update($, isFailedOnly, value => !value)}>
            Failed only
          </Button>
        </Box>
        <Box flexDirection="column">
          {list.map(({ label, binary }) => (
            <Text dimColor>
              {label} runs {binary}
            </Text>
          ))}
          {problems !== '' && <Text color="warning">{problems}</Text>}
        </Box>
        {table({
          columns: [{ header: 'AT', width: 8 }, { header: 'BY', width: 6 }, { header: 'EXIT', width: 11 }, { header: 'TOOK', width: 8 }, { header: 'COMMAND' }],
          rows,
          empty: failedOnly && all.length > 0 ? 'No run failed.' : `No run yet. Run ${list[0]?.label ?? 'the tool'} by its name, here or with ${HOME}/bin first on the PATH of a terminal of your own.`,
        })}
        {open !== undefined && (
          <Box flexDirection="column" gap={1} borderStyle="round" paddingX={1}>
            <Box flexDirection="column">
              <Text bold>{commandLine(open)}</Text>
              <Text dimColor>
                {`exit ${ending(open)} · ${duration(open.durationMs)} · cpu ${duration(open.userMs + open.sysMs)} · ${size(open.maxRssKb * 1024)} · in ${open.cwd}`}
              </Text>
              <Text dimColor>
                {`stdout ${open.isStdoutTty ? 'a terminal' : 'piped'}, stderr ${open.isStderrTty ? 'a terminal' : 'piped'}${open.columns > 0 ? `, ${open.columns} columns` : ''}${Object.keys(open.env).length > 0 ? ` · ${Object.entries(open.env).map(([name, value]) => `${name}=${value}`).join(' ')}` : ''}`}
              </Text>
              {remarks(open).map(remark => (
                <Text color="warning">{remark}</Text>
              ))}
            </Box>
            {stream('stdout', open.stdout, open.stdoutBytes, open.isStdoutTty)}
            {stream('stderr', open.stderr, open.stderrBytes, open.isStderrTty)}
          </Box>
        )}
      </Box>,
    )
  })
}
