import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { RunsDiff, RecordedRun, WatchedTool } from '../types'
import { badge } from './kit/badge'
import { paneView } from './kit/pane-text'
import { treeOf, withTree } from './kit/trees'
import type { Trees } from './kit/trees'
import { table } from './kit/table'
import type { TableCell } from './kit/table'
import {
  HOME,
  HOW_TO_WATCH,
  OLD_PROJECT_FILE,
  PROJECT_FILE,
  binDir,
  clock,
  commandLine,
  corpusOf,
  diffProblems,
  diffSummary,
  diffText,
  drawable,
  duration,
  ending,
  excerpt,
  exitChange,
  fileNotes,
  launcher,
  names,
  parseDiff,
  parseProject,
  parseRun,
  prelude,
  projectInTree,
  remarks,
  runText,
  runsText,
  sideName,
  size,
  tidy,
  trimmed,
  withKept,
  writtenOutside,
} from './record'

type $ = EngineInterface

const PANE = 'recorder'
const TITLE = 'Recorder'
// How many runs the session holds, and how much of each stream: the files under .recorder/runs hold the rest
const KEPT_RUNS = 200
const KEPT_CHARS = 8_000
// How many lines of a stream the pane draws of the run it shows in full: half from its start, half from its end
const DRAWN_LINES = 40
// A comparison builds what it compares: as long as a host command may run
const DIFF_TIMEOUT_MS = 600_000
// From how wide a pane the runs say who ran them and how long they took; narrower, the command keeps that room
const WIDE_COLUMNS = 90

// A button's label with the key that presses it: a Button that is not plain draws no hotkey
const keyed = (hotkey: string, text: string): string => `${hotkey} ${text}`

const targets = atom({ plugin: 'recorder', key: 'targets' } as const, [] as WatchedTool[])
const runs = atom({ plugin: 'recorder', key: 'runs' } as const, [] as RecordedRun[])
const selected = atom({ plugin: 'recorder', key: 'selected' } as const, '')
const isFailedOnly = atom({ plugin: 'recorder', key: 'isFailedOnly' } as const, false)
const note = atom({ plugin: 'recorder', key: 'note' } as const, '')
const home = atom({ plugin: 'recorder', key: 'home' } as const, '')
const corpus = atom({ plugin: 'recorder', key: 'corpus' } as const, [] as string[])
const diff = atom({ plugin: 'recorder', key: 'diff' } as const, null as RunsDiff | null)
const diffing = atom({ plugin: 'recorder', key: 'diffing' } as const, '')
const against = atom({ plugin: 'recorder', key: 'against' } as const, 'HEAD')
const trees = atom({ plugin: 'recorder', key: 'trees' } as const, {} as Trees)

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
const view = paneView({ id: PANE, title: TITLE, command: '/recorder' })

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
  {
    name: 'diff',
    description:
      "What changed in the behaviour of the command-line tool being written between two builds. Plays the runs the project keeps (the `$` lines of .claude/recorder) on each build, in a copy of the tool's source folder, and says which ended otherwise or wrote something else, with a diff of each stream. Left to itself it compares the working tree, built afresh, with HEAD: what the uncommitted edits changed. Call it after changing the tool's source and before saying the change is done; a run that changed and was not meant to is a regression. `from` and `to` name any commits (a tag, a branch); a commit is built once, which can take minutes the first time. To have a run kept, add a `$ ` line with it to .claude/recorder.",
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'The tool, by the name it is run by; the first watched tool when left out.' },
        from: { type: 'string', description: 'The build compared against: a commit by any name git resolves (HEAD, a tag, a branch), or `work` for the working tree. HEAD when left out.' },
        to: { type: 'string', description: 'The build whose changes are said: a commit, or `work` for the working tree. `work` when left out.' },
        tree: { type: 'string', description: "From a mod: the quest's worktree whose working tree is played, in place of the project's." },
        mergeBase: { type: 'boolean', description: 'True to compare `to` with the commit where it left `from`, in place of where `from` now stands: what a branch alone changed since it left main.' },
      },
    },
  },
] as const

// The tools watched, as the system prompt's section reads them: a module's own copy, set again at each load
let watched: readonly WatchedTool[] = []

const sectionText = (list: readonly WatchedTool[]): string => {
  const labels = list.map(({ label }) => `\`${label}\``).join(', ')

  return [
    `The recorder records every run of ${labels} made by that name: its arguments, exit code, duration and what it wrote to stdout and stderr.`,
    `In a shell command, run ${list.length === 1 ? 'it' : 'each'} by its name (\`${list[0]?.label ?? 'tool'} --help\`), which is on the PATH there, and not by the path of its binary or through the build tool: a run made any other way is not recorded.`,
    `The name runs the binary as it was last built (${list.map(({ label, binary }) => `${label}: ${binary}`).join('; ')}), so build before running.`,
    'mcp__recorder__runs lists the recorded runs, the person\'s own among them, and mcp__recorder__run says one in full.',
    'After changing its source, mcp__recorder__diff plays the runs the project keeps on the working tree and on HEAD and says what changed in what the tool does.',
  ].join(' ')
}

/**
 * Puts a launcher in place in a folder for each tool it watches: a file named as the tool, which hands a run to the
 * shim. A launcher that already says the same is left alone. Answers what stood in the way.
 */
const launch = async ($: $, cwd: string, list: readonly WatchedTool[]): Promise<string[]> => {
  const problems: string[] = []
  const shim = `${tidy($.plugin.root)}/shim/recorder_shim.py`
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

  return problems
}

/** A folder's project file: under its name, else under the name it had before, where the project has not renamed it. */
const projectFileIn = async ($: $, cwd: string): Promise<string> =>
  (await $.fs.exists(`${cwd}/${PROJECT_FILE}`).catch(() => false)) || !(await $.fs.exists(`${cwd}/${OLD_PROJECT_FILE}`).catch(() => false)) ? `${cwd}/${PROJECT_FILE}` : `${cwd}/${OLD_PROJECT_FILE}`

/** What a folder's project file says, as `projectFileIn` finds it. */
const projectTextIn = async ($: $, cwd: string): Promise<string> => $.fs.read(await projectFileIn($, cwd)).catch(() => '')

/** What a folder's own project file watches and keeps, its paths in that folder. */
const projectIn = async ($: $, cwd: string): Promise<ReturnType<typeof parseProject>> => parseProject(await projectTextIn($, cwd), cwd)

/**
 * What a quest's worktree is launched and played by: the tools and their builds as the project's folder says them,
 * moved into the worktree, and the runs its own file keeps. A build is run unasked: it is never read from a branch.
 */
const projectOfTree = async ($: $, tree: string): Promise<ReturnType<typeof parseProject>> => {
  const home = await homeOf($)

  return projectInTree({ text: await projectTextIn($, home), cwd: home }, { text: await projectTextIn($, tree), cwd: tree })
}

/** Reads what the project watches, and puts a launcher in place for each. */
const setUp = async ($: $): Promise<WatchedTool[]> => {
  const cwd = await homeOf($)
  const project = await projectIn($, cwd)
  const list = project.targets
  const problems = list.length === 0 ? [] : await launch($, cwd, list)

  watched = list
  await update($, targets, () => list)
  await update($, corpus, () => project.corpus)
  await update($, note, () => problems.join(' '))

  return list
}

/** The folder a call works in: a quest's worktree the agent was sent to or a mod names, else the project's. */
const workIn = async ($: $, agentId: string | undefined, named?: unknown): Promise<string> => treeOf(await homeOf($), await read($, trees), agentId, named)

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
    const found: RecordedRun[] = []

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

/**
 * Plays the kept runs of a tool on two builds and keeps what differs. Answers the comparison, or a sentence saying
 * why none was made.
 */
const compare = async ($: $, asked: { target?: string; from: string; to: string; mergeBase: boolean; tree: string }): Promise<RunsDiff | string> => {
  // The project's file is read again: a run kept a moment ago is played. A quest's worktree plays the runs its own file
  // keeps, built as the project's folder says, and what it finds is not the pane's
  const isHome = asked.tree === (await homeOf($))
  const project = isHome ? undefined : await projectOfTree($, asked.tree)
  const list = project === undefined ? await setUp($) : project.targets
  const target = asked.target === undefined ? list[0] : list.find(({ label }) => label === asked.target)

  if (list.length === 0) return HOW_TO_WATCH
  if (target === undefined) return `The recorder watches no tool named ${asked.target ?? ''}. It watches ${list.map(({ label }) => label).join(', ')}.`

  const kept = corpusOf(project === undefined ? await read($, corpus) : project.corpus, target.label)

  if (kept.length === 0) return `No run of ${target.label} is kept to play. Keep one with a line in ${PROJECT_FILE}, as it is typed after a dollar sign: $ ${target.label} --help`

  const job = { home: asked.tree, label: target.label, binary: target.binary, root: target.roots[0] ?? '', build: target.build, masks: target.masks, corpus: kept, from: asked.from, to: asked.to, mergeBase: asked.mergeBase }

  if (isHome) await update($, diffing, () => target.label)

  try {
    const ran = await $.process.run(['python3', `${tidy($.plugin.root)}/shim/recorder_replay.py`], { stdin: JSON.stringify(job), timeoutMs: DIFF_TIMEOUT_MS })
    const made = parseDiff(ran.stdout, await $.clock.now())

    if (made === undefined) return `The comparison could not be made: ${ran.stderr.trim().split('\n').slice(-3).join(' ') || `the replay script exited with ${ran.exitCode} and said nothing`}`

    if (isHome) await update($, diff, () => made)

    return made
  } catch (error) {
    return `The comparison was not finished: ${error instanceof Error ? error.message : String(error)}`
  } finally {
    if (isHome) await update($, diffing, () => '')
  }
}

const refOf = (value: unknown, otherwise: string): string => (typeof value === 'string' && value.trim() !== '' ? value.trim() : otherwise)

const integer = (value: unknown, otherwise: number, most: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.min(most, Math.floor(value)) : otherwise

export const register: Register = (on, options) => {
  const seconds = typeof options?.pollSeconds === 'number' && Number.isFinite(options.pollSeconds) ? Math.max(0, options.pollSeconds) : 3

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'recorder', description: 'Open the pane of the runs of the command-line tool being written: each run with its arguments, how it exited, how long it took and what it wrote' })

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

    return watched.length === 0 ? composed : { sections: [...composed.sections, { id: 'recorder:watch', text: sectionText(watched), scope: 'session' as const }] }
  })

  // A quest's agents work in its worktree: each is learnt as it is sent, so a run of theirs launches that worktree's build
  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    const agentId = started.agentId
    const cwd = e.cwd

    if (cwd !== undefined && agentId !== undefined) await update($, trees, was => withTree(was, agentId, cwd))

    return started
  }).catch((_$, e, next) => next(e))

  // A command of Claude's that names a watched tool finds its launcher first on the PATH; one of a quest's agent, the
  // launcher of the quest's worktree
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!names(e.command, watched)) return next(e)

    const cwd = await workIn($, e.agentId)

    if (cwd !== (await homeOf($))) await launch($, cwd, (await projectOfTree($, cwd)).targets)

    const ran = await next({ ...e, command: `${prelude(cwd)}${e.command}` })
    await pull($).catch(() => undefined)

    return ran
  }).catch((_$, e, next) => next(e))

  on('tool.call', { tool: 'mcp__recorder__pane' }, $ => view.answer(() => $.ui.panes()))

  on('tool.call', { tool: 'mcp__recorder__runs' }, async ($, e) => {
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

  on('tool.call', { tool: 'mcp__recorder__run' }, async ($, e) => {
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

  on('tool.call', { tool: 'mcp__recorder__diff' }, async ($, e) => {
    const asked = e as unknown as { target?: unknown; from?: unknown; to?: unknown; mergeBase?: unknown; tree?: unknown }
    const made = await compare($, { target: typeof asked.target === 'string' ? asked.target : undefined, from: refOf(asked.from, 'HEAD'), to: refOf(asked.to, 'work'), mergeBase: asked.mergeBase === true, tree: await workIn($, e.agentId, asked.tree) })

    return { result: typeof made === 'string' ? made : diffText(made) }
  })

  on('command.run', { command: 'recorder' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })

    const list = await setUp($)

    if (list.length === 0) return { text: HOW_TO_WATCH }

    await pull($)

    const held = await read($, runs)
    const problems = await read($, note)

    return { text: `The recorder watches ${list.map(({ label }) => label).join(', ')}: ${held.length} ${held.length === 1 ? 'run' : 'runs'} recorded.${problems !== '' ? ` ${problems}` : ''}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Button, Code, Text } = elements
    // The mobile app draws no field: there the working tree is compared with HEAD, or Claude is asked
    const Input = 'Input' in elements ? elements.Input : undefined
    const list = await read($, targets)
    const kept = await read($, corpus)
    const made = await read($, diff)
    const playing = await read($, diffing)
    const base = await read($, against)
    const all = await read($, runs)
    const openId = await read($, selected)
    const failedOnly = await read($, isFailedOnly)
    const problems = await read($, note)
    const room = Math.max(5, (e.viewport?.rows ?? 30) - 12)
    const width = e.props.bodyColumns ?? 80
    const isWide = width >= WIDE_COLUMNS

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
        {keyed('r', 'Refresh')}
      </Button>
    )

    if (list.length === 0) {
      return view.keep(
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
            {badge({ label: 'no tool watched', tone: 'neutral' })}
            {refresh}
          </Box>
          <Text>{HOW_TO_WATCH}</Text>
        </Box>,
        width,
      )
    }

    const failed = all.filter(run => run.exitCode !== 0)
    const shown = (failedOnly ? failed : all).slice(-room).reverse()
    const open = all.find(({ id }) => id === openId)

    const rows = shown.map((run): TableCell[] => [
      clock(run.startedAt),
      ...(isWide ? [run.by === 'claude' ? 'claude' : 'you'] : []),
      { text: ending(run), tone: run.exitCode === 0 ? 'success' : 'danger' },
      ...(isWide ? [duration(run.durationMs)] : []),
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

    // A comparison: what stood in its way, or each run that changed with how, then the ones that did not by name
    const comparison = (held: RunsDiff) => {
      const stopped = diffProblems(held)
      const changed = held.cases.filter(one => one.isChanged)
      const same = held.cases.filter(one => !one.isChanged)

      return (
        <Box flexDirection="column" gap={1}>
          {badge({ label: `${diffSummary(held)} · ${clock(held.at)}`, tone: stopped.length > 0 ? 'danger' : changed.length > 0 ? 'warning' : 'success' })}
          {stopped.map(problem => (
            <Text color="error">{drawable(problem)}</Text>
          ))}
          {stopped.length === 0 && changed.length > 0 && <Text dimColor>{`- is ${sideName(held.from)}, + is ${sideName(held.to)}`}</Text>}
          {stopped.length === 0 &&
            changed.map(one => (
              <Box flexDirection="column">
                <Text bold>
                  {one.line} <Text color="warning">{exitChange(one)}</Text>
                </Text>
                {fileNotes(held, one).map(line => (
                  <Text color="warning">{line}</Text>
                ))}
                {[one.stdoutDiff, one.stderrDiff, ...one.files.map(file => file.diff)]
                  .filter(part => part.startsWith('--- '))
                  .map(part => (
                    <Code source={drawable(part)} format="diff" />
                  ))}
              </Box>
            ))}
          {stopped.length === 0 && writtenOutside(held).length > 0 && <Text color="warning">{`Written outside the folder the runs were played in, so on this machine: ${writtenOutside(held).join(', ')}`}</Text>}
          {stopped.length === 0 && same.length > 0 && <Text dimColor>{`unchanged: ${same.map(one => one.line).join(' · ')}`}</Text>}
          {stopped.length === 0 && held.untraced !== '' && <Text dimColor>{`No run was traced (${held.untraced}): writes outside the folder, and files written and removed again, were not seen.`}</Text>}
        </Box>
      )
    }

    return view.keep(
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          {badge({ label: `${all.length} ${all.length === 1 ? 'run' : 'runs'} · ${failed.length} failed`, tone: failed.length > 0 ? 'warning' : 'success' })}
          <Box flexDirection="row" columnGap={1}>
            {refresh}
            <Button key="failed-only" hotkey="f" variant={failedOnly ? 'primary' : 'secondary'} onPress={() => update($, isFailedOnly, value => !value)}>
              {keyed('f', 'Failed only')}
            </Button>
          </Box>
        </Box>
        <Box flexDirection="column">
          {list.map(({ label, binary }) => (
            <Text dimColor wrap="truncate-start">
              {label} runs {binary}
            </Text>
          ))}
          {problems !== '' && <Text color="warning">{problems}</Text>}
        </Box>
        <Box flexDirection="column" gap={1} borderStyle="round" paddingX={1}>
          <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
            <Text bold>
              {kept.length} kept {kept.length === 1 ? 'run' : 'runs'}
            </Text>
            <Button
              key="diff"
              hotkey="d"
              variant="primary"
              onPress={async () => {
                const answered = await compare($, { from: base, to: 'work', mergeBase: false, tree: await homeOf($) })

                if (typeof answered === 'string') await update($, note, () => answered)
              }}
            >
              {keyed('d', `Diff against ${base}`)}
            </Button>
            {made !== null && (
              <Button key="diff-hide" hotkey="x" onPress={() => update($, diff, () => null)}>
                {keyed('x', 'Hide')}
              </Button>
            )}
          </Box>
          {Input !== undefined && (
            <Input key="against" label="Against" placeholder="a commit by any name: HEAD, a tag, a branch" value={base} submitLabel="set" onSubmit={(text: string) => update($, against, () => text.trim() || 'HEAD')} />
          )}
          {playing !== '' && <Text color="suggestion">{`Building and playing ${playing}…`}</Text>}
          {made !== null && playing === '' && comparison(made)}
        </Box>
        {table({
          columns: [{ header: 'AT', width: 8 }, ...(isWide ? [{ header: 'BY', width: 6 }] : []), { header: 'EXIT', width: 11 }, ...(isWide ? [{ header: 'TOOK', width: 8 }] : []), { header: 'COMMAND' }],
          rows,
          empty: failedOnly && all.length > 0 ? 'No run failed.' : `No run yet. Run ${list[0]?.label ?? 'the tool'} by its name, here or with ${HOME}/bin first on the PATH of a terminal of your own.`,
        })}
        {open !== undefined && (
          <Box flexDirection="column" gap={1} borderStyle="round" paddingX={1}>
            <Box flexDirection="column">
              <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
                <Text bold>{commandLine(open)}</Text>
                {kept.includes(commandLine(open)) ? (
                  <Text dimColor>kept</Text>
                ) : (
                  <Button
                    key="keep"
                    hotkey="k"
                    onPress={async () => {
                      const file = await projectFileIn($, await homeOf($))

                      await $.fs.write(file, withKept(await $.fs.read(file).catch(() => ''), commandLine(open)))
                      await setUp($).catch(() => undefined)
                    }}
                  >
                    {keyed('k', 'Keep')}
                  </Button>
                )}
              </Box>
              <Text dimColor>
                {`exit ${ending(open)} · by ${open.by === 'claude' ? 'claude' : 'you'} at ${clock(open.startedAt)} · ${duration(open.durationMs)} · cpu ${duration(open.userMs + open.sysMs)} · ${size(open.maxRssKb * 1024)} · in ${open.cwd}`}
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
      width,
    )
  })
}
