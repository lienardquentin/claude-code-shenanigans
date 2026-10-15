import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { LothlorienState, LothlorienVision, MiddleEarthAgent } from '../../types'
import { HOW_TO, blocksOf, forgottenOf, gazePrompt, isTestPath, lockedIn, missingFrom, parseGaze, shownOf, takenBy, tamperedWith, visionText } from './mirror'
import type { Shown } from './mirror'
import { badge } from '../kit/badge'
import type { Tone } from '../kit/badge'
import { paneView } from '../kit/pane-text'
import { errorText, rootOf } from '../flow'
import type { Section, TurnEnded } from '../flow'
import { isTree, treeOf } from '../kit/trees'
import { GALADRIEL, GALADRIEL_SWIFT, agentOf, remember, treesOf, typeOf } from '../agents'

type $ = EngineInterface
type On = Parameters<Register>[0]

const PANE = 'lothlorien'
const TITLE = 'Lothlórien'
const AGENT_TYPE = typeOf(GALADRIEL)
const SWIFT_TYPE = typeOf(GALADRIEL_SWIFT)

const vision = atom({ plugin: 'middle-earth', key: 'lothlorienVision' } as const, null as LothlorienVision | null)
const visions = atom({ plugin: 'middle-earth', key: 'lothlorienVisions' } as const, {} as Record<string, LothlorienVision>)
const note = atom({ plugin: 'middle-earth', key: 'lothlorienNote' } as const, '')

export const lothlorienView = paneView({ id: PANE, title: TITLE, command: '/mirror' })
const view = lothlorienView

const TOOLS = [
  {
    name: 'gaze',
    description:
      "Writes tests first: a test-writing subagent (Galadriel) writes the tests that will prove a behaviour before it is built, runs them to show they fail, and they stay locked against edits until committed. It runs in the background: this answers at once, and mcp__middle-earth__mirror says what it wrote. Call it before building a behaviour test-first, with what is to be built and how to tell it is done.",
    inputSchema: {
      type: 'object',
      properties: {
        purpose: { type: 'string', description: 'What is to come: the behaviour, the task, how to tell it is done.' },
        weight: { type: 'string', enum: ['light', 'standard', 'heavy'], description: 'How much the task asks: she gazes on a lighter model for one that is not heavy. Heavy when left out.' },
      },
      required: ['purpose'],
    },
  },
  {
    name: 'mirror',
    description: 'The tests written first: each test, how it failed, whether it is still locked, and each change made to it and why.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'amend',
    description:
      "Unlocks a locked test file (tests written first) for a change, with the reason: a test that asserts something the purpose does not ask, or that cannot pass as written. The reason is kept and shown to the reviewers. Never call it to make a test easier to pass.",
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

/** The place a call is about: a quest's worktree a part names or the calling agent was sent to work in, else the project's. */
async function placeOf($: $, agentId?: string, named?: unknown): Promise<Place> {
  const home = await rootOf($)
  const tree = treeOf(home, treesOf(), agentId, named)

  return { tree, isHome: tree === home }
}

/** The place a file is in: the quest's worktree that holds it, else the project's folder. */
async function placeOfPath($: $, path: string): Promise<Place> {
  const home = await rootOf($)
  const whole = path.startsWith('/') ? path : `${home}/${path.replace(/^\.\//, '')}`
  const tree = Object.keys(await read($, visions))
    .filter(one => whole.startsWith(`${one}/`) && isTree(home, one))
    .sort((one, other) => other.length - one.length)[0]

  return tree === undefined ? { tree: home, isHome: true } : { tree, isHome: false }
}

async function visionIn($: $, place: Place): Promise<LothlorienVision | null> {
  return (place.isHome ? read($, vision) : ((await read($, visions))[place.tree] ?? null))
}

async function setVision($: $, place: Place, change: (was: LothlorienVision | null) => LothlorienVision | null): Promise<void> {
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
async function allVisions($: $): Promise<{ place: Place; held: LothlorienVision }[]> {
  const own = await read($, vision)

  return [...(own === null ? [] : [{ place: { tree: await rootOf($), isHome: true }, held: own }]), ...Object.entries(await read($, visions)).map(([tree, held]) => ({ place: { tree, isHome: false }, held }))]
}

async function git($: $, place: Place, args: readonly string[]): Promise<{ ok: boolean; out: string }> {
  const ran = await $.process.run(['git', ...args], { cwd: place.tree }).catch((error: unknown) => ({ exitCode: -1, stdout: '', stderr: errorText(error) }))

  // Trimmed at the end alone: a porcelain status line opens on a column of its code, a space for a file changed unstaged
  return { ok: ran.exitCode === 0, out: (ran.exitCode === 0 ? ran.stdout : ran.stderr || ran.stdout).trimEnd() }
}

/** A path as its folder names it: from the project's folder, or from the quest's worktree it is in. */
const within = (place: Place, path: string): string => (path.startsWith(`${place.tree}/`) ? path.slice(place.tree.length + 1) : path.replace(/^\.\//, ''))

/** Whether her tests are still locked: shown, and not committed yet, HEAD where it was when she gazed. */
async function isLocked($: $, place: Place, held: LothlorienVision | null): Promise<boolean> {
  return held !== null && held.state === 'shown' && (await git($, place, ['rev-parse', 'HEAD'])).out === held.head
}

/** Sends Galadriel to gaze, in the place asked. Answers what was done, in a sentence. */
async function gaze($: $, purpose: string, by: LothlorienVision['by'], place: Place, ref = '', weight = 'heavy'): Promise<string> {
  if (purpose.trim() === '') return 'Say what is to come: the behaviour, and how to tell it is done.'

  const held = await visionIn($, place)

  if (held?.state === 'gazing') return 'Galadriel is gazing already: wait for what the Mirror shows.'

  const head = (await git($, place, ['rev-parse', 'HEAD'])).out
  // In a quest's worktree she writes her tests there
  const started = await $.agent
    .spawn({ subagentType: weight === 'heavy' ? AGENT_TYPE : SWIFT_TYPE, description: 'Galadriel gazes into the Mirror', prompt: gazePrompt(purpose), ...(place.isHome ? {} : { cwd: place.tree }) })
    .catch((error: unknown) => ({ deny: errorText(error), agentId: undefined }))

  if (started.deny !== undefined) return `Galadriel could not be sent: ${started.deny}`
  if (started.agentId !== undefined && started.agentId !== '') await remember($, started.agentId, { role: 'galadriel', root: await rootOf($), tree: place.tree })

  await setVision($, place, (): LothlorienVision => ({ purpose: purpose.trim(), ...(ref !== '' ? { ref } : {}), by, agentId: started.agentId ?? '', state: 'gazing', head, tests: [], red: '', why: '', blocks: [], amendments: [], at: Date.now(), ...(place.isHome ? {} : { tree: place.tree }) }))
  await update($, note, () => '')

  return 'Galadriel gazes into the Mirror: she writes the tests of what is to come and shows them red. mcp__middle-earth__mirror says what she showed.'
}

/** Has Galadriel write a quest's task's tests first, in its worktree. Answers what was done, in a sentence. */
export async function gazeFor($: $, purpose: string, ref: string, weight: string, tree: string): Promise<string> {
  return gaze($, purpose, 'tool', await placeOf($, undefined, tree), ref, weight)
}

/** What she wrote in test files: the lines added to tracked ones, and the new ones whole. */
async function writtenBy($: $, place: Place): Promise<ReturnType<typeof blocksOf>> {
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
async function behold($: $, place: Place, held: LothlorienVision, answer: string, ended: string): Promise<void> {
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
async function isGaladriel($: $, held: LothlorienVision | null, agentId: string): Promise<boolean> {
  if (held === null || held.state !== 'gazing') return false

  return held.agentId !== '' ? agentId === held.agentId : (await $.agent.list().catch(() => [])).some(one => one.id === agentId && (one.type === AGENT_TYPE || one.type === SWIFT_TYPE) && one.status === 'running')
}

/** The vision Galadriel gazes on, wherever she gazes; nothing when the agent is not her. */
async function gazingFor($: $, agentId: string): Promise<{ place: Place; held: LothlorienVision } | undefined> {
  for (const one of await allVisions($)) if (await isGaladriel($, one.held, agentId)) return one

  return undefined
}

/** Who is changing her tests, for the record: the agent's type, else the session itself. */
async function whoIs($: $, agentId: string | undefined): Promise<string> {
  if (agentId === undefined) return 'the session'

  const agent = (await $.agent.list().catch(() => [])).find(one => one.id === agentId)

  return agent?.type ?? agentId
}

/** What was taken out of her locked tests with no reason given, while they are locked: an edit the lock did not see. */
async function tampered($: $, place: Place, held: LothlorienVision | null): Promise<{ file: string; lines: string[] }[]> {
  if (held === null || !(await isLocked($, place, held))) return []

  const files = []

  for (const file of [...new Set(held.blocks.map(block => block.file))]) files.push({ file, text: String(await $.fs.read(`${place.tree}/${file}`).catch(() => '')) })

  return tamperedWith(held.blocks, held.amendments, files)
}

/** What the Mirror shows of a quest's worktree, for the Fellowship, which waits on her and reads what was changed of her tests. */
export async function mirrorIn($: $, tree: string): Promise<Shown> {
  const place = await placeOf($, undefined, tree)
  const held = await visionIn($, place)

  return shownOf(held, await isLocked($, place, held), await tampered($, place, held))
}

/**
 * Forgets the tests written first of an issue once they are committed, for Mount Doom: each vision gazed for it, or the
 * project's own when none is named. Tests still locked are kept.
 */
export async function forgetVisions($: $, ref: string): Promise<{ forgotten: boolean; text: string }> {
  const held = await allVisions($)
  const named = forgottenOf(held, ref)

  if (named.length === 0) return { forgotten: false, text: held.length === 0 ? 'The Mirror is still.' : `The Mirror holds no vision of ${ref}: what it holds is kept.` }

  for (const { place, held: one } of named) if (one.state === 'gazing' || (await isLocked($, place, one))) return { forgotten: false, text: "Galadriel's tests are not committed yet: the Mirror keeps them." }
  for (const { place } of named) await setVision($, place, () => null)

  return { forgotten: true, text: 'The Mirror is still.' }
}

/** Unlocks a file of hers for a change, keeping why. */
async function amend($: $, place: Place, file: string, why: string, by: string): Promise<string> {
  const held = await visionIn($, place)
  const path = within(place, file)

  if (!(await isLocked($, place, held)) || held === null) return 'No test of Galadriel\'s is locked: change what you need.'
  if (lockedIn(held.blocks, path).length === 0) return `${path} holds none of Galadriel's tests: it is not locked.`
  if (why.trim().length < 12) return 'Say why her test is wrong, in a sentence: the reason goes to whoever judges the change.'

  await setVision($, place, was => (was === null ? was : { ...was, amendments: [...was.amendments, { file: path, why: why.trim(), by, at: Date.now() }] }))

  return `${path} is unlocked for the change. The reason is kept and shown to whoever judges it.`
}

/** Why a change to a file takes her locked lines out without a reason; empty when it does not, or one is given. */
async function refusal($: $, path: string, taken: (locked: string[]) => string[]): Promise<string> {
  const place = await placeOfPath($, path)
  const held = await visionIn($, place)

  if (held === null || held.state !== 'shown') return ''

  const file = within(place, path)
  const locked = lockedIn(held.blocks, file)

  if (locked.length === 0 || held.amendments.some(one => one.file === file) || !(await isLocked($, place, held))) return ''

  const gone = taken(locked)

  return gone.length === 0
    ? ''
    : `That change takes out ${gone.length === 1 ? 'a line' : `${gone.length} lines`} of Galadriel's tests in ${file} (${gone.slice(0, 2).map(line => `\`${line.trim()}\``).join(', ')}). Her tests are locked: make them pass as they are. If one is wrong, call mcp__middle-earth__amend with the file and why, then change it.`
}

const sectionText = (held: LothlorienVision): string =>
  `Lothlórien holds Galadriel's tests of what is to come, red and locked until they are committed: ${held.tests.map(test => `${test.file} ${test.name}`).join(', ')}. Make them pass without changing them; a test that is wrong is changed only after mcp__middle-earth__amend says why.`

/** Lothlórien at the session's start: its command and its tools. */
export async function startLothlorien($: $): Promise<void> {
  await $.command.register({ name: 'mirror', description: 'Galadriel writes the failing tests of what is to come: /mirror <the behaviour>; /mirror alone shows what the Mirror holds' })

  // A host that registers no tools still starts the session
  for (const tool of TOOLS) await $.tool.register(tool).catch(() => undefined)
}

/** A turn has ended: hers is what the Mirror shows. */
export async function endedLothlorien($: $, e: TurnEnded): Promise<void> {
  const found = e.agentId === undefined ? undefined : await gazingFor($, e.agentId)

  if (found !== undefined) await behold($, found.place, found.held, e.answer ?? '', e.isAborted ? 'aborted' : e.reason)
}

/**
 * Why a call may not change a file: whoever is not her leaves her locked tests as they are, unless they say why. What
 * she herself may write is the guard's. Empty when the call takes nothing of them out.
 */
export async function lockRefusal($: $, e: unknown): Promise<string> {
  const given = e as { tool?: unknown; agentId?: string; file_path?: unknown; old_string?: unknown; new_string?: unknown; content?: unknown }

  if (agentOf(given.agentId)?.role === 'galadriel' || typeof given.file_path !== 'string') return ''
  if (given.tool === 'Edit' && typeof given.old_string === 'string' && typeof given.new_string === 'string') return refusal($, given.file_path, locked => takenBy(locked, String(given.old_string), String(given.new_string)))
  if (given.tool === 'Write' && typeof given.content === 'string') return refusal($, given.file_path, locked => missingFrom(locked, String(given.content)))

  return ''
}

/** What Claude is told of her tests while they are locked: those of the project's own folder, which it works in. */
export async function sectionOfLothlorien($: $): Promise<Section | undefined> {
  const place = { tree: await rootOf($), isHome: true }
  const held = await visionIn($, place)

  return held === null || !(await isLocked($, place, held)) ? undefined : { id: 'lothlorien:mirror', text: sectionText(held) }
}

/** Galadriel, where the record lost her (sent where her spawn answered no id), found by the vision she gazes on. */
export async function galadrielFound($: $, agentId: string): Promise<MiddleEarthAgent | undefined> {
  const found = await gazingFor($, agentId)

  return found === undefined ? undefined : { role: 'galadriel', root: await rootOf($), tree: found.place.tree }
}

export function registerLothlorien(on: On): void {

  on('tool.call', { tool: 'mcp__middle-earth__gaze' }, async ($, e) => {
    const given = e as unknown as { purpose?: unknown; weight?: unknown }

    return { result: await gaze($, String(given.purpose ?? ''), 'tool', await placeOf($, e.agentId), '', given.weight === 'light' || given.weight === 'standard' ? given.weight : 'heavy') }
  })

  on('tool.call', { tool: 'mcp__middle-earth__mirror' }, async ($, e) => {
    const place = await placeOf($, e.agentId)
    const held = await visionIn($, place)

    return { result: held === null ? HOW_TO : visionText(held, await isLocked($, place, held), await tampered($, place, held)) }
  })

  on('tool.call', { tool: 'mcp__middle-earth__amend' }, async ($, e) => {
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
    const others = await read($, visions)
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
