import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { TestsFirstState, TestsFirst, MiddleEarthAgent } from '../../types'
import { blocksOf, forgottenOf, testsFirstPrompt, isTestPath, lockedIn, missingFrom, parseGaze, released, shownOf, takenBy, tamperedWith, visionText } from '../../core/tests-first'
import type { Shown } from '../../core/tests-first'
import { badge } from '../kit/badge'
import type { Tone } from '../kit/badge'
import { paneView } from '../kit/pane-text'
import { clockOf, shortRef } from '../look'
import { errorText, rootOf, toolFailed } from '../flow'
import type { Section, TurnEnded } from '../flow'
import { isTree, treeOf } from '../kit/trees'
import { TEST_WRITER, TEST_WRITER_LIGHT, agentOf, remember, spawnIn, treesOf, typeOf } from '../agents'

type $ = EngineInterface
type On = Parameters<Register>[0]

const PANE = 'tests-first'
const TITLE = 'Tests first'

export const HOW_TO = 'No tests are written first yet. /tests <the behaviour to come> has the test writer write the failing tests that show it, before it is built.'
const AGENT_TYPE = typeOf(TEST_WRITER)
const SWIFT_TYPE = typeOf(TEST_WRITER_LIGHT)

const vision = atom({ plugin: 'middle-earth', key: 'testsFirst' } as const, null as TestsFirst | null)
const visions = atom({ plugin: 'middle-earth', key: 'testsFirstByTree' } as const, {} as Record<string, TestsFirst>)
const note = atom({ plugin: 'middle-earth', key: 'testsFirstNote' } as const, '')

export const testsFirstView = paneView({ id: PANE, title: TITLE, command: '/tests' })
const view = testsFirstView

const TOOLS = [
  {
    name: 'write_tests',
    description:
      "Writes tests first: a test-writing subagent writes the tests that will prove a behaviour before it is built, runs them to show they fail, and they stay locked against edits until committed. It runs in the background: this answers at once, and mcp__middle-earth__tests_first says what it wrote. Call it before building a behaviour test-first, with what is to be built and how to tell it is done.",
    inputSchema: {
      type: 'object',
      properties: {
        purpose: { type: 'string', description: 'What is to come: the behaviour, the task, how to tell it is done.' },
        weight: { type: 'string', enum: ['light', 'standard', 'heavy'], description: 'How much the task asks: it writes on a lighter model for one that is not heavy. Heavy when left out.' },
      },
      required: ['purpose'],
    },
  },
  {
    name: 'tests_first',
    description: 'The tests written first: each test, how it failed, whether it is still locked, and each change made to it and why.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'amend_test',
    description:
      "Unlocks a locked test file (tests written first) for a change, with the reason: a test that asserts something the purpose does not ask, or that cannot pass as written. With `test`, it unlocks nothing: it says that test cannot run here (it needs root, another system, or is ignored unless asked), and the proof no longer asks it to pass. The reason is kept and shown to the reviewers. Never call it to make a test easier to pass.",
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'The test file, from the project folder.' },
        why: { type: 'string', description: 'What is wrong with the test as it was written, or what it needs that is not here, in a sentence or two.' },
        test: { type: 'string', description: 'A test of hers, as its runner names it, that cannot run here: it stays as written, and is owed no passing.' },
      },
      required: ['file', 'why'],
    },
  },
] as const

const STATE_TONE: Record<TestsFirstState, Tone> = { gazing: 'info', shown: 'success', empty: 'neutral', clouded: 'danger' }

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

async function visionIn($: $, place: Place): Promise<TestsFirst | null> {
  return (place.isHome ? read($, vision) : ((await read($, visions))[place.tree] ?? null))
}

async function setVision($: $, place: Place, change: (was: TestsFirst | null) => TestsFirst | null): Promise<void> {
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
async function allTestsFirst($: $): Promise<{ place: Place; held: TestsFirst }[]> {
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

/** Whether the tests written first are still locked: shown, and not committed yet, HEAD where it was when they were written. */
async function isLocked($: $, place: Place, held: TestsFirst | null): Promise<boolean> {
  return held !== null && held.state === 'shown' && (await git($, place, ['rev-parse', 'HEAD'])).out === held.head
}

/** Sends the test writer to gaze, in the place asked. Answers what was done, in a sentence. */
async function gaze($: $, purpose: string, by: TestsFirst['by'], place: Place, ref = '', weight = 'heavy'): Promise<string> {
  if (purpose.trim() === '') return 'Say what is to come: the behaviour, and how to tell it is done.'

  const held = await visionIn($, place)

  if (held?.state === 'gazing') return 'The test writer is at work already: wait for the tests it writes.'

  const head = (await git($, place, ['rev-parse', 'HEAD'])).out
  // In a quest's worktree it writes its tests there
  const started = await spawnIn($, { subagentType: weight === 'heavy' ? AGENT_TYPE : SWIFT_TYPE, description: 'The test writer writes the tests first', prompt: testsFirstPrompt(purpose), ...(place.isHome ? {} : { cwd: place.tree }) })
    .catch((error: unknown) => ({ deny: errorText(error), agentId: undefined }))

  if (started.deny !== undefined) return `The test writer could not be sent: ${started.deny}`
  if (started.agentId !== undefined && started.agentId !== '') await remember($, started.agentId, { role: 'test-writer', root: await rootOf($), tree: place.tree, ...(ref !== '' ? { ref } : {}) })

  await setVision($, place, (): TestsFirst => ({ purpose: purpose.trim(), ...(ref !== '' ? { ref } : {}), by, agentId: started.agentId ?? '', state: 'gazing', head, tests: [], red: '', why: '', blocks: [], amendments: [], at: Date.now(), ...(place.isHome ? {} : { tree: place.tree }) }))
  await update($, note, () => '')

  return 'The test writer writes the tests of what is to come and shows them red. mcp__middle-earth__tests_first says what it showed.'
}

/** Has the test writer write a quest's task's tests first, in its worktree. Answers what was done, in a sentence. */
export async function writeTestsFor($: $, purpose: string, ref: string, weight: string, tree: string): Promise<string> {
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

/** Its turn has ended: what it showed is read and locked, and a person who asked through /mirror has their Claude told. */
async function behold($: $, place: Place, held: TestsFirst, answer: string, ended: string): Promise<void> {
  const said = ended === 'answer' ? parseGaze(answer) : undefined
  const blocks = await writtenBy($, place)
  const clouded = (why: string): TestsFirst => ({ ...held, state: 'clouded', why, blocks: [] })
  const made: TestsFirst =
    said === undefined
      ? clouded(ended === 'answer' ? 'it gave no answer that reads' : ended === 'aborted' ? 'it was interrupted' : ended === 'refusal' ? 'it refused' : 'an API error ended its turn')
      : said.tests.length === 0 && said.unrun.length === 0
        ? said.untestable !== ''
          ? { ...held, state: 'empty', why: said.untestable }
          : clouded('it named no test, and no reason there is none')
        : blocks.length === 0
          ? clouded('it named tests, but no test file holds anything new')
          : said.tests.length > 0 && said.red === ''
            ? clouded('it did not show its tests red')
            : { ...held, state: 'shown', tests: said.tests, unrun: said.unrun, red: said.red, blocks }

  await setVision($, place, () => made)
  $.ui.toast(`Tests first: ${made.state === 'shown' ? `${made.tests.length} red ${made.tests.length === 1 ? 'test' : 'tests'} show what is to come${(made.unrun ?? []).length > 0 ? `, ${(made.unrun ?? []).length} more cannot run here` : ''}` : made.state === 'empty' ? 'nothing to test' : `the tests could not be read: ${made.why}`}`)

  if (made.by === 'command') await $.prompt.submit({ text: visionText(made, await isLocked($, place, made)) }).catch(() => undefined)
}

/** Whether an agent is the test writer gazing on a vision: by the id its spawn answered, else, where it answered none, by its type. */
async function isTestWriter($: $, held: TestsFirst | null, agentId: string): Promise<boolean> {
  if (held === null || held.state !== 'gazing') return false

  return held.agentId !== '' ? agentId === held.agentId : (await $.agent.list().catch(() => [])).some(one => one.id === agentId && (one.type === AGENT_TYPE || one.type === SWIFT_TYPE) && one.status === 'running')
}

/** The vision the test writer gazes on, wherever it writes; nothing when the agent is not her. */
async function gazingFor($: $, agentId: string): Promise<{ place: Place; held: TestsFirst } | undefined> {
  for (const one of await allTestsFirst($)) if (await isTestWriter($, one.held, agentId)) return one

  return undefined
}

/** Who is changing the tests written first, for the record: the agent's type, else the session itself. */
async function whoIs($: $, agentId: string | undefined): Promise<string> {
  if (agentId === undefined) return 'the session'

  const agent = (await $.agent.list().catch(() => [])).find(one => one.id === agentId)

  return agent?.type ?? agentId
}

/** What was taken out of her locked tests with no reason given, while they are locked: an edit the lock did not see. */
async function tampered($: $, place: Place, held: TestsFirst | null): Promise<{ file: string; lines: string[] }[]> {
  if (held === null || !(await isLocked($, place, held))) return []

  const files = []

  for (const file of [...new Set(held.blocks.map(block => block.file))]) files.push({ file, text: String(await $.fs.read(`${place.tree}/${file}`).catch(() => '')) })

  return tamperedWith(held.blocks, held.amendments, files)
}

/** What the tests written first shows of a quest's worktree, for the Fellowship, which waits on her and reads what was changed of the tests written first. */
export async function testsFirstIn($: $, tree: string): Promise<Shown> {
  const place = await placeOf($, undefined, tree)
  const held = await visionIn($, place)

  return shownOf(held, await isLocked($, place, held), await tampered($, place, held))
}

/**
 * Forgets the tests written first of an issue once they are committed, for the cleanup: each vision gazed for it, or the
 * project's own when none is named. Tests still locked are kept.
 */
export async function forgetTestsFirst($: $, ref: string): Promise<{ forgotten: boolean; text: string }> {
  const held = await allTestsFirst($)
  const named = forgottenOf(held, ref)

  if (named.length === 0) return { forgotten: false, text: held.length === 0 ? 'No tests written first are held.' : `No tests written first are held for ${ref}: what is held is kept.` }

  for (const { place, held: one } of named) if (one.state === 'gazing' || (await isLocked($, place, one))) return { forgotten: false, text: 'The tests written first are not committed yet: they are kept.' }
  for (const { place } of named) await setVision($, place, () => null)

  return { forgotten: true, text: 'No tests written first are held.' }
}

/** Unlocks a file of hers for a change, keeping why; or, given a test, says it cannot run here and owes it no passing. */
async function amend($: $, place: Place, file: string, why: string, by: string, test = ''): Promise<string> {
  const held = await visionIn($, place)
  const path = within(place, file)

  if (!(await isLocked($, place, held)) || held === null) return 'No test written first is locked: change what you need.'
  if (lockedIn(held.blocks, path).length === 0) return `${path} holds none of the tests written first: it is not locked.`
  if (why.trim().length < 12) return `Say ${test !== '' ? 'what the test needs that is not here' : 'why the test is wrong'}, in a sentence: the reason goes to whoever judges the change.`

  if (test !== '') {
    const made = released(held, test, why, by)

    if (typeof made === 'string') return made

    await setVision($, place, was => (was === null ? was : { ...was, tests: made.tests, unrun: made.unrun ?? [] }))

    return `${test} cannot run here: it stays locked as written, and the proof no longer asks it to pass. The reason is kept and shown to whoever judges the change.`
  }

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
    : `That change takes out ${gone.length === 1 ? 'a line' : `${gone.length} lines`} of the tests written first in ${file} (${gone.slice(0, 2).map(line => `\`${line.trim()}\``).join(', ')}). They are locked: make them pass as they are. If one is wrong, call mcp__middle-earth__amend_test with the file and why, then change it.`
}

const sectionText = (held: TestsFirst): string =>
  `The tests written first of what is to come are held here, red and locked until they are committed: ${held.tests.map(test => `${test.file} ${test.name}`).join(', ')}. Make them pass without changing them; a test that is wrong is changed only after mcp__middle-earth__amend_test says why, and one that cannot run here is named to it with its test.`

/** tests first at the session's start: its command and its tools. */
export async function startTestsFirst($: $): Promise<void> {
  await $.command.register({ name: 'tests', description: 'The test writer writes the failing tests of what is to come: /tests <the behaviour>; /tests alone shows the tests written first' })

  // A host that registers no tools still starts the session
  for (const tool of TOOLS) await $.tool.register(tool).catch(() => undefined)
}

/** A turn has ended: hers is what the tests written first shows. */
export async function endedTestsFirst($: $, e: TurnEnded): Promise<void> {
  const found = e.agentId === undefined ? undefined : await gazingFor($, e.agentId)

  if (found !== undefined) await behold($, found.place, found.held, e.answer ?? '', e.isAborted ? 'aborted' : e.reason)
}

/**
 * Why a call may not change a file: whoever is not her leaves her locked tests as they are, unless they say why. What
 * the test writer itself may write is the guard's. Empty when the call takes nothing of them out.
 */
export async function lockRefusal($: $, e: unknown): Promise<string> {
  const given = e as { tool?: unknown; agentId?: string; file_path?: unknown; old_string?: unknown; new_string?: unknown; content?: unknown }

  if (agentOf(given.agentId)?.role === 'test-writer' || typeof given.file_path !== 'string') return ''
  if (given.tool === 'Edit' && typeof given.old_string === 'string' && typeof given.new_string === 'string') return refusal($, given.file_path, locked => takenBy(locked, String(given.old_string), String(given.new_string)))
  if (given.tool === 'Write' && typeof given.content === 'string') return refusal($, given.file_path, locked => missingFrom(locked, String(given.content)))

  return ''
}

/** What Claude is told of the tests written first while they are locked: those of the project's own folder, which it works in. */
export async function sectionOfTestsFirst($: $): Promise<Section | undefined> {
  const place = { tree: await rootOf($), isHome: true }
  const held = await visionIn($, place)

  return held === null || !(await isLocked($, place, held)) ? undefined : { id: 'tests-first:locked', text: sectionText(held) }
}

/** The test writer, where the record lost her (sent where its spawn answered no id), found by the vision it writes on. */
export async function testWriterFound($: $, agentId: string): Promise<MiddleEarthAgent | undefined> {
  const found = await gazingFor($, agentId)

  return found === undefined ? undefined : { role: 'test-writer', root: await rootOf($), tree: found.place.tree }
}

export function registerTestsFirst(on: On): void {

  on('tool.call', { tool: 'mcp__middle-earth__write_tests' }, async ($, e) => {
    const given = e as unknown as { purpose?: unknown; weight?: unknown }

    return { result: await gaze($, String(given.purpose ?? ''), 'tool', await placeOf($, e.agentId), '', given.weight === 'light' || given.weight === 'standard' ? given.weight : 'heavy') }
  }).catch((_$, _e, next) => toolFailed('write_tests', next.error))

  on('tool.call', { tool: 'mcp__middle-earth__tests_first' }, async ($, e) => {
    const place = await placeOf($, e.agentId)
    const held = await visionIn($, place)

    return { result: held === null ? HOW_TO : visionText(held, await isLocked($, place, held), await tampered($, place, held)) }
  }).catch((_$, _e, next) => toolFailed('tests_first', next.error))

  on('tool.call', { tool: 'mcp__middle-earth__amend_test' }, async ($, e) => {
    const given = e as unknown as { file?: unknown; why?: unknown; test?: unknown }
    const file = String(given.file ?? '')
    // A builder in a quest's worktree amends the tests there, whichever way it names the file
    const sent = await placeOf($, e.agentId)
    const place = sent.isHome && file.startsWith('/') ? await placeOfPath($, file) : sent

    return { result: await amend($, place, file, String(given.why ?? ''), await whoIs($, e.agentId), String(given.test ?? '').trim()) }
  }).catch((_$, _e, next) => toolFailed('amend_test', next.error))

  on('command.run', { command: 'tests' }, async ($, e) => {
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
    const shown = (await allTestsFirst($)).sort((one, other) => (one.place.isHome ? -1 : other.place.isHome ? 1 : other.held.at - one.held.at))[0]
    const problem = await read($, note)

    if (shown === undefined) {
      return view.keep(
        <Box flexDirection="column" gap={1}>
          {badge({ label: 'still', tone: 'neutral' })}
          <Text dimColor>{HOW_TO}</Text>
        </Box>,
        e.props.bodyColumns,
      )
    }

    const { place, held } = shown
    const locked = await isLocked($, place, held)
    const others = await read($, visions)
    const elsewhere = Object.keys(others).filter(tree => tree !== place.tree).length
    // Its tests by the file they are in: a path is long, and said once above the names it holds
    const files = [...new Set(held.tests.map(test => test.file))]

    return view.keep(
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
            {badge({ label: held.state, tone: STATE_TONE[held.state] })}
            {held.state === 'shown' && badge({ label: locked ? 'locked' : 'committed', tone: locked ? 'warning' : 'success' })}
            {held.tests.length > 0 && <Text color="error">{`${held.tests.length} red ${held.tests.length === 1 ? 'test' : 'tests'}`}</Text>}
            <Text dimColor>{clockOf(held.at)}</Text>
          </Box>
          {!place.isHome && <Text dimColor>{`In the quest's worktree ${place.tree.split('/').slice(-1)[0] ?? ''}${held.ref !== undefined ? `, for ${shortRef(held.ref)}` : ''}`}</Text>}
          {elsewhere > 0 && <Text dimColor>{`${elsewhere} more ${elsewhere === 1 ? 'vision' : 'visions'} in other quests' worktrees`}</Text>}
        </Box>
        {problem !== '' && <Text color="warning">{problem}</Text>}
        <Text>{held.purpose.split('\n')[0] ?? ''}</Text>
        {held.why !== '' && <Text color={held.state === 'clouded' ? 'error' : undefined}>{held.why}</Text>}
        {held.tests.length > 0 && (
          <Box flexDirection="column" borderStyle="round" paddingX={1}>
            {files.map(file => (
              <Box key={`file-${file}`} flexDirection="column">
                <Text dimColor wrap="truncate-start">{file}</Text>
                {held.tests
                  .filter(test => test.file === file)
                  .map(test => (
                    <Text key={`${test.file}:${test.name}`} color="error">{`  ✗ ${test.name}`}</Text>
                  ))}
              </Box>
            ))}
          </Box>
        )}
        {(held.unrun ?? []).length > 0 && (
          <Box flexDirection="column">
            <Text color="warning">Written, but they cannot run here: owed no passing</Text>
            {(held.unrun ?? []).map(test => (
              <Text key={`unrun-${test.file}:${test.name}`} dimColor>{`  ○ ${test.name}: ${test.why}`}</Text>
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
      e.props.bodyColumns,
    )
  })
}
