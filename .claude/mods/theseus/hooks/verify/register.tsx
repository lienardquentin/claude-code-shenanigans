import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Judgement, Radius, ChangedRun, ReviewSeat, RunState, Target } from '../../types'
import { badge } from '../kit/badge'
import type { Tone } from '../kit/badge'
import { paneView } from '../kit/pane-text'
import { clip, keyed } from '../look'
import { answered, dealt, isNoChange, judge, judgementShape, judgementText, nextStep, verdictOf } from '../../core/review'
import type { SendReviewer } from '../../core/review'
import { table } from '../kit/table'
import type { TableCell } from '../kit/table'
import { treeOf } from '../kit/trees'
import { errorText, movedTo, offerTools, rootOf, shellIn, toolFailed } from '../flow'
import type { TargetFolders } from '../../core/run'
import type { Section, TurnEnded } from '../flow'
import { agentOf, askToPump, inFrame, remember, roleOf, spawnIn, treesOf, typeOf } from '../agents'
import type { Review } from '../../core/proof'
import { UNREADABLE, changeText, changesIn, fingerprintOf, sizeOf } from '../../core/change'
import { CONFIG_FILE, LINES_FILE, isMigrationWarning, projectOf } from '../../core/config'
import type { Project } from '../../core/config'
import { lookAt } from '../../core/look'
import type { Handler, Machine } from '../../core/look'
import {
  HOME,
  MARK,
  isQuiet,
  owed,
  proved,
  radiusLine,
  radiusText,
  targetsOf,
  tidy,
  STANDING_SCRIPT,
  standingByTarget,
  proofAnswer,
  proofBrief,
} from '../../core/proof'
import { inBackground, stumbled } from '../trouble'

type $ = EngineInterface
type On = Parameters<Register>[0]

const PANE = 'verify'
const TITLE = 'Verify'
// How often the session is asked whether a look is owed: once a turn has ended with an edit, it runs on the next
const OWED_MS = 2_000

const targets = atom({ plugin: 'theseus', key: 'verifyTargets' } as const, [] as Target[])
const radii = atom({ plugin: 'theseus', key: 'verifyRadii' } as const, [] as Radius[])
const touched = atom({ plugin: 'theseus', key: 'verifyTouched' } as const, [] as string[])
const working = atom({ plugin: 'theseus', key: 'verifyWorking' } as const, '')
const note = atom({ plugin: 'theseus', key: 'verifyNote' } as const, '')
const selected = atom({ plugin: 'theseus', key: 'verifySelected' } as const, '')
const isHidden = atom({ plugin: 'theseus', key: 'verifyIsHidden' } as const, false)
const glow = atom({ plugin: 'theseus', key: 'verifyGlow' } as const, 0)
const home = atom({ plugin: 'theseus', key: 'verifyHome' } as const, '')
const reviewed = atom({ plugin: 'theseus', key: 'verifyReviewed' } as const, '')
const judgement = atom({ plugin: 'theseus', key: 'verifyJudgement' } as const, null as Judgement | null)
const treeJudgements = atom({ plugin: 'theseus', key: 'verifyTreeJudgements' } as const, {} as Record<string, Judgement>)

/** How to have targets known, said where none are. */
export const HOW_TO = [
  `Verify knows no target here. /theseus init proposes ${CONFIG_FILE} from the project, or name each thing it builds there:`,
  '',
  '    [targets.narsil]',
  '    kind = "cli"',
  '    roots = ["narsil"]',
  '    tests = ["narsil/tests"]',
  '    test = "cargo test --manifest-path narsil/Cargo.toml -- --exact {tests}"',
  '',
  '    [targets.gondor]',
  '    kind = "service"',
  '    app = "gondor.app:app"',
  '    roots = ["beacons/gondor"]',
  '    python = "beacons"',
  '    requests = ["GET /health"]',
  '',
  "Its kind and the folders of its source, then its tests and the command that runs them. A CLI's runs are kept by the recorder, a service's requests here. docs/config.md says what each key does.",
].join('\n')

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
 * a run's worktree, whose answers go to the one who asked alone.
 */
type Place = { tree: string; isHome: boolean }

/** The place a call is about: a run's worktree a part names or the calling agent was sent to work in, else the project's. */
async function placeOf($: $, agentId?: string, named?: unknown): Promise<Place> {
  const cwd = await homeOf($)
  const tree = treeOf(cwd, treesOf(), agentId, named)

  return { tree, isHome: tree === cwd }
}

/** The project's folder, as a place. */
async function homePlace($: $): Promise<Place> {
  return ({ tree: await homeOf($), isHome: true })
}

// The last radius of each target in a run's worktree, by its folder: the pane shows only the project's own
const treeRadii = new Map<string, Radius[]>()

// The mod whose diff plays a CLI's kept runs on two builds: a CLI's radius is read from what it says
const RECORDER = 'recorder'
// A handler builds and plays on two sides, and a proof runs the tests on each: as long as a host command may run
const RUN_TIMEOUT_MS = 600_000

/**
 * What a look runs and reads in a place, through the engine. Each radius it makes is kept at once: the project's in
 * the pane's state, a run's worktree's apart, in the order the place's targets are named.
 */
function machineIn($: $, place: Place, list: readonly Target[]): Machine {
  return {
    shell: shellIn($, place.tree),
    // A file that is not there reads as none: the look asks after files a change may have removed
    read: path => $.fs.read(path).catch(() => undefined),
    handle: (handler, job) => handled($, handler, job),
    keptRuns: (target, against) => keptRunsOf($, target, against, place),
    now: () => $.clock.now(),
    say: async doing => void (await update($, working, () => doing)),
    keep: async kept => {
      const placed = (held: readonly Radius[]) => list.flatMap(({ label }) => (label === kept.label ? [kept] : held.filter(one => one.label === label)))

      if (place.isHome) await update($, radii, placed)
      else treeRadii.set(place.tree, placed(treeRadii.get(place.tree) ?? []))
    },
  }
}

/** Runs one of the mod's handler scripts with its job on stdin: how it ended, and why on stderr when it could not be started. */
async function handled($: $, handler: Handler, job: unknown): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return $.process.run(['python3', `${tidy($.plugin.root)}/handlers/${handler}.py`], { stdin: JSON.stringify(job), timeoutMs: RUN_TIMEOUT_MS }).catch((error: unknown) => ({ exitCode: -1, stdout: '', stderr: errorText(error) }))
}

/**
 * What the recorder's diff says of a CLI's kept runs. The recorder is a plugin of its own, useful alone, and this is the one call
 * that crosses to it: through MCP, as a tool call would be put to the session's permission check, which a proof no one
 * is at the prompt for cannot answer.
 */
async function keptRunsOf($: $, target: Target, against: string, place: Place): Promise<{ said: string } | { why: string }> {
  try {
    const answered = await $.mcp.call(RECORDER, 'diff', { target: target.label, from: against, to: 'work', ...(place.isHome ? {} : { tree: place.tree }) })

    return { said: answered.content.map(block => ('text' in block && typeof block.text === 'string' ? block.text : '')).join('\n') }
  } catch (error) {
    const why = errorText(error)

    // A session can run without the recorder loaded, though it is enabled (#48): no builder mends that, a restart does
    if (/no connected MCP tool/.test(why)) return { why: 'The recorder is not loaded in this session (no tool of its is connected): restart Claude Code, and prove again.' }

    return { why: `A CLI's radius is read from the recorder's diff, which could not be called: ${why}` }
  }
}


async function radiiIn($: $, place: Place): Promise<Radius[]> {
  return (place.isHome ? read($, radii) : (treeRadii.get(place.tree) ?? []))
}

/** The reviewers' judgement of the change in a place; null before any. */
async function judgementIn($: $, place: Place): Promise<Judgement | null> {
  return (place.isHome ? read($, judgement) : ((await read($, treeJudgements))[place.tree] ?? null))
}

async function setJudgement($: $, place: Place, made: Judgement): Promise<void> {
  if (place.isHome) await update($, judgement, () => made)
  else await update($, treeJudgements, was => ({ ...was, [place.tree]: made }))
}

/** Every judgement held, with its place: a reviewer's turn is found in whichever it reviews in. */
async function allJudgements($: $): Promise<{ place: Place; held: Judgement }[]> {
  const own = await read($, judgement)

  return [
    ...(own === null ? [] : [{ place: await homePlace($), held: own }]),
    ...Object.entries(await read($, treeJudgements)).map(([tree, held]) => ({ place: { tree, isHome: false }, held })),
  ]
}

// What the pane last drew, for the model to read
export const verifyView = paneView({ id: PANE, title: TITLE, command: '/theseus verify' })
const view = verifyView

// An agent sent to work in a run's worktree is looked at there
const ASKED = {
  target: { type: 'string', description: 'One target by its name; every target the project names when left out.' },
  against: { type: 'string', description: 'The commit the working tree is compared with, by any name git resolves (a tag, a branch). HEAD when left out.' },
} as const

const TOOLS = [
  {
    name: 'radius',
    description:
      "Which kept runs (CLI) or requests (service) answer otherwise on the working tree than on HEAD: each `bare` (no test marked on it) or `marked` (a test has `pins: <the run>` above it). Call it after changing a target's source; write a test for each bare run and for no other. Also names changed lines no kept request ran.",
    inputSchema: { type: 'object', properties: ASKED },
  },
  {
    name: 'prove',
    description:
      "The radius afresh, then the tests marked on changed runs on HEAD's source (your tests laid over it) and on the working tree: `pinned` fails then passes, `loose` passes on both, `broken` fails on yours. Also runs, for a target the change reached, the tests it can break, and names what the change broke. Settled when every changed run is pinned and nothing is broken. Verify does this itself when a turn that edited a target ends.",
    inputSchema: { type: 'object', properties: ASKED },
  },
  {
    name: 'review',
    description:
      "The reviewers' verdict on the settled change: `pass`, `fail` (a blocking finding), `reviewing`, `silent` (one could not judge) or `stale` (the change moved since). `send` sends them on the change as it stands, if not judged yet, and answers at once.",
    inputSchema: {
      type: 'object',
      properties: {
        start: { type: 'boolean', description: 'Send the reviewers (correctness and security) on the change as it stands, when every changed run is pinned and they have not reviewed it yet.' },
        about: { type: 'string', description: 'With start: what the change is meant to do (the task, its acceptance), which the reviewers judge it against.' },
        reviewers: { type: 'array', items: { type: 'string', enum: ['reviewer-correctness', 'reviewer-security'] }, description: 'With start: only these reviewers are sent, each with its share of the reviews (reviewer-correctness, reviewer-security); both when left out.' },
        against: { type: 'string', description: 'With start: judge the change since where HEAD left this branch or commit (its merge base), committed or not, such as a whole branch before its pull request. HEAD when left out.' },
        model: { type: 'string', description: "With start: the model the reviewers judge with, an alias (`sonnet`) or a full id, for a lighter change; their own (Opus) when left out." },
      },
    },
  },
] as const

// The targets the project names, as the system prompt's section reads them: a module's own copy, set again at each load
let known: readonly Target[] = []
// The reviews the project names, run once a change is settled
let reviews: readonly Review[] = []
// The files of standards the reviewers judge by, from the project's folder
let standards: readonly string[] = []
// What of the project's file did not read, as last read: said once, and kept for the doctor
let configErrors: readonly string[] = []

/** What of the project's file does not read, a `file:line: why` each, as last read; the line format's warning apart. */
export const projectErrors = (): { errors: string[]; warnings: string[] } => ({ errors: configErrors.filter(one => !isMigrationWarning(one)), warnings: configErrors.filter(isMigrationWarning) })

const sectionText = (list: readonly Target[], cwd: string): string => {
  const within = (path: string) => (path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path)

  return [
    `Verify checks changes to ${list.map(({ label, kind, roots }) => `\`${label}\` (${kind}, ${roots.map(within).join(', ')})`).join(', ')}.`,
    `After changing one, call mcp__theseus__radius: for each bare run it lists, write one integration test that makes that run and asserts its new answer, \`${MARK} <the run as listed>\` on the line above it; none for a run that did not change.`,
    'Then mcp__theseus__prove: the change is settled when every changed run is pinned and nothing is broken.',
    ...(reviews.length > 0 ? [`Then reviewers judge it when the turn ends (${dealt(reviews).map(seat => seat.reviews.join(', ')).join(', ')}); fix what they find blocking.`] : []),
  ].join(' ')
}

/** A file of a folder, or nothing where it is not there. */
async function fileIn($: $, folder: string, file: string): Promise<string | undefined> {
  return (await $.fs.exists(`${folder}/${file}`)) ? String(await $.fs.read(`${folder}/${file}`)) : undefined
}

/** The project's file in a folder, as Theseus reads it: the TOML one, else the line format. */
async function projectRead($: $, folder: string, cwd = folder): Promise<Project | undefined> {
  return projectOf({ toml: await fileIn($, folder, CONFIG_FILE), lines: await fileIn($, folder, LINES_FILE) }, cwd)
}

async function setUp($: $): Promise<Target[]> {
  const cwd = await homeOf($)
  const project = await projectRead($, cwd)
  const list = project?.targets ?? []
  const errors = project?.errors ?? []

  known = list
  reviews = project?.reviews ?? []
  standards = project?.standards ?? []
  // What does not read is said once a time it changes, and kept where /theseus doctor and the troubles read it
  if (errors.length > 0 && errors.join('\n') !== configErrors.join('\n')) stumbled($, 'the project file')(new Error(errors.join('\n')))
  configErrors = errors
  await update($, targets, () => list)

  return list
}

/** The targets the project's file names, read afresh, as the doctor checks what they need. */
export async function targetsRead($: $): Promise<Target[]> {
  return setUp($)
}

/**
 * The targets of a place, their folders in that place. The project's own are read afresh, or, `isKnown`, as last read.
 * A run's worktree is looked at as the project's folder names its targets: what a target runs on the machine unasked
 * (its tests, its database, its live stage) is never read from a branch. The requests it plays are the project's own,
 * then those its own file keeps besides: a request the branch takes out is played still, as the change it proves
 * cannot shrink what proves it.
 */
async function targetsIn($: $, place: Place, isKnown = false): Promise<Target[]> {
  if (place.isHome) return isKnown ? read($, targets) : setUp($)

  const own = (await projectRead($, place.tree))?.targets ?? []

  return ((await projectRead($, await homeOf($), place.tree))?.targets ?? []).map(target => ({
    ...target,
    requests: [...target.requests, ...(own.find(one => one.label === target.label)?.requests ?? []).filter(line => !target.requests.includes(line))],
  }))
}

// `isOwing`: the proof is the session's own, so a settled change is owed the reviewers when its turn ends; a subagent's is not, as its work may not be done
// `required`: tests written before the change (written first), each `{ file, name }`, that are to pass on the working tree
// `place`: the project's folder when left out
type Asked = { target?: string; against: string; isProving: boolean; isOwing?: boolean; required?: readonly { file: string; name: string }[]; place?: Place }

/** What a look found of one target: its radius, or why it has none; no target where the look found none to look at. */
type Looked = { target?: Target; found: Radius | string }

// The last proof made in each place, by the change it was made on and what was asked: the same proof asked again is
// answered from it
const lastProofs = new Map<string, { key: string; looked: Looked[] }>()

/** Looks again at the targets asked for: what changed in each, and, when asked, whether its tests see it. Answers what was found, a radius or a sentence a target. */
async function look($: $, asked: Asked, only?: readonly string[]): Promise<Looked[]> {
  const place = asked.place ?? (await homePlace($))
  const cwd = place.tree
  // A run's worktree is the run's own: its proof owes the session's turn no review, and the pane does not show it
  const isOwing = place.isHome && asked.isOwing !== false
  const list = await targetsIn($, place)

  if (list.length === 0) return [{ found: HOW_TO }]
  if (asked.target !== undefined && !list.some(({ label }) => label === asked.target)) return [{ found: `Verify knows no target named ${asked.target}. It knows ${list.map(({ label }) => label).join(', ')}.` }]

  const chosen = list.filter(({ label }) => (asked.target === undefined || label === asked.target) && (only === undefined || only.includes(label)))
  const wanted = (asked.required ?? []).map(({ file, name }) => `${file}:${name}`).sort().join(',')
  // A proof takes minutes: one asked again of the same change, as a builder's last and its mod's next are, is not made twice
  const fingerprint = asked.isProving ? await fingerprintOf(shellIn($, place.tree)) : ''
  // A change git could not read is proved afresh each time: its proof is no other change's
  const key = asked.isProving && !fingerprint.startsWith(UNREADABLE) ? `${fingerprint}|${asked.against}|${chosen.map(({ label }) => label).join(',')}|${wanted}` : ''
  const last = lastProofs.get(cwd)

  if (key !== '' && last?.key === key) {
    if (isOwing) await owe($)

    return last.looked
  }

  // The checkouts a handler or a proof makes are no part of the repo: the folder says so itself, before any is made
  const ignore = `${cwd}/${HOME}/.gitignore`
  if (!(await $.fs.exists(ignore))) await $.fs.write(ignore, '*\n')

  // What each target's folders hold against HEAD, read once: a target the change did not reach is not played at all
  const changes = asked.against === 'HEAD' ? await changesIn(shellIn($, cwd), cwd, list) : new Map<string, string>()
  const found = await lookAt(machineIn($, place, list), {
    chosen,
    against: asked.against,
    isProving: asked.isProving,
    required: asked.required ?? [],
    tree: cwd,
    ...(place.isHome ? {} : { project: await homeOf($) }),
    changes,
  })

  if (place.isHome) {
    await update($, touched, held => held.filter(label => !chosen.some(target => target.label === label)))
    await update($, note, () => found.flatMap(one => (typeof one.found === 'string' ? [one.found] : [])).join(' '))
    if (found.some(one => typeof one.found !== 'string')) await update($, isHidden, () => false)
  }

  // Kept only when the tree did not move while it was made: a proof of a change it no longer is answers nothing
  if (key !== '') {
    if (key.startsWith(`${await fingerprintOf(shellIn($, place.tree))}|`)) lastProofs.set(cwd, { key, looked: found })
    else lastProofs.delete(cwd)
  }
  if (asked.isProving && isOwing) await owe($)

  return found
}

/** A proof as a part reads it: whether it settles the change, and each target's state, with the proof as it reads. */
async function proofShape($: $, looked: readonly Looked[], place: Place) {
  const changes = await changesIn(shellIn($, place.tree), place.tree, await targetsIn($, place, true))
  const entries = looked.map(({ target, found }) => ({ label: target?.label ?? '', kind: target?.kind ?? ('' as const), found, isTouched: target === undefined || (changes.get(target.label) ?? '') !== '' }))

  return { ...proofAnswer(entries.filter(one => one.label !== '')), ...(entries.some(one => one.label === '') ? { verdict: 'unlooked', line: looked.map(one => one.found).filter((one): one is string => typeof one === 'string').join(' ') } : {}), text: foundText(looked) }
}

/**
 * Proves the change in a run's worktree for the build, which sends the reviewers on it itself: so the proof owes
 * no review at the turn's end. The tests written first must pass for it to settle.
 */
export async function proveFor($: $, tree: string, mustPass: readonly { file: string; name: string }[]): Promise<unknown> {
  const place = await placeOf($, undefined, tree)
  const looked = await look($, { against: 'HEAD', isProving: true, isOwing: false, place, ...(mustPass.length > 0 ? { required: mustPass } : {}) })

  return proofShape($, looked, place)
}

/** What the project builds, by label, kind and folders from the project's folder: the build chooses a builder by it. */
export async function targetsKnown($: $): Promise<TargetFolders[]> {
  const cwd = await homeOf($)
  const within = (path: string) => (path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path)

  return (await setUp($)).map(({ label, kind, roots }) => ({ label, kind, roots: roots.map(within) }))
}

// The fingerprint of a settled change the reviews are owed, run once the session is idle; empty when none is
let reviewDue = ''

/** Owes the reviews to the change as it stands, when a proof left no changed run of any target unpinned. */
async function owe($: $): Promise<void> {
  if (reviews.length === 0 || unsettled(await read($, radii)).length > 0) return

  const due = await fingerprintOf(shellIn($, await homeOf($)))

  reviewDue = due === (await read($, reviewed)) ? '' : due
}

/**
 * The standards the reviewers judge by, and a builder builds to, each file as the project's folder holds it: a run's
 * branch, whose change is the one judged, never loosens them. A file that cannot be read is said so, not left out unseen.
 */
export async function standardsText($: $): Promise<string> {
  const cwd = await homeOf($)
  const files = await Promise.all(standards.map(async path => `# ${path}\n${await $.fs.read(`${cwd}/${path}`).catch(() => '(this file could not be read)')}`))

  return files.join('\n\n')
}

/**
 * What the last proof found of the change at hand, for the reviewers: the runs it altered, and the targets it reached
 * that no kept run sees. Only a radius of the tree as it stands is told; a whole branch has none.
 */
async function briefOf($: $, against: string, place: Place): Promise<string> {
  if (against !== 'HEAD') return ''

  const fresh = (await radiiIn($, place)).filter(one => !one.isStale)
  const changes = await changesIn(shellIn($, place.tree), place.tree, await targetsIn($, place, true))
  // A frontend's runs are compared by none: the reviewers are told so where the change reached it, not that none changed
  const unreached = fresh.filter(one => one.isUnhandled !== true && one.seams.length === 0 && one.turned.length === 0 && (changes.get(one.label) ?? '') !== '').map(one => one.label)

  return proofBrief(fresh, unreached)
}

/**
 * Sends the reviewers on the change as it stands, each with its share of the reviews; a change they judged already is
 * not judged again. Answers the judgement, reviewing or done. A mod may name a lighter model for a lighter change, and
 * the issue the change is for, which what the reviewers cost is counted to.
 */
async function sendReviewers($: $, by: Judgement['by'], about = '', only?: readonly string[], against = 'HEAD', model?: string, at?: Place, ref?: string): Promise<Judgement> {
  const place = at ?? (await homePlace($))
  const due = await fingerprintOf(shellIn($, place.tree), against)
  const held = await judgementIn($, place)

  if (place.isHome) reviewDue = ''
  // A judgement a reviewer could not give is no judgement: the same change is judged again, or it would stay stuck
  if (held !== null && held.fingerprint === due && (held.against ?? 'HEAD') === against && verdictOf(held) !== 'silent') return held

  if (place.isHome) await update($, reviewed, () => due)

  const chosen = dealt(reviews).filter(one => only === undefined || only.length === 0 || only.includes(one.name))
  // A spawn takes the model only as its family's alias: claude-sonnet-5-5 is sent as sonnet
  const alias = model === undefined ? undefined : (/opus|sonnet|haiku|fable/.exec(model)?.[0] ?? model)
  const shown = await changeText(shellIn($, place.tree), against)
  const made = await judge(reviewerSender($, place, ref), {
    fingerprint: due,
    against,
    by,
    change: shown,
    seats: chosen,
    told: async () => ({ about, proof: await briefOf($, against, place), standards: await standardsText($), size: await sizeOf(shellIn($, place.tree), against) }),
    ...(alias !== undefined ? { model: alias } : {}),
    at: Date.now(),
  })

  await setJudgement($, place, made)

  if ('text' in shown && made.seats.length > 0) $.ui.toast(`Verify: every changed run is pinned, so ${made.seats.map(seat => seat.title).join(' and ')} ${made.seats.length === 1 ? 'judges' : 'judge'} the change`)
  if (verdictOf(made) !== 'reviewing') await rise($, made)

  return made
}

/**
 * Sends a reviewer on the change in a place, from the hook it is asked in, where it is held: a reviewer judging a
 * run's change reads it in the run's worktree. It is recorded as the issue's, which what it costs is counted to.
 */
function reviewerSender($: $, place: Place, ref?: string): SendReviewer {
  return async (reviewer, task) => {
    const started = await spawnIn($, { subagentType: typeOf(reviewer), ...task, ...(place.isHome ? {} : { cwd: place.tree }) }).catch((error: unknown) => ({ deny: errorText(error), agentId: undefined }))

    if (started.deny !== undefined) return { why: started.deny }
    if (started.agentId !== undefined && started.agentId !== '') await remember($, started.agentId, { role: 'reviewer', root: await homeOf($), tree: place.tree, ...(ref !== undefined ? { ref } : {}) })

    return { agentId: started.agentId ?? '' }
  }
}

/** The reviewers have judged: the person is shown the verdict, and a Claude whose turn sent them is told it. */
async function rise($: $, made: Judgement): Promise<void> {
  const verdict = verdictOf(made)

  if (made.seats.length === 0) return

  $.ui.toast(`Verify: the change ${verdict === 'pass' ? 'passes' : verdict === 'fail' ? 'is stopped: a finding blocks it' : 'was not judged by every reviewer'}`)

  if (made.by !== 'turn') return

  const next = nextStep(made)

  await $.prompt
    .submit({ text: [judgementText(made, false), next].filter(one => one !== '').join('\n\n') })
    .catch(stumbled($, 'verify'))
}

/** The seat of a reviewer whose turn this is: by the id its spawn answered, else, where it answered none, by its type. */
async function seatOf($: $, held: Judgement, agentId: string): Promise<ReviewSeat | undefined> {
  const reviewing = held.seats.filter(seat => seat.state === 'reviewing')
  const byId = reviewing.find(seat => seat.agentId !== '' && seat.agentId === agentId)

  if (byId !== undefined) return byId

  const agent = (await $.agent.list()).find(one => one.id === agentId)

  return agent === undefined ? undefined : reviewing.find(seat => seat.agentId === '' && agent.type === typeOf(seat.reviewer))
}

/** The judgement a reviewer reviews in, wherever it judges, and its seat there; nothing when the agent is no reviewing reviewer. */
async function sittingFor($: $, agentId: string): Promise<{ place: Place; held: Judgement; seat: ReviewSeat } | undefined> {
  for (const { place, held } of await allJudgements($)) {
    const seat = await seatOf($, held, agentId)

    if (seat !== undefined) return { place, held, seat }
  }

  return undefined
}

/** Sends the reviewers on the change the reviews are owed, once the turn that settled it has ended. */
async function review($: $): Promise<void> {
  const due = reviewDue

  if (due === '' || due === (await read($, reviewed))) return void (reviewDue = '')
  // The change may have moved on since its proof (a commit, a later edit): what stands now is owed its own proof first
  if ((await fingerprintOf(shellIn($, await homeOf($)))) !== due) return void (reviewDue = '')
  // And a change committed whole leaves nothing to judge
  const shown = await changeText(shellIn($, await homeOf($)))

  if ('text' in shown && isNoChange(shown.text)) return void (reviewDue = '')

  // The reviewers are sent from a hook alone, where they are held: from the clock, Claude is asked to call for them
  if (!(await inFrame($))) return askToPump($, 'every changed run of the change is pinned, and the reviewers wait to review it.')

  reviewDue = ''
  await sendReviewers($, 'turn')
}

/** The reviewers the session's own change is owed, sent from the hook that calls it. */
export async function pumpVerify($: $): Promise<void> {
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
  // The radius is old either way; a look at the turn's end, and the reviewers it may send, are owed only to an edit no
  // builder the mod sent made: its part proves the change and has it judged itself
  if (!['builder', 'test-writer'].includes((await roleOf($, agentId)) ?? '')) await update($, touched, held => [...new Set([...held, ...hit])])
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

  const ran = await $.process.run(['sh', '-c', STANDING_SCRIPT, 'sh', ...roots], { cwd }).catch(stumbled($, 'verify'))

  return ran === undefined || ran.exitCode !== 0 ? new Map() : standingByTarget(ran.stdout, list, cwd)
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

const TONE: Record<RunState, Tone> = { bare: 'danger', marked: 'warning', pinned: 'success', loose: 'warning', broken: 'danger' }
// The same, as a Text paints it
const STATE_COLOR: Record<RunState, string> = { bare: 'error', marked: 'warning', pinned: 'success', loose: 'warning', broken: 'error' }
// From how wide a pane the runs are drawn as a table; narrower, each is a row of its own
const WIDE_COLUMNS = 100
// The column a run's state is said in, as a row of its own
const STATE_WIDTH = 8

const VERDICT_TONE: Record<ReviewSeat['state'], Tone> = { reviewing: 'info', pass: 'success', fail: 'danger', silent: 'warning' }
const VERDICT_TONE_COLOR: Record<ReviewSeat['state'], string> = { reviewing: 'suggestion', pass: 'success', fail: 'error', silent: 'warning' }

const toneOf = (held: Radius): Tone => (held.seams.some(seam => seam.state === 'bare' || seam.state === 'broken') || held.turned.length > 0 ? 'danger' : isQuiet(held) ? 'success' : 'warning')

// The mark glows blue, whatever is near: the counts say what
const GLOW = 'suggestion'
// A mark whose glow swells and fades, a beat at a time
const MARK_GLYPH = '●'
const BEATS = ['faint', 'lit', 'bright', 'lit'] as const
const BEAT_MS = 450

/** The radii a test does not yet pin all of. */
const unsettled = (all: readonly Radius[]): Radius[] => all.filter(one => one.seams.length > 0 && !isQuiet(one))

/** Whether the band is lit: a changed run of some target is not pinned, and the person has not hidden it. */
async function isLit($: $): Promise<boolean> {
  return unsettled(await read($, radii)).length > 0 && !(await read($, isHidden))
}

/** One beat of the glow, while the band is lit: a dark band redraws nothing. */
async function beat($: $): Promise<void> {
  if (await isLit($)) await update($, glow, was => (was + 1) % BEATS.length)
}

/** Each unsettled target in a few words, for the band: `gondor 1 bare · narsil 3 marked`. */
const bandLine = (all: readonly Radius[]): string =>
  unsettled(all)
    .map(one => `${one.label} ${radiusLine(one).split(' · ').slice(1).filter(part => !part.includes('changed')).join(' · ')}${one.isStale ? ' (before the last edit)' : ''}`)
    .join('  │  ')

/** What is asked of the reviewers: to be sent on the change, with what it is for, which of them, since where, and on what model. */
type ReviewAsk = { start?: boolean; about?: string; reviewers?: readonly string[]; against?: string; model?: string; ref?: string }

/**
 * The reviewers' judgement of the change in a place, sent on it first when asked; `open` names the targets a changed run
 * of which is not pinned, on which no reviewer is sent.
 */
async function judgementOf($: $, asked: ReviewAsk, place: Place): Promise<{ held: Judgement | null; isStale: boolean } | { open: string[] }> {
  const against = asked.against !== undefined && asked.against.trim() !== '' ? asked.against.trim() : 'HEAD'

  if (asked.start === true) {
    await setUp($)

    // A whole branch is judged once its every change was proved: only the change at hand waits on a proof
    const open = against === 'HEAD' ? unsettled(await radiiIn($, place)) : []

    if (open.length > 0) return { open: open.map(one => one.label) }

    const model = asked.model !== undefined && /^[\w.-]+$/.test(asked.model) ? asked.model : undefined

    await sendReviewers($, 'tool', asked.about ?? '', asked.reviewers, against, model, place, asked.ref)
  }

  const held = await judgementIn($, place)

  return { held, isStale: held !== null && held.fingerprint !== (await fingerprintOf(shellIn($, place.tree), held.against ?? 'HEAD')) }
}

/** The reviewers' judgement of the change in a run's worktree, for the build: sent on it first when asked. */
export async function judgementFor($: $, tree: string, asked: ReviewAsk = {}): Promise<unknown> {
  const got = await judgementOf($, asked, await placeOf($, undefined, tree))

  return 'open' in got ? { verdict: 'unsettled', targets: got.open } : judgementShape(got.held, got.isStale)
}

/** Verify at the session's start: its command, its tools, the project's targets, the band's glow, and the clock that looks at what a turn edited. */
export async function startVerify($: $): Promise<void> {
  await $.command.register({ name: 'checks', description: 'Now /theseus verify (this name goes in the next release)' })

  // A host that registers no tools still starts the session
  await offerTools($, TOOLS)

  await setUp($).catch(stumbled($, 'verify'))
  $.clock.every(BEAT_MS, inBackground($, 'verify', () => beat($)))
  $.clock.every(OWED_MS, inBackground($, 'verify', () => settle($)))
}

/** What Claude is told of the tests owed: one for each run that changed, and none beyond. */
export async function sectionOfVerify($: $): Promise<Section | undefined> {
  return known.length === 0 ? undefined : { id: 'verify:radius', text: sectionText(known, await homeOf($)) }
}

/** A turn has ended: a reviewer's answer is its findings; the session's own owes what it edited a look. */
export async function endedVerify($: $, e: TurnEnded): Promise<void> {
  const found = e.agentId === undefined ? undefined : await sittingFor($, e.agentId)

  if (found !== undefined) {
    const { place, held, seat } = found
    // A reviewer asked again for its verdict is recorded for the issue its first sending was for
    const made = await answered(reviewerSender($, place, agentOf(e.agentId)?.ref), held, seat, e.answer ?? '', e.isAborted ? 'aborted' : e.reason)

    await setJudgement($, place, made)
    if (verdictOf(made) !== 'reviewing') await rise($, made)
  }

  // A subagent's turn is not the session's: its edits wait for the turn that spawned it
  // A proof Claude asked for during the turn may have owed the reviews: they too wait for the turn to end
  if (e.agentId === undefined && !e.isAborted && ((await read($, touched)).length > 0 || reviewDue !== '')) isOwed = true
}

/** `/theseus verify`: Opens the proof of the uncommitted change. */
export async function verifyCommand($: $, _args: string): Promise<{ text: string }> {
  await $.ui.open({ id: PANE, title: TITLE })

  const list = await setUp($)
  const held = await read($, radii)

  return {
    text:
      list.length === 0
        ? HOW_TO
        : held.length === 0
          ? `Verify knows ${list.map(({ label, kind }) => `${label} (${kind})`).join(', ')}. Nothing is looked at yet: Radius in the pane looks.`
          : held.map(one => `${radiusLine(one)}.`).join(' '),
  }
}

export function registerVerify(on: On): void {
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
    if ((await read($, targets)).length === 0 || ['planner', 'reviewer'].includes((await roleOf($, e.agentId)) ?? '')) return next(e)

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
        await $.process.run(['python3', `${tidy($.plugin.root)}/handlers/warm.py`, 'stop', cwd, image], { timeoutMs: 30_000 }).catch(stumbled($, `verify (stopping the ${image} database)`))
      }
    }

    return next(e)
  })

  on('tool.call', { tool: 'mcp__theseus__radius' }, async ($, e) => ({ result: foundText(await look($, { ...askedOf(e, false), place: await placeOf($, e.agentId) })) })).catch((_$, _e, next) => toolFailed('radius', next.error))

  on('tool.call', { tool: 'mcp__theseus__prove' }, async ($, e) => {
    const place = await placeOf($, e.agentId)
    // A subagent's proof waits for the turn that sent it
    const looked = await look($, { ...askedOf(e, true), isOwing: e.agentId === undefined, place })

    return { result: foundText(looked) }
  }).catch((_$, _e, next) => toolFailed('prove', next.error))

  on('tool.call', { tool: 'mcp__theseus__review' }, async ($, e) => {
    const given = e as unknown as { start?: unknown; about?: unknown; reviewers?: unknown; against?: unknown; model?: unknown }
    const got = await judgementOf(
      $,
      {
        start: given.start === true,
        about: typeof given.about === 'string' ? given.about : '',
        ...(Array.isArray(given.reviewers) ? { reviewers: given.reviewers.filter((one): one is string => typeof one === 'string') } : {}),
        ...(typeof given.against === 'string' ? { against: given.against } : {}),
        ...(typeof given.model === 'string' ? { model: given.model } : {}),
      },
      await placeOf($, e.agentId),
    )

    if ('open' in got) return { result: `A changed run of ${got.open.join(', ')} is not pinned: the reviewers judge only a settled change. Prove it first.` }

    return { result: got.held === null ? 'The reviewers have judged no change yet: they judge one once every changed run is pinned.' : judgementText(got.held, got.isStale) }
  }).catch((_$, _e, next) => toolFailed('review', next.error))

  // The command it had before /theseus, kept for one release: it says its new spelling
  on('command.run', { command: 'checks' }, async ($, e) => movedTo('/checks', '/theseus verify', await verifyCommand($, e.args)))


  // The mark glows while a run that changed is not pinned, and is dark otherwise
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await isLit($))) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const glowing = BEATS[await read($, glow)] ?? 'lit'

    return (
      <Box>
        {/* The mark keeps its width: on a narrow band the counts are cut, never the mark */}
        <Box flexShrink={0}>
          <Text color={GLOW} dimColor={glowing === 'faint'} bold={glowing === 'bright'}>{MARK_GLYPH}</Text>
          <Text color={GLOW} bold>{' to pin'}</Text>
        </Box>
        <Text color={GLOW} wrap="truncate-end">{` · ${bandLine(await read($, radii))}  `}</Text>
        <Button key="verify-open" label="Open" onPress={() => $.ui.open({ id: PANE, title: TITLE }).then(() => undefined)} />
        <Text> </Text>
        <Button key="verify-hide" label="Hide" onPress={() => update($, isHidden, () => true)} />
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
          <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
            {badge({ label: 'no target known', tone: 'neutral' })}
            <Button key="refresh" hotkey="r" onPress={() => setUp($).then(() => undefined)}>
              {keyed('r', 'Refresh')}
            </Button>
          </Box>
          <Text>{HOW_TO}</Text>
        </Box>,
        e.props.bodyColumns,
      )
    }

    const width = e.props.bodyColumns ?? 80
    // Wide, the runs are a table; in a side pane each is a row of its own, its tests under it, so no run is cut short
    const isTabled = width >= WIDE_COLUMNS

    const section = (target: Target) => {
      const one = held.find(({ label }) => label === target.label)
      const open = one?.seams.find(seam => `${one.label} ${seam.line}` === openKey)
      const testsOf = (seam: ChangedRun) => seam.tests.map(test => (one?.isProved === true ? `${test.name} (${test.from} → ${test.to})` : test.name)).join(', ')
      const pick = (seam: ChangedRun) => update($, selected, was => (was === `${target.label} ${seam.line}` ? '' : `${target.label} ${seam.line}`))
      const rows = (one?.seams ?? []).map((seam): TableCell[] => [
        { text: seam.state, tone: TONE[seam.state] },
        <Button key={`seam-${target.label}-${seam.line}`} plain onPress={() => pick(seam)}>
          {`${target.label} ${seam.line}` === openKey ? '▸ ' : ''}
          {seam.line}
        </Button>,
        testsOf(seam),
      ])
      const listed = (one?.seams ?? []).map(seam => (
        <Box key={`seam-row-${target.label}-${seam.line}`} flexDirection="row">
          <Box width={STATE_WIDTH} flexShrink={0}>
            <Text color={STATE_COLOR[seam.state]}>{seam.state}</Text>
          </Box>
          <Box flexDirection="column" flexGrow={1} flexShrink={1}>
            <Button key={`seam-${target.label}-${seam.line}`} plain onPress={() => pick(seam)}>
              {`${target.label} ${seam.line}` === openKey ? '▸ ' : ''}
              {clip(seam.line, width - 4 - STATE_WIDTH - 2)}
            </Button>
            {seam.tests.length > 0 && <Text dimColor>{testsOf(seam)}</Text>}
          </Box>
        </Box>
      ))

      return (
        <Box flexDirection="column" borderStyle="round" paddingX={1}>
          <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
            <Text bold>{target.label}</Text>
            <Text dimColor>{target.kind}</Text>
            {one === undefined ? badge({ label: 'not looked at', tone: 'neutral' }) : badge({ label: radiusLine(one).replace(`${one.label}: `, ''), tone: one.seams.length === 0 ? 'success' : toneOf(one) })}
            {owedTo.includes(target.label) && <Text color="warning">edited since</Text>}
          </Box>
          {one !== undefined && <Text dimColor>{one.summary.replace(`${one.label}: `, '')}</Text>}
          {one !== undefined && one.live !== '' && <Text dimColor>{one.live}</Text>}
          {one !== undefined && one.seams.length > 0 && (isTabled ? table({ columns: [{ header: 'STATE', width: 7 }, { header: 'RUN' }, { header: 'TEST', wrap: true }], rows }) : <Box flexDirection="column">{listed}</Box>)}
          {open !== undefined && (
            <Box flexDirection="column" marginTop={1}>
              <Text bold>{open.line}</Text>
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
        <Box flexDirection="column">
          {badge({ label: `${list.length} ${list.length === 1 ? 'target' : 'targets'} · ${unsettled(held).length} with a change no test pins`, tone: unsettled(held).length > 0 ? 'warning' : 'success' })}
          <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
            <Button key="radius" hotkey="r" variant="primary" onPress={() => run(false)}>
              {keyed('r', 'Radius')}
            </Button>
            <Button key="prove" hotkey="p" onPress={() => run(true)}>
              {keyed('p', 'Prove')}
            </Button>
          </Box>
        </Box>
        {doing !== '' && <Text color="suggestion">{doing}</Text>}
        {problem !== '' && <Text color="warning">{problem}</Text>}
        {list.map(section)}
        {judged !== null && judged.seats.length > 0 && (
          <Box flexDirection="column" borderStyle="round" paddingX={1}>
            <Box flexDirection="row" gap={2}>
              <Text bold>The reviewers</Text>
              {badge({ label: verdictOf(judged), tone: VERDICT_TONE[verdictOf(judged)] })}
              <Text dimColor>{new Date(judged.at).toLocaleTimeString()}</Text>
            </Box>
            {judged.seats.map(seat => (
              <Box key={`seat-${seat.reviewer}`} flexDirection="column">
                <Text>
                  <Text bold>{`${seat.title} `}</Text>
                  <Text dimColor>{`${seat.reviews.join(', ')} · `}</Text>
                  <Text color={VERDICT_TONE_COLOR[seat.state]}>{`${seat.state}${seat.why !== '' ? `, ${seat.why}` : ''}`}</Text>
                </Text>
                {seat.findings.map(finding => (
                  // A finding's mark keeps its column: its text wraps under itself
                  <Box flexDirection="row">
                    <Box width={4} flexShrink={0}>
                      <Text color={finding.severity === 'blocking' ? 'error' : undefined} dimColor={finding.severity === 'minor'}>{`  ${finding.severity === 'blocking' ? '✗' : '·'}`}</Text>
                    </Box>
                    <Box flexGrow={1} flexShrink={1}>
                      <Text color={finding.severity === 'blocking' ? 'error' : undefined} dimColor={finding.severity === 'minor'}>
                        {finding.where !== '' && <Text bold>{`${finding.where}: `}</Text>}
                        {finding.text}
                      </Text>
                    </Box>
                  </Box>
                ))}
              </Box>
            ))}
          </Box>
        )}
      </Box>,
      width,
    )
  })
}
