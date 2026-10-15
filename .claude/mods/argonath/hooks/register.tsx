import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ArgonathJudgement, ArgonathRadius, ArgonathSeat, ArgonathState, ArgonathTarget } from '../types'
import { badge } from './kit/badge'
import type { Tone } from './kit/badge'
import { paneView } from './kit/pane-text'
import { STATUES, STATUE_EFFORT, STATUE_MODEL, dealt, isChanging, judgementJson, judgementText, seated, statuePrompt, statueSystem, verdictOf } from './statues'
import { table } from './kit/table'
import type { TableCell } from './kit/table'
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
  fingerprintOf,
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

const PANE = 'argonath'
const TITLE = 'Argonath'
// The tool of anduril's that plays a CLI's kept runs on two builds: a CLI's radius is read from what it says
const ANDURIL_DIFF = 'mcp__anduril__diff'
// A look builds and plays on two sides, and a proof runs the tests on each: as long as a host command may run
const RUN_TIMEOUT_MS = 600_000
// How many test files are read for marks
const READ_FILES = 300
// How often the session is asked whether a look is owed: once a turn has ended with an edit, it runs on the next
const OWED_MS = 2_000

const targets = atom({ plugin: 'argonath', key: 'targets' } as const, [] as ArgonathTarget[])
const radii = atom({ plugin: 'argonath', key: 'radii' } as const, [] as ArgonathRadius[])
const touched = atom({ plugin: 'argonath', key: 'touched' } as const, [] as string[])
const working = atom({ plugin: 'argonath', key: 'working' } as const, '')
const note = atom({ plugin: 'argonath', key: 'note' } as const, '')
const selected = atom({ plugin: 'argonath', key: 'selected' } as const, '')
const isHidden = atom({ plugin: 'argonath', key: 'isHidden' } as const, false)
const glow = atom({ plugin: 'argonath', key: 'glow' } as const, 0)
const home = atom({ plugin: 'argonath', key: 'home' } as const, '')
const reviewed = atom({ plugin: 'argonath', key: 'reviewed' } as const, '')
const judgement = atom({ plugin: 'argonath', key: 'judgement' } as const, null as ArgonathJudgement | null)

/** The folder the session started in: a `cd` Claude runs does not move the project from under the mod. */
const homeOf = async ($: $): Promise<string> => {
  const held = await read($, home)

  if (held !== '') return held

  const cwd = tidy(await $.session.cwd())

  await update($, home, () => cwd)

  return cwd
}

// What the pane last drew, for the model to read
const view = paneView({ id: PANE, title: TITLE, command: '/argonath' })

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
    inputSchema: {
      type: 'object',
      properties: {
        ...ASKED,
        mustPass: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, name: { type: 'string' } }, required: ['file', 'name'] }, description: 'From a mod: tests written before the change (each its file and name), which must pass on the working tree for the proof to settle.' },
        owe: { type: 'boolean', description: 'false from a mod that convenes the statues on the change itself: a proof that pins it then owes no judgement at the turn\'s end, which would judge it twice.' },
        json: { type: 'boolean', description: 'Answer as JSON, for a mod that settles on it: `verdict` (settled, unsettled, or unlooked when a target the change reached could not be looked at), `line`, each target\'s `state`, the `unhandled` targets nothing proves, and `text`, the proof as it reads.' },
      },
    },
  },
  {
    name: 'judgement',
    description:
      "The reviewers' verdict on the settled change: `pass`, `fail` (a blocking finding), `sitting`, `silent` (one could not judge) or `stale` (the change moved since). `convene` sends them on the change as it stands, if not judged yet, and answers at once.",
    inputSchema: {
      type: 'object',
      properties: {
        convene: { type: 'boolean', description: 'Send the statues on the change as it stands, when every changed run is pinned and they have not judged it yet.' },
        about: { type: 'string', description: 'With convene: what the change is meant to do (the task, its acceptance), which the statues judge it against.' },
        statues: { type: 'array', items: { type: 'string', enum: ['isildur', 'anarion'] }, description: 'With convene: only these statues sit, each with its share of the reviews; both when left out.' },
        against: { type: 'string', description: 'With convene: judge the change since where HEAD left this branch or commit (its merge base), committed or not, such as a whole branch before its pull request. HEAD when left out.' },
        model: { type: 'string', description: "With convene: the model the statues judge with, an alias (`sonnet`) or a full id, for a lighter change; their own (Opus) when left out." },
        json: { type: 'boolean', description: 'Answer as JSON, for a mod that waits on the verdict.' },
      },
    },
  },
  {
    name: 'targets',
    description: 'What the project builds, as JSON: each target with its label, its kind (cli, service, frontend) and its source folders from the project\'s folder.',
    inputSchema: { type: 'object', properties: {} },
  },
] as const

// The targets the project names, as the system prompt's section reads them: a module's own copy, set again at each load
let known: readonly ArgonathTarget[] = []
// The reviews the project names, run once a change is settled
let reviews: readonly Review[] = []

const sectionText = (list: readonly ArgonathTarget[], cwd: string): string => {
  const within = (path: string) => (path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path)

  return [
    `Argonath checks changes to ${list.map(({ label, kind, roots }) => `\`${label}\` (${kind}, ${roots.map(within).join(', ')})`).join(', ')}.`,
    `After changing one, call mcp__argonath__radius: for each bare run it lists, write one integration test that makes that run and asserts its new answer, \`${MARK} <the run as listed>\` on the line above it; none for a run that did not change.`,
    'Then mcp__argonath__prove: the change is settled when every changed run is pinned and nothing is broken.',
    ...(reviews.length > 0 ? [`Then reviewers judge it when the turn ends (${dealt(reviews).map(seat => seat.reviews.join(', ')).join(', ')}); fix what they find blocking.`] : []),
  ].join(' ')
}

const setUp = async ($: $): Promise<ArgonathTarget[]> => {
  const cwd = await homeOf($)
  const text = await $.fs.read(`${cwd}/${PROJECT_FILE}`).catch(() => '')
  const list = parseProject(text, cwd)

  known = list
  reviews = parseReviews(text)
  await update($, targets, () => list)

  return list
}

/** Every mark in the files a target names as tests: what git tracks there, and what it neither tracks nor ignores. */
const marksIn = async ($: $, cwd: string, target: ArgonathTarget): Promise<{ line: string; test: string }[]> => {
  if (target.tests.length === 0) return []

  const listed = await $.process.run(['git', 'ls-files', '-co', '--exclude-standard', '--', ...target.tests], { cwd }).catch(() => undefined)
  const paths = (listed?.exitCode === 0 ? listed.stdout.split('\n') : []).map(path => path.trim()).filter(path => path !== '')
  const marks: { line: string; test: string }[] = []

  for (const path of paths.slice(0, READ_FILES)) marks.push(...marksOf(await $.fs.read(`${cwd}/${path}`).catch(() => '')))

  return marks
}

// What a handler found, and for a service with a live stage, what that stage found in a line
type Found = Changed & { live?: string }

/** A CLI's handler: anduril plays its kept runs on both builds, and says what changed. */
const cliChanged = async ($: $, target: ArgonathTarget, against: string): Promise<Changed | string> => {
  try {
    const answered = (await $.tool.call({ tool: ANDURIL_DIFF, target: target.label, from: against, to: 'work' } as never)) as unknown as { result?: unknown; text?: unknown }
    const said = typeof answered.result === 'string' ? answered.result : typeof answered.text === 'string' ? answered.text : ''

    // What anduril says in place of a comparison is why there is no radius
    return parseDiffText(said) ?? (said !== '' ? said : 'anduril answered nothing to read.')
  } catch (error) {
    return `A CLI's radius is read from anduril's diff, which could not be called: ${error instanceof Error ? error.message : String(error)}`
  }
}

/**
 * A service's handler: its kept requests are played in-process on both builds, standing alone; then, where the
 * project says where it is deployed and it is running, on both builds again against its real dependencies.
 */
const serviceChanged = async ($: $, target: ArgonathTarget, against: string): Promise<Found | string> => {
  if (target.app === '') return `${target.label} names no app: say it as service:module:app, gondor=service:gondor.app:app@beacons/gondor.`
  if (target.requests.length === 0) return `No request of ${target.label} is kept to play. Keep one with a line in ${PROJECT_FILE}: $ ${target.label} GET /health`

  const job = { home: await homeOf($), label: target.label, app: target.app, python: target.python, env: target.env, masks: target.masks, requests: target.requests, from: against, roots: target.roots, db: target.db, ready: target.ready }
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
const changedIn = ($: $, target: ArgonathTarget, against: string): Promise<Found | string> =>
  target.kind === 'cli'
    ? cliChanged($, target, against)
    : target.kind === 'service'
      ? serviceChanged($, target, against)
      : Promise.resolve(`${target.label} is a frontend: Argonath has no handler for a frontend yet, so what changed in it is not known.`)

/** Runs a target's tests on both sides, and says where each changed run, and each test required, stands. */
const proveIn = async ($: $, target: ArgonathTarget, made: ArgonathRadius, against: string, required: readonly string[]): Promise<ArgonathRadius | string> => {
  const cwd = await homeOf($)
  // Only the tests marked on the runs that changed, and those required, are run, where the command says how to name them
  const job = { home: cwd, label: target.label, tests: target.tests, test: narrowed(target.test, [...new Set([...markedTests(made), ...required])]), from: against }
  const ran = await $.process.run(['python3', `${tidy($.plugin.root)}/handlers/prove.py`], { stdin: JSON.stringify(job), timeoutMs: RUN_TIMEOUT_MS })
  const proof = parseProof(ran.stdout)

  return proof === undefined ? `The proof of ${target.label} could not be made: ${ran.stderr.trim().split('\n').slice(-3).join(' ') || `the prove script exited with ${ran.exitCode}`}` : proved(made, proof, required)
}

/** Runs the tests a change of the target can break, and tells what the change broke from what was broken before. */
const affectedIn = async ($: $, target: ArgonathTarget, against: string): Promise<ReturnType<typeof affectedOf>> => {
  const job = { home: await homeOf($), label: target.label, tests: target.tests, command: target.affected, from: against }
  const ran = await $.process.run(['python3', `${tidy($.plugin.root)}/handlers/affected.py`], { stdin: JSON.stringify(job), timeoutMs: RUN_TIMEOUT_MS }).catch(() => undefined)

  return affectedOf(ran?.stdout ?? '')
}

// `isOwing`: the proof is the session's own, so a settled change is owed the statues when its turn ends; a subagent's is not, as its work may not be done
// `required`: tests written before the change (Galadriel's), each `{ file, name }`, that are to pass on the working tree
type Asked = { target?: string; against: string; isProving: boolean; isOwing?: boolean; required?: readonly { file: string; name: string }[] }

/** What a look found of one target: its radius, or why it has none; no target where the look found none to look at. */
type Looked = { target?: ArgonathTarget; found: ArgonathRadius | string }

// The last proof made, by the change it was made on and what was asked: the same proof asked again is answered from it
let lastProof: { key: string; looked: Looked[] } | undefined

/** Looks again at the targets asked for: what changed in each, and, when asked, whether its tests see it. Answers what was found, a radius or a sentence a target. */
const look = async ($: $, asked: Asked, only?: readonly string[]): Promise<Looked[]> => {
  const list = await setUp($)

  if (list.length === 0) return [{ found: HOW_TO }]
  if (asked.target !== undefined && !list.some(({ label }) => label === asked.target)) return [{ found: `Argonath knows no target named ${asked.target}. It knows ${list.map(({ label }) => label).join(', ')}.` }]

  const chosen = list.filter(({ label }) => (asked.target === undefined || label === asked.target) && (only === undefined || only.includes(label)))
  const wanted = (asked.required ?? []).map(({ file, name }) => `${file}:${name}`).sort().join(',')
  // A proof takes minutes: one asked again of the same change, as a member's last and its mod's next are, is not made twice
  const key = asked.isProving ? `${await wholeFingerprint($)}|${asked.against}|${chosen.map(({ label }) => label).join(',')}|${wanted}` : ''

  if (key !== '' && lastProof?.key === key) {
    if (asked.isOwing !== false) await owe($)

    return lastProof.looked
  }

  const cwd = await homeOf($)
  const found: Looked[] = []
  // The checkouts a handler or a proof makes are no part of the repo: the folder says so itself, before any is made
  const ignore = `${cwd}/${HOME}/.gitignore`
  if (!(await $.fs.exists(ignore).catch(() => false))) await $.fs.write(ignore, '*\n').catch(() => undefined)

  // What each target's folders hold against HEAD, read once: a target the change did not reach is not played at all
  const changes = asked.against === 'HEAD' ? await changesOf($) : new Map<string, string>()

  try {
    for (const target of chosen) {
      const required = requiredOf(target, cwd, asked.required ?? [])
      const isUntouched = changes.has(target.label) && changes.get(target.label) === ''
      let changed: Found | string

      if (isUntouched) changed = { summary: `${target.label}: the change does not reach its folders`, changed: [], unchanged: [] }
      else {
        await update($, working, () => `Playing what ${target.label} keeps on the working tree and on ${asked.against}…`)
        changed = await changedIn($, target, asked.against).catch((error: unknown) => `${target.label} could not be looked at: ${error instanceof Error ? error.message : String(error)}`)
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

          const done = await proveIn($, target, made, asked.against, required)

          made = typeof done === 'string' ? { ...made, unproved: done } : done
        }
      }

      // What the change can break beyond its own runs: the target's own tests, when it reached the target
      if (asked.isProving && target.affected !== '' && !isUntouched) {
        await update($, working, () => `Running what a change of ${target.label} can break…`)

        const broken = await affectedIn($, target, asked.against)

        made = { ...made, regressions: broken.regressions, preexisting: broken.preexisting, unproved: [made.unproved, broken.unproved].filter(said => said !== '').join('\n') }
      }

      const kept = made
      await update($, radii, held => list.flatMap(({ label }) => (label === kept.label ? [kept] : held.filter(one => one.label === label))))
      found.push({ target, found: kept })
    }
  } finally {
    await update($, working, () => '')
  }

  await update($, touched, held => held.filter(label => !chosen.some(target => target.label === label)))
  await update($, note, () => found.flatMap(one => (typeof one.found === 'string' ? [one.found] : [])).join(' '))
  if (found.some(one => typeof one.found !== 'string')) await update($, isHidden, () => false)
  // Kept only when the tree did not move while it was made: a proof of a change it no longer is answers nothing
  if (key !== '') lastProof = key.startsWith(`${await wholeFingerprint($)}|`) ? { key, looked: found } : undefined
  if (asked.isProving && asked.isOwing !== false) await owe($)

  return found
}

/** A proof as a mod reads it: whether it settles the change, and each target's state, with the proof as it reads. */
const proofJson = async ($: $, looked: readonly Looked[]): Promise<string> => {
  const changes = await changesOf($)
  const entries = looked.map(({ target, found }) => ({ label: target?.label ?? '', kind: target?.kind ?? ('' as const), found, isTouched: target === undefined || (changes.get(target.label) ?? '') !== '' }))

  return JSON.stringify({ ...proofAnswer(entries.filter(one => one.label !== '')), ...(entries.some(one => one.label === '') ? { verdict: 'unlooked', line: looked.map(one => one.found).filter((one): one is string => typeof one === 'string').join(' ') } : {}), text: foundText(looked) })
}

// The fingerprint of a settled change the reviews are owed, run once the session is idle; empty when none is
let reviewDue = ''

/** Owes the reviews to the change as it stands, when a proof left no changed run of any target unpinned. */
const owe = async ($: $): Promise<void> => {
  if (reviews.length === 0 || unsettled(await read($, radii)).length > 0) return

  const due = await wholeFingerprint($)

  reviewDue = due === (await read($, reviewed)) ? '' : due
}

/** The whole change as one fingerprint: HEAD, the diff since `against` left it, and the new files by name and content. */
const wholeFingerprint = async ($: $, against = 'HEAD'): Promise<string> => {
  const ran = await $.process.run(['sh', '-c', CHANGE_SCRIPT, 'sh', against], { cwd: await homeOf($) }).catch(() => undefined)

  return fingerprintOf(ran?.stdout ?? '')
}

/** The change as the statues are handed it: the diff since `against` left HEAD, then the new files by name. */
const changeText = async ($: $, against = 'HEAD'): Promise<string> => {
  const ran = await $.process
    .run(['sh', '-c', 'b=$(git merge-base "$1" HEAD) || exit 1; git diff "$b" --no-color --no-ext-diff; echo; echo "New files:"; git ls-files -o --exclude-standard', 'sh', against], { cwd: await homeOf($) })
    .catch(() => undefined)

  return ran?.stdout ?? ''
}

/** Whether a change as `changeText` gives it holds nothing: no diff, and no new file. */
const isNoChange = (change: string): boolean => change.trim() === 'New files:' || change.trim() === ''

/**
 * What the last proof found of the change at hand, for the statues: the runs it altered, and the targets it reached
 * that no kept run sees. Only a radius of the tree as it stands is told; a whole branch has none.
 */
const briefOf = async ($: $, against: string): Promise<string> => {
  if (against !== 'HEAD') return ''

  const fresh = (await read($, radii)).filter(one => !one.isStale)
  const changes = await changesOf($)
  const unreached = fresh.filter(one => one.seams.length === 0 && one.turned.length === 0 && (changes.get(one.label) ?? '') !== '').map(one => one.label)

  return proofBrief(fresh, unreached)
}

/**
 * Sends the statues on the change as it stands, each with its share of the reviews; a change they judged already is
 * not judged again. Answers the judgement, sitting or done. A mod may name a lighter model for a lighter change.
 */
const convene = async ($: $, by: ArgonathJudgement['by'], about = '', only?: readonly string[], against = 'HEAD', model?: string): Promise<ArgonathJudgement> => {
  const due = await wholeFingerprint($, against)
  const held = await read($, judgement)

  reviewDue = ''
  if (held !== null && held.fingerprint === due && (held.against ?? 'HEAD') === against) return held

  await update($, reviewed, () => due)

  const change = await changeText($, against)

  // Nothing to judge: no statue is sent on it
  if (isNoChange(change)) {
    const empty: ArgonathJudgement = { fingerprint: due, at: Date.now(), by, seats: [], against, isEmpty: true }

    await update($, judgement, () => empty)

    return empty
  }

  const seats: ArgonathSeat[] = []
  const brief = await briefOf($, against)

  for (const seat of dealt(reviews).filter(one => only === undefined || only.length === 0 || only.includes(one.name))) {
    const started = await $.agent
      .spawn({ subagentType: `argonath:${seat.name}`, description: `${seat.title} judges the change`, prompt: statuePrompt(seat.reviews, change, about, brief), ...(model !== undefined ? { model } : {}) })
      .catch((error: unknown) => ({ deny: error instanceof Error ? error.message : String(error), agentId: undefined }))

    seats.push({ statue: seat.name, title: seat.title, reviews: seat.reviews, agentId: started.agentId ?? '', state: started.deny === undefined ? 'sitting' : 'silent', findings: [], why: started.deny === undefined ? '' : `it could not be sent: ${started.deny}` })
  }

  const made: ArgonathJudgement = { fingerprint: due, at: Date.now(), by, seats, against }

  await update($, judgement, () => made)

  if (seats.length > 0) $.ui.toast(`Argonath: every changed run is pinned, so ${seats.map(seat => seat.title).join(' and ')} ${seats.length === 1 ? 'judges' : 'judge'} the change`)
  if (verdictOf(made) !== 'sitting') await rise($, made)

  return made
}

/** The statues have judged: the person is shown the verdict, and a Claude whose turn convened them is told it. */
const rise = async ($: $, made: ArgonathJudgement): Promise<void> => {
  const verdict = verdictOf(made)

  if (made.seats.length === 0) return

  $.ui.toast(`Argonath: the change ${verdict === 'pass' ? 'passes' : verdict === 'fail' ? 'is stopped: a finding blocks it' : 'was not judged by every statue'}`)

  if (made.by !== 'turn') return

  await $.prompt
    .submit({ text: `${judgementText(made, false)}\n\n${verdict === 'fail' ? 'Fix what blocks before the change is committed, then prove it again: the statues judge the new change.' : verdict === 'silent' ? 'A statue could not judge: say so to the person.' : 'Mention the minor findings to the person, if any.'}` })
    .catch(() => undefined)
}

/** The seat of a statue whose turn this is: by the id its spawn answered, else, where it answered none, by its type. */
const seatOf = async ($: $, held: ArgonathJudgement, agentId: string): Promise<ArgonathSeat | undefined> => {
  const sitting = held.seats.filter(seat => seat.state === 'sitting')
  const byId = sitting.find(seat => seat.agentId !== '' && seat.agentId === agentId)

  if (byId !== undefined) return byId

  const agent = (await $.agent.list().catch(() => [])).find(one => one.id === agentId)

  return agent === undefined ? undefined : sitting.find(seat => seat.agentId === '' && agent.type === `argonath:${seat.statue}`)
}

/** Sends the statues on the change the reviews are owed, once the turn that settled it has ended. */
const review = async ($: $): Promise<void> => {
  const due = reviewDue

  reviewDue = ''
  if (due === '' || due === (await read($, reviewed))) return
  // The change may have moved on since its proof (a commit, a later edit): what stands now is owed its own proof first
  if ((await wholeFingerprint($)) !== due) return
  // And a change committed whole leaves nothing to judge
  if (isNoChange(await changeText($))) return

  await convene($, 'turn')
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

/**
 * The agent types other mods send to change the tree, each of which has its mod prove the change and convene the
 * statues itself: the Fellowship's members (the Black Gate sends them too), Galadriel's tests, Bombadil.
 */
const SENT_BY_A_MOD = /^(fellowship|lothlorien|bombadil):/

/** The agent types that only read: the council that plans, and the statues. A command of theirs is not looked at for edits. */
const READ_ONLY = /^(elrond|argonath):/

const isReadOnly = async ($: $, agentId: string | undefined): Promise<boolean> => {
  if (agentId === undefined) return false

  const agent = (await $.agent.list().catch(() => [])).find(one => one.id === agentId)

  return agent !== undefined && READ_ONLY.test(agent.type)
}

/** Whether an edit is one another mod's agent made, which that mod has judged: a statue judging it at the turn's end too would judge it twice. */
const isAMods = async ($: $, agentId: string | undefined): Promise<boolean> => {
  if (agentId === undefined) return false

  const agent = (await $.agent.list().catch(() => [])).find(one => one.id === agentId)

  return agent !== undefined && SENT_BY_A_MOD.test(agent.type)
}

/** Marks a target's radius as one of an earlier working tree, and owes it a look once the turn has ended. */
const edited = async ($: $, path: unknown, agentId?: string): Promise<void> => {
  if (typeof path !== 'string' || path === '') return

  const cwd = await homeOf($)
  const whole = /^([A-Za-z]:)?\//.test(tidy(path)) ? tidy(path) : `${cwd}/${tidy(path)}`
  const hit = targetsOf(whole, await read($, targets)).map(({ label }) => label)

  if (hit.length === 0) return

  lastProof = undefined
  // The radius is old either way; a look at the turn's end, and the statues it may send, are owed only to an edit no
  // other mod answers for
  if (!(await isAMods($, agentId))) await update($, touched, held => [...new Set([...held, ...hit])])
  await update($, radii, held => held.map(one => (hit.includes(one.label) && !one.isStale ? { ...one, isStale: true } : one)))
}

/**
 * Where each target's folders stand, by label, cheaply: what git status says of them (from its stat cache, so a large
 * tree costs little), and the size and modification time of each file it names, so a file changed twice is seen
 * twice. Two of these around a shell command say which targets it changed; nothing is read of any file's content.
 */
const fingerprints = async ($: $): Promise<Map<string, string>> => {
  const cwd = await homeOf($)
  const list = await read($, targets)
  const roots = [...new Set(list.flatMap(({ roots }) => roots))]

  if (roots.length === 0) return new Map()

  const ran = await $.process.run(['sh', '-c', STANDING_SCRIPT, 'sh', ...roots], { cwd }).catch(() => undefined)

  return ran === undefined || ran.exitCode !== 0 ? new Map() : standingByTarget(ran.stdout, list, cwd)
}

/** What each target's folders hold against HEAD, by label, read in one go: empty for a target the change did not reach. */
const changesOf = async ($: $): Promise<Map<string, string>> => {
  const cwd = await homeOf($)
  const list = await read($, targets)
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
const settle = async ($: $): Promise<void> => {
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
const isLit = async ($: $): Promise<boolean> => unsettled(await read($, radii)).length > 0 && !(await read($, isHidden))

/** One beat of the glow, while the band is lit: a dark band redraws nothing. */
const beat = async ($: $): Promise<void> => {
  if (await isLit($)) await update($, glow, was => (was + 1) % BEATS.length)
}

/** Each unsettled target in a few words, for the band: `gondor 1 bare · narsil 3 marked`. */
const bandLine = (all: readonly ArgonathRadius[]): string =>
  unsettled(all)
    .map(one => `${one.label} ${radiusLine(one).split(' · ').slice(1).filter(part => !part.includes('changed')).join(' · ')}${one.isStale ? ' (before the last edit)' : ''}`)
    .join('  │  ')

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'argonath', description: 'Open the pane of what the uncommitted change reached in each target the project builds, and which of it an integration test pins' })

    // A host that registers no tools still starts the session
    for (const tool of [view.tool, ...TOOLS]) await $.tool.register(tool).catch(() => undefined)

    // The statues judge a settled change; Claude never sends one, and the mod sends them on nothing else
    for (const statue of STATUES) {
      await $.agent
        .register({
          name: statue.name,
          description: `${statue.title}, a statue of the Argonath: judges a change every integration test pins, read-only. Sent by the Argonath mod alone.`,
          prompt: statueSystem(statue.title),
          tools: ['Read', 'Grep', 'Glob', 'Bash', 'Skill'],
          disallowedTools: ['Edit', 'Write', 'NotebookEdit', 'Agent'],
          model: STATUE_MODEL,
          effort: STATUE_EFFORT,
        })
        .catch(() => undefined)
    }

    await setUp($).catch(() => [])
    $.clock.every(BEAT_MS, () => void beat($).catch(() => undefined))
    $.clock.every(OWED_MS, () => void settle($).catch(() => undefined))

    return next(e)
  })

  // Claude is told which tests are owed: one for each run that changed, and none beyond
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)

    return known.length === 0 ? composed : { sections: [...composed.sections, { id: 'argonath:radius', text: sectionText(known, await homeOf($)), scope: 'session' as const }] }
  })

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
    if ((await read($, targets)).length === 0 || (await isReadOnly($, e.agentId))) return next(e)

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

  for (const statue of STATUES) on('agent.offer', { agent: `argonath:${statue.name}` }, () => ({ isOffered: false }))

  // A statue judges and changes nothing: a command that would change the tree or the machine is refused it
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const held = await read($, judgement)

    if (held === null || e.agentId === undefined || (await seatOf($, held, e.agentId)) === undefined) return next(e)
    if (isChanging(e.command)) return { deny: 'A statue of the Argonath judges the change and changes nothing: run only commands that read.' }

    return next(e)
  }).catch((_$, e, next) => next(e))

  // A statue's turn has ended: its answer is its findings. The session's own turn has ended: what it edited is looked at
  on('turn.complete', async ($, e, next) => {
    const held = await read($, judgement)
    const seat = held === null || e.agentId === undefined ? undefined : await seatOf($, held, e.agentId)

    if (held !== null && seat !== undefined) {
      const made = { ...held, seats: held.seats.map(one => (one === seat ? seated(one, e.answer ?? '', e.isAborted ? 'aborted' : e.reason) : one)) }

      await update($, judgement, () => made)
      if (verdictOf(made) !== 'sitting') await rise($, made)
    }

    // A subagent's turn is not the session's: its edits wait for the turn that spawned it
    // A proof Claude asked for during the turn may have owed the reviews: they too wait for the turn to end
    if (e.agentId === undefined && !e.isAborted && ((await read($, touched)).length > 0 || reviewDue !== '')) isOwed = true

    return next(e)
  })

  on('tool.call', { tool: 'mcp__argonath__pane' }, $ => view.answer(() => $.ui.panes()))

  on('tool.call', { tool: 'mcp__argonath__radius' }, async ($, e) => ({ result: foundText(await look($, askedOf(e, false))) }))

  on('tool.call', { tool: 'mcp__argonath__prove' }, async ($, e) => {
    const given = e as unknown as { owe?: unknown; json?: unknown }
    // A subagent's proof waits for the turn that sent it; a mod that convenes the statues itself says it owes none
    const isOwing = e.agentId === undefined && given.owe !== false
    const looked = await look($, { ...askedOf(e, true), isOwing })

    return { result: given.json === true ? await proofJson($, looked) : foundText(looked) }
  })

  on('tool.call', { tool: 'mcp__argonath__judgement' }, async ($, e) => {
    const given = e as unknown as { convene?: unknown; json?: unknown; about?: unknown; statues?: unknown; against?: unknown; model?: unknown }
    const isJson = given.json === true
    const against = typeof given.against === 'string' && given.against.trim() !== '' ? given.against.trim() : 'HEAD'

    if (given.convene === true) {
      await setUp($)

      // A whole branch is judged once its every change was proved: only the change at hand waits on a proof
      const open = against === 'HEAD' ? unsettled(await read($, radii)) : []

      if (open.length > 0) return { result: isJson ? JSON.stringify({ verdict: 'unsettled', targets: open.map(one => one.label) }) : `A changed run of ${open.map(one => one.label).join(', ')} is not pinned: the statues judge only a settled change. Prove it first.` }

      const model = typeof given.model === 'string' && /^[\w.-]+$/.test(given.model) ? given.model : undefined

      await convene($, 'tool', typeof given.about === 'string' ? given.about : '', Array.isArray(given.statues) ? given.statues.filter((one): one is string => typeof one === 'string') : undefined, against, model)
    }

    const held = await read($, judgement)
    const isStale = held !== null && held.fingerprint !== (await wholeFingerprint($, held.against ?? 'HEAD'))

    return { result: isJson ? judgementJson(held, isStale) : held === null ? 'The statues have judged no change yet: they judge one once every changed run is pinned.' : judgementText(held, isStale) }
  })

  on('tool.call', { tool: 'mcp__argonath__targets' }, async $ => {
    const cwd = await homeOf($)
    const within = (path: string) => (path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path)

    return { result: JSON.stringify((await setUp($)).map(({ label, kind, roots }) => ({ label, kind, roots: roots.map(within) }))) }
  })

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
