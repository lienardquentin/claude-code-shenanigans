import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { LothlorienState, LothlorienVision } from '../types'
import { GALADRIEL_EFFORT, GALADRIEL_MODEL, GALADRIEL_SWIFT_MODEL, GALADRIEL_SYSTEM, HOW_TO, blocksOf, gazePrompt, isChanging, isTestPath, lockedIn, missingFrom, parseGaze, takenBy, tamperedWith, visionJson, visionText } from './mirror'
import { badge } from './kit/badge'
import type { Tone } from './kit/badge'
import { paneView } from './kit/pane-text'
import { errorText, rootOf } from './kit/flow'
import { isTree, treeOf, withTree } from './kit/trees'
import type { Trees } from './kit/trees'

type $ = EngineInterface

const PANE = 'lothlorien'
const TITLE = 'Lothlórien'
const AGENT = 'galadriel'
const AGENT_TYPE = `lothlorien:${AGENT}`
// She gazes on Sonnet for a task that is not heavy: the same charge, a lighter model
const SWIFT = 'galadriel-swift'
const SWIFT_TYPE = `lothlorien:${SWIFT}`

const vision = atom({ plugin: 'lothlorien', key: 'vision' } as const, null as LothlorienVision | null)
const visions = atom({ plugin: 'lothlorien', key: 'visions' } as const, {} as Record<string, LothlorienVision>)
const trees = atom({ plugin: 'lothlorien', key: 'trees' } as const, {} as Trees)
const note = atom({ plugin: 'lothlorien', key: 'note' } as const, '')

const view = paneView({ id: PANE, title: TITLE, command: '/mirror' })

const TREE = { type: 'string', description: "From a mod: the quest's worktree, in place of the project's folder. An agent sent to work in one is answered of it without it." } as const

const TOOLS = [
  {
    name: 'gaze',
    description:
      "Has Galadriel gaze into the Mirror: before a behaviour is built, she writes the tests that will prove it, runs them to show them red, and they are locked until they are committed. She runs in the background: this answers at once, and mcp__lothlorien__mirror says what she showed. Call it before building a behaviour test-first, with what is to be built and how to tell it is done.",
    inputSchema: {
      type: 'object',
      properties: {
        purpose: { type: 'string', description: 'What is to come: the behaviour, the task, how to tell it is done.' },
        ref: { type: 'string', description: 'The issue it is for, as the mod that asks names it: forget then lets go only of the vision of that issue.' },
        weight: { type: 'string', enum: ['light', 'standard', 'heavy'], description: 'How much the task asks: she gazes on a lighter model for one that is not heavy. Heavy when left out.' },
        tree: TREE,
      },
      required: ['purpose'],
    },
  },
  {
    name: 'mirror',
    description: "What the Mirror shows: Galadriel's tests, how they failed, whether they are still locked, and each change made to them and why.",
    inputSchema: { type: 'object', properties: { json: { type: 'boolean', description: 'Answer as JSON, for a mod that waits on her.' }, tree: TREE } },
  },
  {
    name: 'forget',
    description: 'Lets the Mirror go still: forgets what Galadriel showed once her tests are committed. One still locked is kept, and so is one gazed for another issue than the one named. For Mount Doom.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'The issue whose vision to forget: a vision gazed for another is kept.' },
        json: { type: 'boolean', description: 'Answer as JSON, `{ forgotten, text }`, for a mod that reads it.' },
      },
    },
  },
  {
    name: 'amend',
    description:
      "Unlocks one of Galadriel's test files for a change to her tests, with the reason: a test that asserts something the purpose does not ask, or that cannot pass as written. The reason is kept and shown to whoever judges the change. Never call it to make a test easier to pass.",
    inputSchema: {
      type: 'object',
      properties: { file: { type: 'string', description: 'The test file, from the project folder.' }, why: { type: 'string', description: 'What is wrong with the test as she wrote it, in a sentence or two.' } },
      required: ['file', 'why'],
    },
  },
] as const

const STATE_TONE: Record<LothlorienState, Tone> = { gazing: 'info', shown: 'success', empty: 'neutral', clouded: 'danger' }

/** The folder a vision is of: the project's, or a quest's worktree. */
type Place = { tree: string; isHome: boolean }

const placeOf = async ($: $, agentId?: string, named?: unknown): Promise<Place> => {
  const home = await rootOf($)
  const tree = treeOf(home, await read($, trees), agentId, named)

  return { tree, isHome: tree === home }
}

/** The place a file is in: the quest's worktree that holds it, else the project's folder. */
const placeOfPath = async ($: $, path: string): Promise<Place> => {
  const home = await rootOf($)
  const whole = path.startsWith('/') ? path : `${home}/${path.replace(/^\.\//, '')}`
  const tree = Object.keys(await read($, visions))
    .filter(one => whole.startsWith(`${one}/`) && isTree(home, one))
    .sort((one, other) => other.length - one.length)[0]

  return tree === undefined ? { tree: home, isHome: true } : { tree, isHome: false }
}

const visionIn = async ($: $, place: Place): Promise<LothlorienVision | null> => (place.isHome ? read($, vision) : ((await read($, visions))[place.tree] ?? null))

const setVision = async ($: $, place: Place, change: (was: LothlorienVision | null) => LothlorienVision | null): Promise<void> => {
  if (place.isHome) {
    await update($, vision, change)

    return
  }

  await update($, visions, was => {
    const { [place.tree]: held, ...rest } = was
    const made = change(held ?? null)

    return made === null ? rest : { ...rest, [place.tree]: made }
  })
}

/** Every vision held, with its place. */
const allVisions = async ($: $): Promise<{ place: Place; held: LothlorienVision }[]> => {
  const own = await read($, vision)

  return [...(own === null ? [] : [{ place: { tree: await rootOf($), isHome: true }, held: own }]), ...Object.entries(await read($, visions)).map(([tree, held]) => ({ place: { tree, isHome: false }, held }))]
}

const git = async ($: $, place: Place, args: readonly string[]): Promise<{ ok: boolean; out: string }> => {
  const ran = await $.process.run(['git', ...args], { cwd: place.tree }).catch((error: unknown) => ({ exitCode: -1, stdout: '', stderr: errorText(error) }))

  // Trimmed at the end alone: a porcelain status line opens on a column of its code, a space for a file changed unstaged
  return { ok: ran.exitCode === 0, out: (ran.exitCode === 0 ? ran.stdout : ran.stderr || ran.stdout).trimEnd() }
}

/** A path as its folder names it: from the project's folder, or from the quest's worktree it is in. */
const within = (place: Place, path: string): string => (path.startsWith(`${place.tree}/`) ? path.slice(place.tree.length + 1) : path.replace(/^\.\//, ''))

/** Whether her tests are still locked: shown, and not committed yet, HEAD where it was when she gazed. */
const isLocked = async ($: $, place: Place, held: LothlorienVision | null): Promise<boolean> => held !== null && held.state === 'shown' && (await git($, place, ['rev-parse', 'HEAD'])).out === held.head

/** Sends Galadriel to gaze, in the place asked. Answers what was done, in a sentence. */
const gaze = async ($: $, purpose: string, by: LothlorienVision['by'], place: Place, ref = '', weight = 'heavy'): Promise<string> => {
  if (purpose.trim() === '') return 'Say what is to come: the behaviour, and how to tell it is done.'

  const held = await visionIn($, place)

  if (held?.state === 'gazing') return 'Galadriel is gazing already: wait for what the Mirror shows.'

  const head = (await git($, place, ['rev-parse', 'HEAD'])).out
  // In a quest's worktree she writes her tests there
  const started = await $.agent
    .spawn({ subagentType: weight === 'heavy' ? AGENT_TYPE : SWIFT_TYPE, description: 'Galadriel gazes into the Mirror', prompt: gazePrompt(purpose), ...(place.isHome ? {} : { cwd: place.tree }) })
    .catch((error: unknown) => ({ deny: errorText(error), agentId: undefined }))

  if (started.deny !== undefined) return `Galadriel could not be sent: ${started.deny}`

  await setVision($, place, (): LothlorienVision => ({ purpose: purpose.trim(), ...(ref !== '' ? { ref } : {}), by, agentId: started.agentId ?? '', state: 'gazing', head, tests: [], red: '', why: '', blocks: [], amendments: [], at: Date.now(), ...(place.isHome ? {} : { tree: place.tree }) }))
  await update($, note, () => '')

  return 'Galadriel gazes into the Mirror: she writes the tests of what is to come and shows them red. mcp__lothlorien__mirror says what she showed.'
}

/** What she wrote in test files: the lines added to tracked ones, and the new ones whole. */
const writtenBy = async ($: $, place: Place): Promise<ReturnType<typeof blocksOf>> => {
  const status = await git($, place, ['status', '--porcelain', '--untracked-files=all'])
  const entries = status.out
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => ({ code: line.slice(0, 2), file: line.slice(3).trim() }))
    .filter(entry => isTestPath(entry.file))
  const tracked = entries.filter(entry => entry.code !== '??').map(entry => entry.file)
  const diff = tracked.length === 0 ? '' : (await git($, place, ['diff', '-U0', '--no-color', 'HEAD', '--', ...tracked])).out
  const created: { file: string; text: string }[] = []

  for (const entry of entries.filter(one => one.code === '??')) created.push({ file: entry.file, text: String(await $.fs.read(`${place.tree}/${entry.file}`).catch(() => '')) })

  return blocksOf(diff, created)
}

/** Her turn has ended: what she showed is read and locked, and a person who asked through /mirror has their Claude told. */
const behold = async ($: $, place: Place, held: LothlorienVision, answer: string, ended: string): Promise<void> => {
  const said = ended === 'answer' ? parseGaze(answer) : undefined
  const blocks = await writtenBy($, place)
  const clouded = (why: string): LothlorienVision => ({ ...held, state: 'clouded', why, blocks: [] })
  const made: LothlorienVision =
    said === undefined
      ? clouded(ended === 'answer' ? 'she gave no answer that reads' : ended === 'aborted' ? 'she was interrupted' : ended === 'refusal' ? 'she refused' : 'an API error ended her gaze')
      : said.tests.length === 0
        ? said.untestable !== ''
          ? { ...held, state: 'empty', why: said.untestable }
          : clouded('she named no test, and no reason there is none')
        : blocks.length === 0
          ? clouded('she named tests, but no test file holds anything new')
          : said.red === ''
            ? clouded('she did not show her tests red')
            : { ...held, state: 'shown', tests: said.tests, red: said.red, blocks }

  await setVision($, place, () => made)
  $.ui.toast(`Lothlórien: ${made.state === 'shown' ? `${made.tests.length} red ${made.tests.length === 1 ? 'test' : 'tests'} show what is to come` : made.state === 'empty' ? 'nothing to test' : `the Mirror is clouded: ${made.why}`}`)

  if (made.by === 'command') await $.prompt.submit({ text: visionText(made, await isLocked($, place, made)) }).catch(() => undefined)
}

/** Whether an agent is Galadriel gazing on a vision: by the id her spawn answered, else, where it answered none, by her type. */
const isGaladriel = async ($: $, held: LothlorienVision | null, agentId: string): Promise<boolean> => {
  if (held === null || held.state !== 'gazing') return false

  return held.agentId !== '' ? agentId === held.agentId : (await $.agent.list().catch(() => [])).some(one => one.id === agentId && (one.type === AGENT_TYPE || one.type === SWIFT_TYPE) && one.status === 'running')
}

/** The vision Galadriel gazes on, wherever she gazes; nothing when the agent is not her. */
const gazingFor = async ($: $, agentId: string): Promise<{ place: Place; held: LothlorienVision } | undefined> => {
  for (const one of await allVisions($)) if (await isGaladriel($, one.held, agentId)) return one

  return undefined
}

/** Who is changing her tests, for the record: the agent's type, else the session itself. */
const whoIs = async ($: $, agentId: string | undefined): Promise<string> => {
  if (agentId === undefined) return 'the session'

  const agent = (await $.agent.list().catch(() => [])).find(one => one.id === agentId)

  return agent?.type ?? agentId
}

/** What was taken out of her locked tests with no reason given, while they are locked: an edit the lock did not see. */
const tampered = async ($: $, place: Place, held: LothlorienVision | null): Promise<{ file: string; lines: string[] }[]> => {
  if (held === null || !(await isLocked($, place, held))) return []

  const files = []

  for (const file of [...new Set(held.blocks.map(block => block.file))]) files.push({ file, text: String(await $.fs.read(`${place.tree}/${file}`).catch(() => '')) })

  return tamperedWith(held.blocks, held.amendments, files)
}

/** Unlocks a file of hers for a change, keeping why. */
const amend = async ($: $, place: Place, file: string, why: string, by: string): Promise<string> => {
  const held = await visionIn($, place)
  const path = within(place, file)

  if (!(await isLocked($, place, held)) || held === null) return 'No test of Galadriel\'s is locked: change what you need.'
  if (lockedIn(held.blocks, path).length === 0) return `${path} holds none of Galadriel's tests: it is not locked.`
  if (why.trim().length < 12) return 'Say why her test is wrong, in a sentence: the reason goes to whoever judges the change.'

  await setVision($, place, was => (was === null ? was : { ...was, amendments: [...was.amendments, { file: path, why: why.trim(), by, at: Date.now() }] }))

  return `${path} is unlocked for the change. The reason is kept and shown to whoever judges it.`
}

/** Why a change to a file takes her locked lines out without a reason; empty when it does not, or one is given. */
const refusal = async ($: $, path: string, taken: (locked: string[]) => string[]): Promise<string> => {
  const place = await placeOfPath($, path)
  const held = await visionIn($, place)

  if (held === null || held.state !== 'shown') return ''

  const file = within(place, path)
  const locked = lockedIn(held.blocks, file)

  if (locked.length === 0 || held.amendments.some(one => one.file === file) || !(await isLocked($, place, held))) return ''

  const gone = taken(locked)

  return gone.length === 0
    ? ''
    : `That change takes out ${gone.length === 1 ? 'a line' : `${gone.length} lines`} of Galadriel's tests in ${file} (${gone.slice(0, 2).map(line => `\`${line.trim()}\``).join(', ')}). Her tests are locked: make them pass as they are. If one is wrong, call mcp__lothlorien__amend with the file and why, then change it.`
}

const sectionText = (held: LothlorienVision): string =>
  `The Lothlórien mod holds Galadriel's tests of what is to come, red and locked until they are committed: ${held.tests.map(test => `${test.file} ${test.name}`).join(', ')}. Make them pass without changing them; a test that is wrong is changed only after mcp__lothlorien__amend says why.`

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'mirror', description: 'Galadriel writes the failing tests of what is to come: /mirror <the behaviour>; /mirror alone shows what the Mirror holds' })
    for (const [name, model] of [[AGENT, GALADRIEL_MODEL], [SWIFT, GALADRIEL_SWIFT_MODEL]] as const) {
      await $.agent
        .register({
          name,
          description: 'Galadriel: writes the failing tests of a behaviour before it is built, and only tests. Sent by the Lothlórien mod alone.',
          prompt: GALADRIEL_SYSTEM,
          tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'],
          permissionMode: 'acceptEdits',
          disallowedTools: ['Agent', 'NotebookEdit'],
          model,
          effort: GALADRIEL_EFFORT,
        })
        .catch(() => undefined)
    }

    // A host that registers no tools still starts the session
    for (const tool of [view.tool, ...TOOLS]) await $.tool.register(tool).catch(() => undefined)

    // A reload loads the module afresh: a pane drawn by the copy before it is drawn again, so its buttons press this one
    $.ui.invalidate('ui.render')

    return next(e)
  })

  // Galadriel is sent by the mod, never through the Agent tool
  on('agent.offer', { agent: AGENT_TYPE }, () => ({ isOffered: false }))
  on('agent.offer', { agent: SWIFT_TYPE }, () => ({ isOffered: false }))

  // A quest's builders work in its worktree: each is learnt as it is sent, so what it says of her tests is of that worktree
  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    const agentId = started.agentId
    const cwd = e.cwd

    if (cwd !== undefined && agentId !== undefined) await update($, trees, was => withTree(was, agentId, cwd))

    return started
  }).catch((_$, e, next) => next(e))

  // Her turn has ended: what she wrote is what the Mirror shows
  on('turn.complete', async ($, e, next) => {
    const found = e.agentId === undefined ? undefined : await gazingFor($, e.agentId)

    if (found !== undefined) await behold($, found.place, found.held, e.answer ?? '', e.isAborted ? 'aborted' : e.reason)

    return next(e)
  })

  // She writes tests and nothing else; anyone else leaves her tests as they are, unless they say why
  on('tool.call', async ($, e, next) => {
    const given = e as unknown as { tool: string; agentId?: string; command?: unknown; file_path?: unknown; old_string?: unknown; new_string?: unknown; content?: unknown }
    const gazing = given.agentId === undefined ? undefined : await gazingFor($, given.agentId)

    if (gazing !== undefined) {
      if (given.tool === 'Bash' && typeof given.command === 'string' && isChanging(given.command)) return { deny: 'Galadriel writes her tests with Write and Edit, and runs only what tests or reads.' }
      if ((given.tool === 'Edit' || given.tool === 'Write') && typeof given.file_path === 'string' && !isTestPath(within(gazing.place, given.file_path))) return { deny: 'The Mirror shows what is to come as tests: write only in test files, and leave the source for whoever builds it.' }

      return next(e)
    }

    if (typeof given.file_path !== 'string' || (given.tool !== 'Edit' && given.tool !== 'Write')) return next(e)

    const why =
      given.tool === 'Edit' && typeof given.old_string === 'string' && typeof given.new_string === 'string'
        ? await refusal($, given.file_path, locked => takenBy(locked, String(given.old_string), String(given.new_string)))
        : given.tool === 'Write' && typeof given.content === 'string'
          ? await refusal($, given.file_path, locked => missingFrom(locked, String(given.content)))
          : ''

    return why === '' ? next(e) : { deny: why }
  }).catch((_$, e, next) => next(e))

  // Claude is told her tests are locked while they are: those of the project's own folder, which it works in
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const place = { tree: await rootOf($), isHome: true }
    const held = await visionIn($, place)

    return held === null || !(await isLocked($, place, held)) ? composed : { sections: [...composed.sections, { id: 'lothlorien:mirror', text: sectionText(held), scope: 'session' as const }] }
  })

  on('tool.call', { tool: 'mcp__lothlorien__pane' }, $ => view.answer(() => $.ui.panes()))

  on('tool.call', { tool: 'mcp__lothlorien__gaze' }, async ($, e) => {
    const given = e as unknown as { purpose?: unknown; ref?: unknown; weight?: unknown; tree?: unknown }

    return { result: await gaze($, String(given.purpose ?? ''), 'tool', await placeOf($, e.agentId, given.tree), typeof given.ref === 'string' ? given.ref : '', given.weight === 'light' || given.weight === 'standard' ? given.weight : 'heavy') }
  })

  on('tool.call', { tool: 'mcp__lothlorien__mirror' }, async ($, e) => {
    const given = e as unknown as { json?: unknown; tree?: unknown }
    const place = await placeOf($, e.agentId, given.tree)
    const held = await visionIn($, place)
    const locked = await isLocked($, place, held)
    const taken = await tampered($, place, held)

    return { result: given.json === true ? visionJson(held, locked, taken) : held === null ? HOW_TO : visionText(held, locked, taken) }
  })

  on('tool.call', { tool: 'mcp__lothlorien__forget' }, async ($, e) => {
    const given = e as unknown as { ref?: unknown; json?: unknown }
    const ref = typeof given.ref === 'string' ? given.ref : ''
    const answer = (forgotten: boolean, text: string) => ({ result: given.json === true ? JSON.stringify({ forgotten, text }) : text })
    const held = await allVisions($)
    // Each vision gazed for the issue, or the project's own when none is named
    const named = held.filter(one => (ref === '' ? one.place.isHome : one.held.ref === undefined ? one.place.isHome : one.held.ref === ref))

    if (named.length === 0) return answer(false, held.length === 0 ? 'The Mirror is still.' : `The Mirror holds no vision of ${ref}: what it holds is kept.`)

    for (const { place, held: one } of named) if (one.state === 'gazing' || (await isLocked($, place, one))) return answer(false, 'Galadriel\'s tests are not committed yet: the Mirror keeps them.')
    for (const { place } of named) await setVision($, place, () => null)

    return answer(true, 'The Mirror is still.')
  })

  on('tool.call', { tool: 'mcp__lothlorien__amend' }, async ($, e) => {
    const given = e as unknown as { file?: unknown; why?: unknown }
    const file = String(given.file ?? '')
    // A builder in a quest's worktree amends the tests there, whichever way it names the file
    const sent = await placeOf($, e.agentId)
    const place = sent.isHome && file.startsWith('/') ? await placeOfPath($, file) : sent

    return { result: await amend($, place, file, String(given.why ?? ''), await whoIs($, e.agentId)) }
  })

  on('command.run', { command: 'mirror' }, async ($, e) => {
    await $.ui.open({ id: PANE, title: TITLE })

    const place = { tree: await rootOf($), isHome: true }

    if (e.args.trim() === '') {
      const held = await visionIn($, place)

      return { text: held === null ? HOW_TO : visionText(held, await isLocked($, place, held)) }
    }

    return { text: await gaze($, e.args, 'command', place) }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    // The project's own vision, else the last a quest's worktree holds
    const shown = (await allVisions($)).sort((one, other) => (one.place.isHome ? -1 : other.place.isHome ? 1 : other.held.at - one.held.at))[0]
    const problem = await read($, note)

    if (shown === undefined) {
      return view.keep(
        <Box flexDirection="column" gap={1}>
          {badge({ label: 'still', tone: 'neutral' })}
          <Text dimColor>{HOW_TO}</Text>
        </Box>,
      )
    }

    const { place, held } = shown
    const locked = await isLocked($, place, held)
    const others = (await read($, visions))
    const elsewhere = Object.keys(others).filter(tree => tree !== place.tree).length

    return view.keep(
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={2}>
          {badge({ label: held.state, tone: STATE_TONE[held.state] })}
          {held.state === 'shown' && badge({ label: locked ? 'locked' : 'committed', tone: locked ? 'warning' : 'success' })}
          <Text dimColor>{new Date(held.at).toLocaleTimeString()}</Text>
        </Box>
        {!place.isHome && <Text dimColor>{`In the quest's worktree ${place.tree.split('/').slice(-1)[0] ?? ''}${held.ref !== undefined ? `, for ${held.ref}` : ''}`}</Text>}
        {elsewhere > 0 && <Text dimColor>{`${elsewhere} more ${elsewhere === 1 ? 'vision' : 'visions'} in other quests' worktrees`}</Text>}
        {problem !== '' && <Text color="warning">{problem}</Text>}
        <Text dimColor wrap="truncate-end">{held.purpose.split('\n')[0] ?? ''}</Text>
        {held.why !== '' && <Text color={held.state === 'clouded' ? 'error' : undefined}>{held.why}</Text>}
        {held.tests.length > 0 && (
          <Box flexDirection="column" borderStyle="round" paddingX={1}>
            {held.tests.map(test => (
              <Text key={`${test.file}:${test.name}`} color="error">{`✗ ${test.file}  ${test.name}`}</Text>
            ))}
          </Box>
        )}
        {held.red !== '' && <Text dimColor>{held.red.split('\n').slice(0, 8).join('\n')}</Text>}
        {held.amendments.length > 0 && (
          <Box flexDirection="column">
            <Text color="warning" bold>Changed, and why</Text>
            {held.amendments.map(one => (
              <Text key={`${one.file}:${one.at}`}>{`  ${one.file}, by ${one.by}: ${one.why}`}</Text>
            ))}
          </Box>
        )}
      </Box>,
    )
  })
}
