import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ArgonathJudgement, ArgonathRadius, ArgonathSeat, ArgonathState, ArgonathTarget } from '../../types'
import { badge } from '../kit/badge'
import type { Tone } from '../kit/badge'
import { paneView } from '../kit/pane-text'
import { dealt, judgementShape, judgementText, parseFindings, seated, statuePrompt, verdictOf, verdictPrompt } from './statues'
import { table } from '../kit/table'
import type { TableCell } from '../kit/table'
import { treeOf } from '../kit/trees'
import { errorText, rootOf, toolFailed } from '../flow'
import type { Section, Target, TurnEnded } from '../flow'
import { askToPump, inFrame, remember, roleOf, spawnIn, treesOf, typeOf } from '../agents'
import type { Changed, Review } from './proof'
import {
  CHANGE_SCRIPT,
  HOME,
  HOW_TO,
  MARK,
  PROJECT_FILE,
  isNarrowable,
  isProd,
  isQuiet,
  isTested,
  markedTests,
  marksOf,
  narrowed,
  owed,
  parseDiffText,
  parseLiveAnswer,
  parseProject,
  parseProof,
  parseReviews,
  parseServiceAnswer,
  parseStandards,
  proved,
  radiusLine,
  radiusOf,
  radiusText,
  targetsOf,
  tidy,
  UNTRACKED,
  changesByTarget,
  STANDING_SCRIPT,
  standingByTarget,
  proofAnswer,
  proofBrief,
  affectedOf,
  requiredOf,
  withLive,
} from './proof'

type $ = EngineInterface
type On = Parameters<Register>[0]

const PANE = 'argonath'
const TITLE = 'Argonath'
// The mod whose diff plays a CLI's kept runs on two builds: a CLI's radius is read from what it says
const ANDURIL = 'anduril'
// A look builds and plays on two sides, and a proof runs the tests on each: as long as a host command may run
const RUN_TIMEOUT_MS = 600_000
// How many test files are read for marks
const READ_FILES = 300
// How often the session is asked whether a look is owed: once a turn has ended with an edit, it runs on the next
const OWED_MS = 2_000

const targets = atom({ plugin: 'middle-earth', key: 'argonathTargets' } as const, [] as ArgonathTarget[])
const radii = atom({ plugin: 'middle-earth', key: 'argonathRadii' } as const, [] as ArgonathRadius[])
const touched = atom({ plugin: 'middle-earth', key: 'argonathTouched' } as const, [] as string[])
const working = atom({ plugin: 'middle-earth', key: 'argonathWorking' } as const, '')
const note = atom({ plugin: 'middle-earth', key: 'argonathNote' } as const, '')
const selected = atom({ plugin: 'middle-earth', key: 'argonathSelected' } as const, '')
const isHidden = atom({ plugin: 'middle-earth', key: 'argonathIsHidden' } as const, false)
const glow = atom({ plugin: 'middle-earth', key: 'argonathGlow' } as const, 0)
const home = atom({ plugin: 'middle-earth', key: 'argonathHome' } as const, '')
const reviewed = atom({ plugin: 'middle-earth', key: 'argonathReviewed' } as const, '')
const judgement = atom({ plugin: 'middle-earth', key: 'argonathJudgement' } as const, null as ArgonathJudgement | null)
const treeJudgements = atom({ plugin: 'middle-earth', key: 'argonathTreeJudgements' } as const, {} as Record<string, ArgonathJudgement>)

/**
 * The project's folder as every part reads it, the main checkout's top, taken once: a `cd` Claude runs later does not
 * move the project from under the mod.
 */
async function homeOf($: $): Promise<string> {
  const held = await read($, home)

  if (held !== '') return held

  const cwd = tidy(await rootOf($))

  await update($, home, () => cwd)

  return cwd
}

/**
 * Where a look, a proof or a judgement is made: the project's own folder, whose radius the pane and the band show, or
 * a quest's worktree, whose answers go to the one who asked alone.
 */
type Place = { tree: string; isHome: boolean }

/** The place a call is about: a quest's worktree a part names or the calling agent was sent to work in, else the project's. */
async function placeOf($: $, agentId?: string, named?: unknown): Promise<Place> {
  const cwd = await homeOf($)
  const tree = treeOf(cwd, treesOf(), agentId, named)

  return { tree, isHome: tree === cwd }
}

/** The project's folder, as a place. */
async function homePlace($: $): Promise<Place> {
  return ({ tree: await homeOf($), isHome: true })
}

// The last radius of each target in a quest's worktree, by its folder: the pane shows only the project's own
const treeRadii = new Map<string, ArgonathRadius[]>()

async function radiiIn($: $, place: Place): Promise<ArgonathRadius[]> {
  return (place.isHome ? read($, radii) : (treeRadii.get(place.tree) ?? []))
}

/** The statues' judgement of the change in a place; null before any. */
async function judgementIn($: $, place: Place): Promise<ArgonathJudgement | null> {
  return (place.isHome ? read($, judgement) : ((await read($, treeJudgements))[place.tree] ?? null))
}

async function setJudgement($: $, place: Place, made: ArgonathJudgement): Promise<void> {
  if (place.isHome) await update($, judgement, () => made)
  else await update($, treeJudgements, was => ({ ...was, [place.tree]: made }))
}

/** Every judgement held, with its place: a statue's turn is found in whichever it sits in. */
async function allJudgements($: $): Promise<{ place: Place; held: ArgonathJudgement }[]> {
  const own = await read($, judgement)

  return [
    ...(own === null ? [] : [{ place: await homePlace($), held: own }]),
    ...Object.entries(await read($, treeJudgements)).map(([tree, held]) => ({ place: { tree, isHome: false }, held })),
  ]
}

// What the pane last drew, for the model to read
export const argonathView = paneView({ id: PANE, title: TITLE, command: '/argonath' })
const view = argonathView

// An agent sent to work in a quest's worktree is looked at there
const ASKED = {
  target: { type: 'string', description: 'One target by its name; every target the project names when left out.' },
  against: { type: 'string', description: 'The commit the working tree is compared with, by any name git resolves (a tag, a branch). HEAD when left out.' },
} as const

const TOOLS = [
  {
    name: 'radius',
    description:
      "Which kept runs (CLI) or requests (service) answer otherwise on the working tree than on HEAD: each `bare` (no test marked on it) or `marked` (a test has `sting: <the run>` above it). Call it after changing a target's source; write a test for each bare run and for no other. Also names changed lines no kept request ran.",
    inputSchema: { type: 'object', properties: ASKED },
  },
  {
    name: 'prove',
    description:
      "The radius afresh, then the tests marked on changed runs on HEAD's source (your tests laid over it) and on the working tree: `pinned` fails then passes, `loose` passes on both, `broken` fails on yours. Also runs, for a target the change reached, the tests it can break, and names what the change broke. Settled when every changed run is pinned and nothing is broken. Argonath does this itself when a turn that edited a target ends.",
    inputSchema: { type: 'object', properties: ASKED },
  },
  {
    name: 'judgement',
    description:
      "The reviewers' verdict on the settled change: `pass`, `fail` (a blocking finding), `sitting`, `silent` (one could not judge) or `stale` (the change moved since). `convene` sends them on the change as it stands, if not judged yet, and answers at once.",
    inputSchema: {
      type: 'object',
      properties: {
        convene: { type: 'boolean', description: 'Send the reviewers (the statues, Isildur and Anárion) on the change as it stands, when every changed run is pinned and they have not reviewed it yet.' },
        about: { type: 'string', description: 'With convene: what the change is meant to do (the task, its acceptance), which the statues judge it against.' },
        statues: { type: 'array', items: { type: 'string', enum: ['isildur', 'anarion'] }, description: 'With convene: only these reviewers are sent, each with its share of the reviews (Isildur correctness, Anárion security); both when left out.' },
        against: { type: 'string', description: 'With convene: judge the change since where HEAD left this branch or commit (its merge base), committed or not, such as a whole branch before its pull request. HEAD when left out.' },
        model: { type: 'string', description: "With convene: the model the statues judge with, an alias (`sonnet`) or a full id, for a lighter change; their own (Opus) when left out." },
      },
    },
  },
] as const

// The targets the project names, as the system prompt's section reads them: a module's own copy, set again at each load
let known: readonly ArgonathTarget[] = []
// The reviews the project names, run once a change is settled
let reviews: readonly Review[] = []
// The files of standards the statues judge by, from the project's folder
let standards: readonly string[] = []

const sectionText = (list: readonly ArgonathTarget[], cwd: string): string => {
  const within = (path: string) => (path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path)

  return [
    `Argonath checks changes to ${list.map(({ label, kind, roots }) => `\`${label}\` (${kind}, ${roots.map(within).join(', ')})`).join(', ')}.`,
    `After changing one, call mcp__middle-earth__radius: for each bare run it lists, write one integration test that makes that run and asserts its new answer, \`${MARK} <the run as listed>\` on the line above it; none for a run that did not change.`,
    'Then mcp__middle-earth__prove: the change is settled when every changed run is pinned and nothing is broken.',
    ...(reviews.length > 0 ? [`Then reviewers judge it when the turn ends (${dealt(reviews).map(seat => seat.reviews.join(', ')).join(', ')}); fix what they find blocking.`] : []),
  ].join(' ')
}

async function setUp($: $): Promise<ArgonathTarget[]> {
  const cwd = await homeOf($)
  const text = await $.fs.read(`${cwd}/${PROJECT_FILE}`).catch(() => '')
  const list = parseProject(text, cwd)

  known = list
  reviews = parseReviews(text)
  standards = parseStandards(text)
  await update($, targets, () => list)

  return list
}

/**
 * The targets of a place, their folders in that place. The project's own are read afresh, or, `isKnown`, as last read.
 * A quest's worktree is looked at as the project's folder names its targets: what a target runs on the machine unasked
 * (its tests, its database, its live stage) is never read from a branch. The requests it plays are the project's own,
 * then those its own file keeps besides: a request the branch takes out is played still, as the change it proves
 * cannot shrink what proves it.
 */
async function targetsIn($: $, place: Place, isKnown = false): Promise<ArgonathTarget[]> {
  if (place.isHome) return isKnown ? read($, targets) : setUp($)

  const own = parseProject(await $.fs.read(`${place.tree}/${PROJECT_FILE}`).catch(() => ''), place.tree)

  return parseProject(await $.fs.read(`${await homeOf($)}/${PROJECT_FILE}`).catch(() => ''), place.tree).map(target => ({
    ...target,
    requests: [...target.requests, ...(own.find(one => one.label === target.label)?.requests ?? []).filter(line => !target.requests.includes(line))],
  }))
}

/** Every mark in the files a target names as tests: what git tracks there, and what it neither tracks nor ignores. */
async function marksIn($: $, cwd: string, target: ArgonathTarget): Promise<{ line: string; test: string }[]> {
  if (target.tests.length === 0) return []

  const listed = await $.process.run(['git', 'ls-files', '-co', '--exclude-standard', '--', ...target.tests], { cwd }).catch(() => undefined)
  const paths = (listed?.exitCode === 0 ? listed.stdout.split('\n') : []).map(path => path.trim()).filter(path => path !== '')
  const marks: { line: string; test: string }[] = []

  for (const path of paths.slice(0, READ_FILES)) marks.push(...marksOf(await $.fs.read(`${cwd}/${path}`).catch(() => '')))

  return marks
}

// What a handler found, and for a service with a live stage, what that stage found in a line
type Found = Changed & { live?: string }

/**
 * A CLI's handler: anduril plays its kept runs on both builds, and says what changed. Andúril is a plugin of its own,
 * useful alone, and this is the one call that crosses to it: through MCP, as a tool call would be put to the session's
 * permission check, which a proof no one is at the prompt for cannot answer.
 */
async function cliChanged($: $, target: ArgonathTarget, against: string, place: Place): Promise<Changed | string> {
  try {
    const answered = await $.mcp.call(ANDURIL, 'diff', { target: target.label, from: against, to: 'work', ...(place.isHome ? {} : { tree: place.tree }) })
    const said = answered.content.map(block => ('text' in block && typeof block.text === 'string' ? block.text : '')).join('\n')

    // What anduril says in place of a comparison is why there is no radius
    return parseDiffText(said) ?? (said !== '' ? said : 'anduril answered nothing to read.')
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error)

    // A session can run without Andúril loaded, though it is enabled (#48): no builder mends that, a restart does
    if (/no connected MCP tool/.test(why)) return 'Andúril is not loaded in this session (no tool of its is connected): restart Claude Code, and prove again.'

    return `A CLI's radius is read from anduril's diff, which could not be called: ${why}`
  }
}

/**
 * A service's handler: its kept requests are played in-process on both builds, standing alone; then, where the
 * project says where it is deployed and it is running, on both builds again against its real dependencies.
 */
async function serviceChanged($: $, target: ArgonathTarget, against: string, place: Place): Promise<Found | string> {
  if (target.app === '') return `${target.label} names no app: say it as service:module:app, gondor=service:gondor.app:app@beacons/gondor.`
  if (target.requests.length === 0) return `No request of ${target.label} is kept to play. Keep one with a line in ${PROJECT_FILE}: $ ${target.label} GET /health`

  // A quest's worktree plays against the project's warm database, which the project's folder names
  const job = { home: place.tree, ...(place.isHome ? {} : { project: await homeOf($) }), label: target.label, app: target.app, python: target.python, env: target.env, masks: target.masks, requests: target.requests, from: against, roots: target.roots, db: target.db, ready: target.ready }
  const ran = await $.process.run(['python3', `${tidy($.plugin.root)}/handlers/service.py`], { stdin: JSON.stringify(job), timeoutMs: RUN_TIMEOUT_MS })
  const fast = parseServiceAnswer(ran.stdout) ?? `The requests could not be played: ${ran.stderr.trim().split('\n').slice(-3).join(' ') || `the service handler exited with ${ran.exitCode} and said nothing`}`

  if (typeof fast === 'string' || target.live === null) return fast

  // A context that names prod is never touched: the handler, which refuses it too, is not even started
  if (isProd(target.live.workload)) return { ...fast, live: `Live: not played, the context of ${target.live.workload} names prod, and Argonath reads nothing from it and runs nothing in it` }

  await update($, working, () => `Playing what ${target.label} keeps on both builds against its real dependencies, on ${target.live?.workload ?? ''}…`)

  const live = await $.process
    .run(['python3', `${tidy($.plugin.root)}/handlers/live.py`], { stdin: JSON.stringify({ ...job, live: target.live }), timeoutMs: RUN_TIMEOUT_MS })
    .then(done => parseLiveAnswer(done.stdout) ?? { where: target.live?.workload ?? '', skipped: '', error: done.stderr.trim().split('\n').slice(-2).join(' ') || `the live handler exited with ${done.exitCode}`, cases: [] })
    .catch((error: unknown) => ({ where: target.live?.workload ?? '', skipped: '', error: error instanceof Error ? error.message : String(error), cases: [] }))
  const merged = withLive(fast, live)

  return { ...merged.changed, live: merged.line }
}

/** What changed in what one target does, by the handler of its kind. */
function changedIn($: $, target: ArgonathTarget, against: string, place: Place): Promise<Found | string> {
  return target.kind === 'cli'
    ? cliChanged($, target, against, place)
    : target.kind === 'service'
      ? serviceChanged($, target, against, place)
      : Promise.resolve(`${target.label} is a frontend: Argonath has no handler for a frontend yet, so what changed in it is not known.`)
}

/** Runs a target's tests on both sides, and says where each changed run, and each test required, stands. */
async function proveIn($: $, target: ArgonathTarget, made: ArgonathRadius, against: string, required: readonly string[], place: Place): Promise<ArgonathRadius | string> {
  // Only the tests marked on the runs that changed, and those required, are run, where the command says how to name them
  const job = { home: place.tree, label: target.label, tests: target.tests, test: narrowed(target.test, [...new Set([...markedTests(made), ...required])]), from: against }
  const ran = await $.process.run(['python3', `${tidy($.plugin.root)}/handlers/prove.py`], { stdin: JSON.stringify(job), timeoutMs: RUN_TIMEOUT_MS })
  const proof = parseProof(ran.stdout)

  return proof === undefined ? `The proof of ${target.label} could not be made: ${ran.stderr.trim().split('\n').slice(-3).join(' ') || `the prove script exited with ${ran.exitCode}`}` : proved(made, proof, required)
}

/** Runs the tests a change of the target can break, and tells what the change broke from what was broken before. */
async function affectedIn($: $, target: ArgonathTarget, against: string, place: Place): Promise<ReturnType<typeof affectedOf>> {
  const job = { home: place.tree, label: target.label, tests: target.tests, command: target.affected, from: against }
  const ran = await $.process.run(['python3', `${tidy($.plugin.root)}/handlers/affected.py`], { stdin: JSON.stringify(job), timeoutMs: RUN_TIMEOUT_MS }).catch(() => undefined)

  return affectedOf(ran?.stdout ?? '')
}

// `isOwing`: the proof is the session's own, so a settled change is owed the statues when its turn ends; a subagent's is not, as its work may not be done
// `required`: tests written before the change (Galadriel's), each `{ file, name }`, that are to pass on the working tree
// `place`: the project's folder when left out
type Asked = { target?: string; against: string; isProving: boolean; isOwing?: boolean; required?: readonly { file: string; name: string }[]; place?: Place }

/** What a look found of one target: its radius, or why it has none; no target where the look found none to look at. */
type Looked = { target?: ArgonathTarget; found: ArgonathRadius | string }

// The last proof made in each place, by the change it was made on and what was asked: the same proof asked again is
// answered from it
const lastProofs = new Map<string, { key: string; looked: Looked[] }>()

/** Looks again at the targets asked for: what changed in each, and, when asked, whether its tests see it. Answers what was found, a radius or a sentence a target. */
async function look($: $, asked: Asked, only?: readonly string[]): Promise<Looked[]> {
  const place = asked.place ?? (await homePlace($))
  const cwd = place.tree
  // A quest's worktree is the quest's own: its proof owes the session's turn no review, and the pane does not show it
  const isOwing = place.isHome && asked.isOwing !== false
  const list = await targetsIn($, place)

  if (list.length === 0) return [{ found: HOW_TO }]
  if (asked.target !== undefined && !list.some(({ label }) => label === asked.target)) return [{ found: `Argonath knows no target named ${asked.target}. It knows ${list.map(({ label }) => label).join(', ')}.` }]

  const chosen = list.filter(({ label }) => (asked.target === undefined || label === asked.target) && (only === undefined || only.includes(label)))
  const wanted = (asked.required ?? []).map(({ file, name }) => `${file}:${name}`).sort().join(',')
  // A proof takes minutes: one asked again of the same change, as a member's last and its mod's next are, is not made twice
  const fingerprint = asked.isProving ? await wholeFingerprint($, 'HEAD', place) : ''
  // A change git could not read is proved afresh each time: its proof is no other change's
  const key = asked.isProving && !fingerprint.startsWith(UNREADABLE) ? `${fingerprint}|${asked.against}|${chosen.map(({ label }) => label).join(',')}|${wanted}` : ''
  const last = lastProofs.get(cwd)

  if (key !== '' && last?.key === key) {
    if (isOwing) await owe($)

    return last.looked
  }

  const found: Looked[] = []
  // The checkouts a handler or a proof makes are no part of the repo: the folder says so itself, before any is made
  const ignore = `${cwd}/${HOME}/.gitignore`
  if (!(await $.fs.exists(ignore).catch(() => false))) await $.fs.write(ignore, '*\n').catch(() => undefined)

  // What each target's folders hold against HEAD, read once: a target the change did not reach is not played at all
  const changes = asked.against === 'HEAD' ? await changesOf($, place, list) : new Map<string, string>()

  try {
    for (const target of chosen) {
      const required = requiredOf(target, cwd, asked.required ?? [])
      const isUntouched = changes.has(target.label) && changes.get(target.label) === ''
      let changed: Found | string

      if (isUntouched) changed = { summary: `${target.label}: the change does not reach its folders`, changed: [], unchanged: [] }
      else {
        await update($, working, () => `Playing what ${target.label} keeps on the working tree and on ${asked.against}…`)
        changed = await changedIn($, target, asked.against, place).catch((error: unknown) => `${target.label} could not be looked at: ${error instanceof Error ? error.message : String(error)}`)
      }

      if (typeof changed === 'string') {
        found.push({ target, found: changed })
        continue
      }

      let made: ArgonathRadius = { ...radiusOf({ label: target.label, kind: target.kind, at: await $.clock.now(), diff: changed, marks: isUntouched ? [] : await marksIn($, cwd, target) }), live: changed.live ?? '' }

      // A proof runs only the tests marked on what changed, and those required: with none, there is nothing to run
      if (asked.isProving && (markedTests(made).length > 0 || required.length > 0)) {
        if (!isTested(target)) made = { ...made, unproved: `${target.label} names no tests to prove: ${target.label}.tests and ${target.label}.test in ${PROJECT_FILE}.` }
        // A command that cannot be narrowed would run tests out of scope: it is not run at all
        else if (!isNarrowable(target.test)) made = { ...made, unproved: `${target.label}.test in ${PROJECT_FILE} has no {tests} for the tests to run, so none is run: every test it holds would be, the ones out of scope with them. Name them as its runner takes them, -k "{tests: or }" for pytest, -- --exact {tests} for cargo.` }
        else {
          await update($, working, () => `Running the tests of ${target.label} on ${asked.against}'s source and on the working tree…`)

          const done = await proveIn($, target, made, asked.against, required, place)

          made = typeof done === 'string' ? { ...made, unproved: done } : done
        }
      }

      // What the change can break beyond its own runs: the target's own tests, when it reached the target
      if (asked.isProving && target.affected !== '' && !isUntouched) {
        await update($, working, () => `Running what a change of ${target.label} can break…`)

        const broken = await affectedIn($, target, asked.against, place)

        made = { ...made, regressions: broken.regressions, preexisting: broken.preexisting, unproved: [made.unproved, broken.unproved].filter(said => said !== '').join('\n') }
      }

      const kept = made
      const placed = (held: readonly ArgonathRadius[]) => list.flatMap(({ label }) => (label === kept.label ? [kept] : held.filter(one => one.label === label)))

      if (place.isHome) await update($, radii, placed)
      else treeRadii.set(cwd, placed(treeRadii.get(cwd) ?? []))
      found.push({ target, found: kept })
    }
  } finally {
    await update($, working, () => '')
  }

  if (place.isHome) {
    await update($, touched, held => held.filter(label => !chosen.some(target => target.label === label)))
    await update($, note, () => found.flatMap(one => (typeof one.found === 'string' ? [one.found] : [])).join(' '))
    if (found.some(one => typeof one.found !== 'string')) await update($, isHidden, () => false)
  }

  // Kept only when the tree did not move while it was made: a proof of a change it no longer is answers nothing
  if (key !== '') {
    if (key.startsWith(`${await wholeFingerprint($, 'HEAD', place)}|`)) lastProofs.set(cwd, { key, looked: found })
    else lastProofs.delete(cwd)
  }
  if (asked.isProving && isOwing) await owe($)

  return found
}

/** A proof as a part reads it: whether it settles the change, and each target's state, with the proof as it reads. */
async function proofShape($: $, looked: readonly Looked[], place: Place) {
  const changes = await changesOf($, place, await targetsIn($, place, true))
  const entries = looked.map(({ target, found }) => ({ label: target?.label ?? '', kind: target?.kind ?? ('' as const), found, isTouched: target === undefined || (changes.get(target.label) ?? '') !== '' }))

  return { ...proofAnswer(entries.filter(one => one.label !== '')), ...(entries.some(one => one.label === '') ? { verdict: 'unlooked', line: looked.map(one => one.found).filter((one): one is string => typeof one === 'string').join(' ') } : {}), text: foundText(looked) }
}

/**
 * Proves the change in a quest's worktree for the Fellowship, which sends the statues on it itself: so the proof owes
 * no review at the turn's end. Galadriel's tests, written before the change, must pass for it to settle.
 */
export async function proveFor($: $, tree: string, mustPass: readonly { file: string; name: string }[]): Promise<unknown> {
  const place = await placeOf($, undefined, tree)
  const looked = await look($, { against: 'HEAD', isProving: true, isOwing: false, place, ...(mustPass.length > 0 ? { required: mustPass } : {}) })

  return proofShape($, looked, place)
}

/** What the project builds, by label, kind and folders from the project's folder: the Fellowship chooses a builder by it. */
export async function targetsKnown($: $): Promise<Target[]> {
  const cwd = await homeOf($)
  const within = (path: string) => (path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path)

  return (await setUp($)).map(({ label, kind, roots }) => ({ label, kind, roots: roots.map(within) }))
}

// The fingerprint of a settled change the reviews are owed, run once the session is idle; empty when none is
let reviewDue = ''

/** Owes the reviews to the change as it stands, when a proof left no changed run of any target unpinned. */
async function owe($: $): Promise<void> {
  if (reviews.length === 0 || unsettled(await read($, radii)).length > 0) return

  const due = await wholeFingerprint($)

  reviewDue = due === (await read($, reviewed)) ? '' : due
}

// What a fingerprint of a change git could not read starts with: it matches no change that was read, so no proof or
// judgement made of one is ever taken for another's
const UNREADABLE = 'unreadable:'

/**
 * The whole change as one fingerprint: HEAD, the diff since `against` left it, and the new files by name and content.
 * One git could not read is `unreadable:` and why, the same each time it fails alike, so a judgement of it is not stale.
 */
async function wholeFingerprint($: $, against = 'HEAD', place?: Place): Promise<string> {
  const ran = await $.process.run(['sh', '-c', CHANGE_SCRIPT, 'sh', against], { cwd: place?.tree ?? (await homeOf($)) }).catch((error: unknown) => ({ exitCode: -1, stdout: '', stderr: errorText(error) }))

  return ran.exitCode === 0 ? `git:${ran.stdout.trim()}` : `${UNREADABLE}${ran.stderr.trim().split('\n').slice(-1)[0] ?? ''}`
}

/** The change as the statues are handed it: the diff since `against` left HEAD, then the new files by name; or why git could not say it. */
async function changeText($: $, against = 'HEAD', place?: Place): Promise<{ text: string } | { error: string }> {
  const ran = await $.process
    .run(['sh', '-c', 'b=$(git merge-base "$1" HEAD) || exit 1; git diff "$b" --no-color --no-ext-diff; echo; echo "New files:"; git ls-files -o --exclude-standard', 'sh', against], { cwd: place?.tree ?? (await homeOf($)) })
    .catch((error: unknown) => ({ exitCode: -1, stdout: '', stderr: errorText(error) }))

  return ran.exitCode === 0 ? { text: ran.stdout } : { error: `git could not show the change since ${against}: ${ran.stderr.trim().split('\n').slice(-1)[0] || `it exited with ${ran.exitCode}`}` }
}

/**
 * The standards the statues judge by, and a builder builds to, each file as the project's folder holds it: a quest's
 * branch, whose change is the one judged, never loosens them. A file that cannot be read is said so, not left out unseen.
 */
export async function standardsText($: $): Promise<string> {
  const cwd = await homeOf($)
  const files = await Promise.all(standards.map(async path => `# ${path}\n${await $.fs.read(`${cwd}/${path}`).catch(() => '(this file could not be read)')}`))

  return files.join('\n\n')
}

/** Whether a change as `changeText` gives it holds nothing: no diff, and no new file. */
const isNoChange = (change: string): boolean => change.trim() === 'New files:' || change.trim() === ''

/**
 * What the last proof found of the change at hand, for the statues: the runs it altered, and the targets it reached
 * that no kept run sees. Only a radius of the tree as it stands is told; a whole branch has none.
 */
async function briefOf($: $, against: string, place: Place): Promise<string> {
  if (against !== 'HEAD') return ''

  const fresh = (await radiiIn($, place)).filter(one => !one.isStale)
  const changes = await changesOf($, place, await targetsIn($, place, true))
  const unreached = fresh.filter(one => one.seams.length === 0 && one.turned.length === 0 && (changes.get(one.label) ?? '') !== '').map(one => one.label)

  return proofBrief(fresh, unreached)
}

/**
 * Sends the statues on the change as it stands, each with its share of the reviews; a change they judged already is
 * not judged again. Answers the judgement, sitting or done. A mod may name a lighter model for a lighter change.
 */
async function convene($: $, by: ArgonathJudgement['by'], about = '', only?: readonly string[], against = 'HEAD', model?: string, at?: Place): Promise<ArgonathJudgement> {
  const place = at ?? (await homePlace($))
  const due = await wholeFingerprint($, against, place)
  const held = await judgementIn($, place)

  if (place.isHome) reviewDue = ''
  // A judgement a statue could not give is no judgement: the same change is judged again, or it would stay stuck
  if (held !== null && held.fingerprint === due && (held.against ?? 'HEAD') === against && verdictOf(held) !== 'silent') return held

  if (place.isHome) await update($, reviewed, () => due)

  const shown = await changeText($, against, place)
  const chosen = dealt(reviews).filter(one => only === undefined || only.length === 0 || only.includes(one.name))

  // A change git could not show is judged by no statue, and so passes none: each seat is silent, saying why
  if ('error' in shown) {
    const unjudged: ArgonathJudgement = { fingerprint: due, at: Date.now(), by, against, seats: chosen.map(seat => ({ statue: seat.name, title: seat.title, reviews: seat.reviews, agentId: '', state: 'silent', findings: [], why: shown.error })) }

    await setJudgement($, place, unjudged)
    await rise($, unjudged)

    return unjudged
  }

  const change = shown.text

  // Nothing to judge: no statue is sent on it
  if (isNoChange(change)) {
    const empty: ArgonathJudgement = { fingerprint: due, at: Date.now(), by, seats: [], against, isEmpty: true }

    await setJudgement($, place, empty)

    return empty
  }

  const seats: ArgonathSeat[] = []
  const brief = await briefOf($, against, place)
  const rules = await standardsText($)
  // A spawn takes the model only as its family's alias: claude-sonnet-5-5 is sent as sonnet
  const alias = model === undefined ? undefined : (/opus|sonnet|haiku|fable/.exec(model)?.[0] ?? model)

  for (const seat of chosen) {
    // A statue judging a quest's change reads it in the quest's worktree
    const started = await spawnIn($, { subagentType: typeOf(seat.name), description: `${seat.title} judges the change`, prompt: statuePrompt(seat.reviews, change, about, brief, rules), ...(alias !== undefined ? { model: alias } : {}), ...(place.isHome ? {} : { cwd: place.tree }) })
      .catch((error: unknown) => ({ deny: error instanceof Error ? error.message : String(error), agentId: undefined }))

    if (started.agentId !== undefined && started.agentId !== '') await remember($, started.agentId, { role: 'statue', root: await homeOf($), tree: place.tree })
    seats.push({ statue: seat.name, title: seat.title, reviews: seat.reviews, agentId: started.agentId ?? '', state: started.deny === undefined ? 'sitting' : 'silent', findings: [], why: started.deny === undefined ? '' : `it could not be sent: ${started.deny}` })
  }

  const made: ArgonathJudgement = { fingerprint: due, at: Date.now(), by, seats, against }

  await setJudgement($, place, made)

  if (seats.length > 0) $.ui.toast(`Argonath: every changed run is pinned, so ${seats.map(seat => seat.title).join(' and ')} ${seats.length === 1 ? 'judges' : 'judge'} the change`)
  if (verdictOf(made) !== 'sitting') await rise($, made)

  return made
}

/** The statues have judged: the person is shown the verdict, and a Claude whose turn convened them is told it. */
async function rise($: $, made: ArgonathJudgement): Promise<void> {
  const verdict = verdictOf(made)

  if (made.seats.length === 0) return

  $.ui.toast(`Argonath: the change ${verdict === 'pass' ? 'passes' : verdict === 'fail' ? 'is stopped: a finding blocks it' : 'was not judged by every statue'}`)

  if (made.by !== 'turn') return

  await $.prompt
    .submit({ text: `${judgementText(made, false)}\n\n${verdict === 'fail' ? 'Fix what blocks before the change is committed, then prove it again: the statues judge the new change.' : verdict === 'silent' ? 'A statue could not judge: say so to the person.' : 'Mention the minor findings to the person, if any.'}` })
    .catch(() => undefined)
}

/** The seat of a statue whose turn this is: by the id its spawn answered, else, where it answered none, by its type. */
async function seatOf($: $, held: ArgonathJudgement, agentId: string): Promise<ArgonathSeat | undefined> {
  const sitting = held.seats.filter(seat => seat.state === 'sitting')
  const byId = sitting.find(seat => seat.agentId !== '' && seat.agentId === agentId)

  if (byId !== undefined) return byId

  const agent = (await $.agent.list().catch(() => [])).find(one => one.id === agentId)

  return agent === undefined ? undefined : sitting.find(seat => seat.agentId === '' && agent.type === typeOf(seat.statue))
}

/** The judgement a statue sits in, wherever it judges, and its seat there; nothing when the agent is no sitting statue. */
async function sittingFor($: $, agentId: string): Promise<{ place: Place; held: ArgonathJudgement; seat: ArgonathSeat } | undefined> {
  for (const { place, held } of await allJudgements($)) {
    const seat = await seatOf($, held, agentId)

    if (seat !== undefined) return { place, held, seat }
  }

  return undefined
}

/** Sends the statues on the change the reviews are owed, once the turn that settled it has ended. */
async function review($: $): Promise<void> {
  const due = reviewDue

  if (due === '' || due === (await read($, reviewed))) return void (reviewDue = '')
  // The change may have moved on since its proof (a commit, a later edit): what stands now is owed its own proof first
  if ((await wholeFingerprint($)) !== due) return void (reviewDue = '')
  // And a change committed whole leaves nothing to judge
  const shown = await changeText($)

  if ('text' in shown && isNoChange(shown.text)) return void (reviewDue = '')

  // The statues are sent from a hook alone, where they are held: from the clock, Claude is asked to call for them
  if (!(await inFrame($))) return askToPump($, 'every changed run of the change is pinned, and the statues wait to review it.')

  reviewDue = ''
  await convene($, 'turn')
}

/** The statues the session's own change is owed, sent from the hook that calls it. */
export async function pumpArgonath($: $): Promise<void> {
  await review($)
}

const foundText = (looked: readonly Looked[]): string => looked.map(({ found }) => (typeof found === 'string' ? found : radiusText(found))).join('\n\n―――\n\n')

const askedOf = (e: unknown, isProving: boolean): Asked => {
  const given = e as { target?: unknown; against?: unknown; mustPass?: unknown }
  const required = (Array.isArray(given.mustPass) ? given.mustPass : [])
    .map(one => one as { file?: unknown; name?: unknown })
    .filter((one): one is { file: string; name: string } => typeof one.file === 'string' && typeof one.name === 'string' && one.name !== '')

  return {
    target: typeof given.target === 'string' && given.target !== '' ? given.target : undefined,
    against: typeof given.against === 'string' && given.against.trim() !== '' ? given.against.trim() : 'HEAD',
    isProving,
    ...(required.length > 0 ? { required } : {}),
  }
}

/** Marks a target's radius as one of an earlier working tree, and owes it a look once the turn has ended. */
async function edited($: $, path: unknown, agentId?: string): Promise<void> {
  if (typeof path !== 'string' || path === '') return

  const cwd = await homeOf($)
  const whole = /^([A-Za-z]:)?\//.test(tidy(path)) ? tidy(path) : `${cwd}/${tidy(path)}`
  const hit = targetsOf(whole, await read($, targets)).map(({ label }) => label)

  if (hit.length === 0) return

  lastProofs.delete(cwd)
  // The radius is old either way; a look at the turn's end, and the statues it may send, are owed only to an edit no
  // builder the mod sent made: its part proves the change and has it judged itself
  if (!['member', 'galadriel'].includes((await roleOf($, agentId)) ?? '')) await update($, touched, held => [...new Set([...held, ...hit])])
  await update($, radii, held => held.map(one => (hit.includes(one.label) && !one.isStale ? { ...one, isStale: true } : one)))
}

/**
 * Where each target's folders stand, by label, cheaply: what git status says of them (from its stat cache, so a large
 * tree costs little), and the size and modification time of each file it names, so a file changed twice is seen
 * twice. Two of these around a shell command say which targets it changed; nothing is read of any file's content.
 */
async function fingerprints($: $): Promise<Map<string, string>> {
  const cwd = await homeOf($)
  const list = await read($, targets)
  const roots = [...new Set(list.flatMap(({ roots }) => roots))]

  if (roots.length === 0) return new Map()

  const ran = await $.process.run(['sh', '-c', STANDING_SCRIPT, 'sh', ...roots], { cwd }).catch(() => undefined)

  return ran === undefined || ran.exitCode !== 0 ? new Map() : standingByTarget(ran.stdout, list, cwd)
}

/** What each target's folders hold against HEAD in a place, by label, read in one go: empty for a target the change did not reach. */
async function changesOf($: $, place: Place, list: readonly ArgonathTarget[]): Promise<Map<string, string>> {
  const cwd = place.tree
  const roots = [...new Set(list.flatMap(({ roots }) => roots))]

  if (roots.length === 0) return new Map()

  const ran = await $.process
    .run(['sh', '-c', `git diff HEAD --no-color --no-ext-diff -- "$@"; echo; echo '${UNTRACKED}'; git ls-files -o --exclude-standard -- "$@"`, 'sh', ...roots], { cwd })
    .catch(() => undefined)

  return ran === undefined || ran.exitCode !== 0 ? new Map() : changesByTarget(ran.stdout, list, cwd)
}

// A turn that edited a target has ended: the next tick of the clock looks at what it touched
let isOwed = false
let isLooking = false

/** Looks at the targets edited during the turn that ended, and proves them, while nothing else is looking; then runs the reviews a settled change is owed. */
async function settle($: $): Promise<void> {
  if (!isOwed || isLooking) return

  const owedTo = await read($, touched)

  isOwed = false

  if (owedTo.length > 0) {
    isLooking = true
    try {
      await look($, { against: 'HEAD', isProving: true }, owedTo)
    } finally {
      isLooking = false
    }
  }

  await review($)
}

const TONE: Record<ArgonathState, Tone> = { bare: 'danger', marked: 'warning', pinned: 'success', loose: 'warning', broken: 'danger' }

const VERDICT_TONE: Record<ArgonathSeat['state'], Tone> = { sitting: 'info', pass: 'success', fail: 'danger', silent: 'warning' }
const VERDICT_TONE_COLOR: Record<ArgonathSeat['state'], string> = { sitting: 'suggestion', pass: 'success', fail: 'error', silent: 'warning' }

const toneOf = (held: ArgonathRadius): Tone => (held.seams.some(seam => seam.state === 'bare' || seam.state === 'broken') || held.turned.length > 0 ? 'danger' : isQuiet(held) ? 'success' : 'warning')

// Sting glows blue, whatever is near: the counts say what
const GLOW = 'suggestion'
// The sword: a hilt that stays dim, and a blade whose glow swells and fades, a beat at a time
const HILT = 'o=['
// A fixed gray, a shade under the theme's dim text: no theme key is darker
const HILT_COLOR = '#5c5c5c'
const BLADE = '=====>'
const BEATS = ['faint', 'lit', 'bright', 'lit'] as const
const BEAT_MS = 450

/** The radii a test does not yet pin all of. */
const unsettled = (all: readonly ArgonathRadius[]): ArgonathRadius[] => all.filter(one => one.seams.length > 0 && !isQuiet(one))

/** Whether the band is lit: a changed run of some target is not pinned, and the person has not hidden it. */
async function isLit($: $): Promise<boolean> {
  return unsettled(await read($, radii)).length > 0 && !(await read($, isHidden))
}

/** One beat of the glow, while the band is lit: a dark band redraws nothing. */
async function beat($: $): Promise<void> {
  if (await isLit($)) await update($, glow, was => (was + 1) % BEATS.length)
}

/** Each unsettled target in a few words, for the band: `gondor 1 bare · narsil 3 marked`. */
const bandLine = (all: readonly ArgonathRadius[]): string =>
  unsettled(all)
    .map(one => `${one.label} ${radiusLine(one).split(' · ').slice(1).filter(part => !part.includes('changed')).join(' · ')}${one.isStale ? ' (before the last edit)' : ''}`)
    .join('  │  ')

/** What is asked of the statues: to be sent on the change, with what it is for, which of them, since where, and on what model. */
type Convening = { convene?: boolean; about?: string; statues?: readonly string[]; against?: string; model?: string }

/**
 * The statues' judgement of the change in a place, sent on it first when asked; `open` names the targets a changed run
 * of which is not pinned, on which no statue is sent.
 */
async function judgementOf($: $, asked: Convening, place: Place): Promise<{ held: ArgonathJudgement | null; isStale: boolean } | { open: string[] }> {
  const against = asked.against !== undefined && asked.against.trim() !== '' ? asked.against.trim() : 'HEAD'

  if (asked.convene === true) {
    await setUp($)

    // A whole branch is judged once its every change was proved: only the change at hand waits on a proof
    const open = against === 'HEAD' ? unsettled(await radiiIn($, place)) : []

    if (open.length > 0) return { open: open.map(one => one.label) }

    const model = asked.model !== undefined && /^[\w.-]+$/.test(asked.model) ? asked.model : undefined

    await convene($, 'tool', asked.about ?? '', asked.statues, against, model, place)
  }

  const held = await judgementIn($, place)

  return { held, isStale: held !== null && held.fingerprint !== (await wholeFingerprint($, held.against ?? 'HEAD', place)) }
}

/** The statues' judgement of the change in a quest's worktree, for the Fellowship: sent on it first when asked. */
export async function judgementFor($: $, tree: string, asked: Convening = {}): Promise<unknown> {
  const got = await judgementOf($, asked, await placeOf($, undefined, tree))

  return 'open' in got ? { verdict: 'unsettled', targets: got.open } : judgementShape(got.held, got.isStale)
}

/** The Argonath at the session's start: its command, its tools, the project's targets, the band's glow, and the clock that looks at what a turn edited. */
export async function startArgonath($: $): Promise<void> {
  await $.command.register({ name: 'argonath', description: 'Open the pane of what the uncommitted change reached in each target the project builds, and which of it an integration test pins' })

  // A host that registers no tools still starts the session
  for (const tool of TOOLS) await $.tool.register(tool).catch(() => undefined)

  await setUp($).catch(() => [])
  $.clock.every(BEAT_MS, () => void beat($).catch(() => undefined))
  $.clock.every(OWED_MS, () => void settle($).catch(() => undefined))
}

/** What Claude is told of the tests owed: one for each run that changed, and none beyond. */
export async function sectionOfArgonath($: $): Promise<Section | undefined> {
  return known.length === 0 ? undefined : { id: 'argonath:radius', text: sectionText(known, await homeOf($)) }
}

/** A turn has ended: a statue's answer is its findings; the session's own owes what it edited a look. */
export async function endedArgonath($: $, e: TurnEnded): Promise<void> {
  const found = e.agentId === undefined ? undefined : await sittingFor($, e.agentId)

  if (found !== undefined) {
    const { place, held, seat } = found
    const answer = e.answer ?? ''

    // A statue that judged but ended without a verdict that reads is asked once for it alone, before its seat is silent
    if (!e.isAborted && e.reason === 'answer' && parseFindings(answer) === undefined && seat.isAskedAgain !== true) {
      const again = await spawnIn($, { subagentType: typeOf(seat.statue), description: `${seat.title} gives its verdict`, prompt: verdictPrompt(answer), ...(place.isHome ? {} : { cwd: place.tree }) })
        .catch((error: unknown) => ({ deny: error instanceof Error ? error.message : String(error), agentId: undefined }))

      if (again.deny === undefined) {
        if (again.agentId !== undefined && again.agentId !== '') await remember($, again.agentId, { role: 'statue', root: await homeOf($), tree: place.tree })
        await setJudgement($, place, { ...held, seats: held.seats.map(one => (one === seat ? { ...one, agentId: again.agentId ?? '', isAskedAgain: true } : one)) })

        return
      }
    }

    const made = { ...held, seats: held.seats.map(one => (one === seat ? seated(one, answer, e.isAborted ? 'aborted' : e.reason) : one)) }

    await setJudgement($, place, made)
    if (verdictOf(made) !== 'sitting') await rise($, made)
  }

  // A subagent's turn is not the session's: its edits wait for the turn that spawned it
  // A proof Claude asked for during the turn may have owed the reviews: they too wait for the turn to end
  if (e.agentId === undefined && !e.isAborted && ((await read($, touched)).length > 0 || reviewDue !== '')) isOwed = true
}

export function registerArgonath(on: On): void {
  // An edit of a target's file makes its radius old, and owes it a look once the turn has ended
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const done = await next(e)
    await edited($, e.file_path, e.agentId)

    return done
  }).catch((_$, e, next) => next(e))

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const done = await next(e)
    await edited($, e.file_path, e.agentId)

    return done
  }).catch((_$, e, next) => next(e))

  // A shell command edits too (a `git checkout`, a `sed`, a formatter): a target whose folders it changed is edited
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    // A command of an agent that only reads is not looked at for edits
    if ((await read($, targets)).length === 0 || ['council', 'statue'].includes((await roleOf($, e.agentId)) ?? '')) return next(e)

    const before = await fingerprints($)
    const done = await next(e)
    const after = await fingerprints($)
    const changed = [...after].filter(([label, now]) => before.has(label) && before.get(label) !== now).map(([label]) => label)

    for (const target of (await read($, targets)).filter(({ label }) => changed.includes(label))) await edited($, target.roots[0], e.agentId)

    return done
  }).catch((_$, e, next) => next(e))

  // The warm databases are the session's: they go when it ends. A /clear goes on in the same process, and keeps them
  on('session.end', async ($, e, next) => {
    if (e.reason !== 'clear') {
      const cwd = await homeOf($)

      for (const image of new Set(known.flatMap(target => (target.db === null ? [] : [target.db.image])))) {
        await $.process.run(['python3', `${tidy($.plugin.root)}/handlers/warm.py`, 'stop', cwd, image], { timeoutMs: 30_000 }).catch(() => undefined)
      }
    }

    return next(e)
  })

  on('tool.call', { tool: 'mcp__middle-earth__radius' }, async ($, e) => ({ result: foundText(await look($, { ...askedOf(e, false), place: await placeOf($, e.agentId) })) })).catch((_$, _e, next) => toolFailed('radius', next.error))

  on('tool.call', { tool: 'mcp__middle-earth__prove' }, async ($, e) => {
    const place = await placeOf($, e.agentId)
    // A subagent's proof waits for the turn that sent it
    const looked = await look($, { ...askedOf(e, true), isOwing: e.agentId === undefined, place })

    return { result: foundText(looked) }
  }).catch((_$, _e, next) => toolFailed('prove', next.error))

  on('tool.call', { tool: 'mcp__middle-earth__judgement' }, async ($, e) => {
    const given = e as unknown as { convene?: unknown; about?: unknown; statues?: unknown; against?: unknown; model?: unknown }
    const got = await judgementOf(
      $,
      {
        convene: given.convene === true,
        about: typeof given.about === 'string' ? given.about : '',
        ...(Array.isArray(given.statues) ? { statues: given.statues.filter((one): one is string => typeof one === 'string') } : {}),
        ...(typeof given.against === 'string' ? { against: given.against } : {}),
        ...(typeof given.model === 'string' ? { model: given.model } : {}),
      },
      await placeOf($, e.agentId),
    )

    if ('open' in got) return { result: `A changed run of ${got.open.join(', ')} is not pinned: the statues judge only a settled change. Prove it first.` }

    return { result: got.held === null ? 'The statues have judged no change yet: they judge one once every changed run is pinned.' : judgementText(got.held, got.isStale) }
  }).catch((_$, _e, next) => toolFailed('judgement', next.error))

  on('command.run', { command: 'argonath' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })

    const list = await setUp($)
    const held = await read($, radii)

    return {
      text:
        list.length === 0
          ? HOW_TO
          : held.length === 0
            ? `Argonath knows ${list.map(({ label, kind }) => `${label} (${kind})`).join(', ')}. Nothing is looked at yet: Radius in the pane looks.`
            : held.map(one => `${radiusLine(one)}.`).join(' '),
    }
  })

  // The blade glows while a run that changed is not pinned, and is dark otherwise
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await isLit($))) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const glowing = BEATS[await read($, glow)] ?? 'lit'

    return (
      <Box>
        {/* The sword keeps its width: on a narrow band the counts are cut, never the blade */}
        <Box flexShrink={0}>
          <Text color={HILT_COLOR}>{HILT}</Text>
          <Text color={GLOW} dimColor={glowing === 'faint'} bold={glowing === 'bright'}>{BLADE}</Text>
          <Text color={GLOW} bold>{' sting'}</Text>
        </Box>
        <Text color={GLOW} wrap="truncate-end">{` · ${bandLine(await read($, radii))}  `}</Text>
        <Button key="argonath-open" label="Open" onPress={() => $.ui.open({ id: PANE, title: TITLE }).then(() => undefined)} />
        <Text> </Text>
        <Button key="argonath-hide" label="Hide" onPress={() => update($, isHidden, () => true)} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Code, Text } = $.ui.resolve(e)
    const list = await read($, targets)
    const held = await read($, radii)
    const doing = await read($, working)
    const problem = await read($, note)
    const owedTo = await read($, touched)
    const openKey = await read($, selected)
    const judged = await read($, judgement)

    // What a button asked for and did not get is said in the pane by `look` itself
    // The person pressed it between turns: a proof that settles the change runs its reviews at once
    const run = (isProving: boolean) => look($, { against: 'HEAD', isProving }).then(() => review($))

    if (list.length === 0) {
      return view.keep(
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="row" gap={2}>
            {badge({ label: 'no target known', tone: 'neutral' })}
            <Button key="refresh" hotkey="r" onPress={() => setUp($).then(() => undefined)}>
              Refresh
            </Button>
          </Box>
          <Text>{HOW_TO}</Text>
        </Box>,
      )
    }

    const section = (target: ArgonathTarget) => {
      const one = held.find(({ label }) => label === target.label)
      const open = one?.seams.find(seam => `${one.label} ${seam.line}` === openKey)
      const rows = (one?.seams ?? []).map((seam): TableCell[] => [
        { text: seam.state, tone: TONE[seam.state] },
        <Button key={`seam-${target.label}-${seam.line}`} plain onPress={() => update($, selected, was => (was === `${target.label} ${seam.line}` ? '' : `${target.label} ${seam.line}`))}>
          {`${target.label} ${seam.line}` === openKey ? '▸ ' : ''}
          {seam.line}
        </Button>,
        seam.tests.length === 0 ? '' : seam.tests.map(test => (one?.isProved === true ? `${test.name} (${test.from} → ${test.to})` : test.name)).join(', '),
      ])

      return (
        <Box flexDirection="column" borderStyle="round" paddingX={1}>
          <Box flexDirection="row" gap={2}>
            <Text bold>{target.label}</Text>
            <Text dimColor>{target.kind}</Text>
            {one === undefined ? badge({ label: 'not looked at', tone: 'neutral' }) : badge({ label: radiusLine(one), tone: one.seams.length === 0 ? 'success' : toneOf(one) })}
            {owedTo.includes(target.label) && <Text color="warning">edited since</Text>}
          </Box>
          {one !== undefined && <Text dimColor>{one.summary}</Text>}
          {one !== undefined && one.live !== '' && <Text dimColor>{one.live}</Text>}
          {one !== undefined && one.seams.length > 0 && table({ columns: [{ header: 'STATE', width: 7 }, { header: 'RUN' }, { header: 'TEST', wrap: true }], rows })}
          {open !== undefined && (
            <Box flexDirection="column">
              <Text color={open.state === 'pinned' ? 'success' : 'warning'}>{owed(open)}</Text>
              {open.evidence !== '' && <Code source={open.evidence} format="diff" />}
            </Box>
          )}
          {one !== undefined && one.turned.length > 0 && <Text color="error">{`Passing on the commit's source and failing on the working tree: ${one.turned.join(', ')}`}</Text>}
          {one !== undefined && one.unproved !== '' && <Text color="warning">{one.unproved}</Text>}
        </Box>
      )
    }

    return view.keep(
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={2}>
          {badge({ label: `${list.length} ${list.length === 1 ? 'target' : 'targets'} · ${unsettled(held).length} with a change no test pins`, tone: unsettled(held).length > 0 ? 'warning' : 'success' })}
          <Button key="radius" hotkey="r" variant="primary" onPress={() => run(false)}>
            Radius
          </Button>
          <Button key="prove" hotkey="p" onPress={() => run(true)}>
            Prove
          </Button>
        </Box>
        {doing !== '' && <Text color="suggestion">{doing}</Text>}
        {problem !== '' && <Text color="warning">{problem}</Text>}
        {list.map(section)}
        {judged !== null && judged.seats.length > 0 && (
          <Box flexDirection="column" borderStyle="round" paddingX={1}>
            <Box flexDirection="row" gap={2}>
              <Text bold>The statues</Text>
              {badge({ label: verdictOf(judged), tone: VERDICT_TONE[verdictOf(judged)] })}
              <Text dimColor>{new Date(judged.at).toLocaleTimeString()}</Text>
            </Box>
            {judged.seats.map(seat => (
              <Box key={`seat-${seat.statue}`} flexDirection="column">
                <Text>
                  <Text bold>{`${seat.title} `}</Text>
                  <Text dimColor>{`${seat.reviews.join(', ')} · `}</Text>
                  <Text color={VERDICT_TONE_COLOR[seat.state]}>{`${seat.state}${seat.why !== '' ? `, ${seat.why}` : ''}`}</Text>
                </Text>
                {seat.findings.map(finding => (
                  <Text color={finding.severity === 'blocking' ? 'error' : undefined} dimColor={finding.severity === 'minor'}>{`  ${finding.severity === 'blocking' ? '✗' : '·'} ${finding.where !== '' ? `${finding.where}: ` : ''}${finding.text}`}</Text>
                ))}
              </Box>
            ))}
          </Box>
        )}
      </Box>,
    )
  })
}
