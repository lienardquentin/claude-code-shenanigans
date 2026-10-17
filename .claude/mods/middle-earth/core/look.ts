import { testsDiffOf } from './change'
import type { Ran, Shell } from './forge'
import { PROJECT_FILE, affectedOf, gateOf, gated, isNarrowable, isProd, isTested, manifestsOf, markedTests, marksOf, narrowed, parseDiffText, parseLiveAnswer, parseProof, parseServiceAnswer, proved, radiusOf, requiredOf, weakenedOf, withLive } from './proof'
import type { Changed, Radius, Target } from './proof'

// A look at what a change did to each target it reached: what changed in what the target does, by the handler of
// its kind, and, for a proof, whether its tests pin it, what it breaks, and what its checks say. What it runs, reads
// and keeps goes through the machine it is handed, so the same look serves the mod and a runner outside Claude Code.

/** The handler scripts a look runs, each handed its job as JSON. */
export type Handler = 'prove' | 'affected' | 'service' | 'live'

/** What a look runs and reads. None of it rejects: a failure answers why. */
export type Machine = {
  /** Runs git and the like in the folder looked at. */
  shell: Shell
  /** A file's text; nothing where it cannot be read. */
  read: (path: string) => Promise<string | undefined>
  /** Runs a handler script with its job. */
  handle: (handler: Handler, job: unknown) => Promise<Ran>
  /** What the run recorder said of a CLI's kept runs on the working tree and on `against`, or why it could not say. */
  keptRuns: (target: Target, against: string) => Promise<{ said: string } | { why: string }>
  now: () => Promise<number>
  /** Says what the look is doing; empty once it is done. */
  say: (doing: string) => Promise<void>
  /** Keeps each target's radius as soon as it is made, for whoever shows it. */
  keep: (radius: Radius) => Promise<void>
}

/** What a look is asked. */
export type Look = {
  /** The targets to look at, of those the place knows. */
  chosen: readonly Target[]
  /** The commit the working tree is compared with. */
  against: string
  /** Whether the tests, the affected tests and the checks are run too. */
  isProving: boolean
  /** Tests written before the change (tests first), each to pass on the working tree. */
  required: readonly { file: string; name: string }[]
  /** The folder looked at. */
  tree: string
  /** The project's own folder, where the tree is a quest's worktree: its service plays against the project's database. */
  project?: string
  /** What each target's folders hold against HEAD; a target it says is empty is not played. None read against another commit. */
  changes: Map<string, string>
}

/** What a look found of one target: its radius, or why it has none. */
export type Looked = { target: Target; found: Radius | string }

/** What a handler found, and for a service with a live stage, what that stage found in a line. */
export type Found = Changed & { live?: string }

// How many test files are read for marks
const READ_FILES = 300

const lastLines = (said: string, lines: number): string => said.trim().split('\n').slice(-lines).join(' ')

/** Every mark in the files a target names as tests: what git tracks there, and what it neither tracks nor ignores. */
export const marksIn = async (machine: Machine, tree: string, target: Target): Promise<{ line: string; test: string }[]> => {
  if (target.tests.length === 0) return []

  const listed = await machine.shell.run(['git', 'ls-files', '-co', '--exclude-standard', '--', ...target.tests])
  const paths = (listed.exitCode === 0 ? listed.stdout.split('\n') : []).map(path => path.trim()).filter(path => path !== '')
  const marks: { line: string; test: string }[] = []

  for (const path of paths.slice(0, READ_FILES)) marks.push(...marksOf((await machine.read(`${tree}/${path}`)) ?? ''))

  return marks
}

/** What a service's handler is handed: the target's kept requests, both builds, and the project's folder for a quest's worktree. */
export const serviceJob = (target: Target, against: string, tree: string, project?: string) => ({
  home: tree,
  ...(project !== undefined ? { project } : {}),
  label: target.label,
  app: target.app,
  python: target.python,
  env: target.env,
  masks: target.masks,
  requests: target.requests,
  from: against,
  roots: target.roots,
  db: target.db,
  ready: target.ready,
})

/** A CLI's kept runs, played on both builds by the run recorder: what changed, or why it could not say. */
const cliChanged = async (machine: Machine, target: Target, against: string): Promise<Changed | string> => {
  const answered = await machine.keptRuns(target, against)

  if ('why' in answered) return answered.why

  // What the recorder says in place of a comparison is why there is no radius
  return parseDiffText(answered.said) ?? (answered.said !== '' ? answered.said : 'anduril answered nothing to read.')
}

/**
 * A service's kept requests, played in-process on both builds, standing alone; then, where the project says where it
 * is deployed, on both builds again against its real dependencies.
 */
const serviceChanged = async (machine: Machine, target: Target, look: Look): Promise<Found | string> => {
  if (target.app === '') return `${target.label} names no app: say it as service:module:app, gondor=service:gondor.app:app@beacons/gondor.`
  if (target.requests.length === 0) return `No request of ${target.label} is kept to play. Keep one with a line in ${PROJECT_FILE}: $ ${target.label} GET /health`

  // A quest's worktree plays against the project's warm database, which the project's folder names
  const job = serviceJob(target, look.against, look.tree, look.project)
  const played = await machine.handle('service', job)
  const fast = parseServiceAnswer(played.stdout) ?? `The requests could not be played: ${lastLines(played.stderr, 3) || `the service handler exited with ${played.exitCode} and said nothing`}`

  if (typeof fast === 'string' || target.live === null) return fast

  // A context that names prod is never touched: the handler, which refuses it too, is not even started
  if (isProd(target.live.workload)) return { ...fast, live: `Live: not played, the context of ${target.live.workload} names prod, and Argonath reads nothing from it and runs nothing in it` }

  await machine.say(`Playing what ${target.label} keeps on both builds against its real dependencies, on ${target.live.workload}…`)

  const live = await machine.handle('live', { ...job, live: target.live })
  const found = parseLiveAnswer(live.stdout) ?? { where: target.live.workload, skipped: '', error: lastLines(live.stderr, 2) || `the live handler exited with ${live.exitCode}`, cases: [] }
  const merged = withLive(fast, found)

  return { ...merged.changed, live: merged.line }
}

/** What changed in what one target does, by the handler of its kind. */
const changedIn = (machine: Machine, target: Target, look: Look): Promise<Found | string> =>
  target.kind === 'cli'
    ? cliChanged(machine, target, look.against)
    : target.kind === 'service'
      ? serviceChanged(machine, target, look)
      : Promise.resolve({ summary: `${target.label} is a frontend: Argonath compares no kept run of it, so what changed in what it does is not known, and its tests and checks alone are run`, changed: [], unchanged: [] })

/** Runs a target's tests on both sides, and says where each changed run, and each test required, stands. */
const proveIn = async (machine: Machine, target: Target, made: Radius, look: Look, required: readonly string[]): Promise<Radius | string> => {
  // Only the tests marked on the runs that changed, and those required, are run, where the command says how to name them
  const job = { home: look.tree, label: target.label, tests: target.tests, test: narrowed(target.test, [...new Set([...markedTests(made), ...required])]), from: look.against }
  const ran = await machine.handle('prove', job)
  const proof = parseProof(ran.stdout)

  return proof === undefined ? `The proof of ${target.label} could not be made: ${lastLines(ran.stderr, 3) || `the prove script exited with ${ran.exitCode}`}` : proved(made, proof, required)
}

/** What one target's radius is, and, for a proof, what its tests, affected tests and checks say of it. */
const lookAtOne = async (machine: Machine, target: Target, look: Look): Promise<Radius | string> => {
  const required = requiredOf(target, look.tree, look.required)
  const isUntouched = look.changes.has(target.label) && look.changes.get(target.label) === ''
  let changed: Found | string

  if (isUntouched) changed = { summary: `${target.label}: the change does not reach its folders`, changed: [], unchanged: [] }
  else {
    await machine.say(`Playing what ${target.label} keeps on the working tree and on ${look.against}…`)
    changed = await changedIn(machine, target, look).catch((error: unknown) => `${target.label} could not be looked at: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (typeof changed === 'string') return changed

  let made: Radius = { ...radiusOf({ label: target.label, kind: target.kind, at: await machine.now(), diff: changed, marks: isUntouched ? [] : await marksIn(machine, look.tree, target) }), live: changed.live ?? '', ...(target.kind === 'frontend' && !isUntouched ? { isUnhandled: true } : {}) }

  if (!look.isProving) return made

  // A proof runs only the tests marked on what changed, and those required: with none, there is nothing to run
  if (markedTests(made).length > 0 || required.length > 0) {
    if (!isTested(target)) made = { ...made, unproved: `${target.label} names no tests to prove: ${target.label}.tests and ${target.label}.test in ${PROJECT_FILE}.` }
    // A command that cannot be narrowed would run tests out of scope: it is not run at all
    else if (!isNarrowable(target.test)) made = { ...made, unproved: `${target.label}.test in ${PROJECT_FILE} has no {tests} for the tests to run, so none is run: every test it holds would be, the ones out of scope with them. Name them as its runner takes them, -k "{tests: or }" for pytest, -- --exact {tests} for cargo.` }
    else {
      await machine.say(`Running the tests of ${target.label} on ${look.against}'s source and on the working tree…`)

      const done = await proveIn(machine, target, made, look, required)

      made = typeof done === 'string' ? { ...made, unproved: done } : done
    }
  }

  // What the change can break beyond its own runs: the target's own tests, when it reached the target
  if (target.affected !== '' && !isUntouched) {
    await machine.say(`Running what a change of ${target.label} can break…`)

    const ran = await machine.handle('affected', { home: look.tree, label: target.label, tests: target.tests, command: target.affected, from: look.against })
    const broken = affectedOf(ran.stdout)

    made = { ...made, regressions: broken.regressions, preexisting: broken.preexisting, unproved: [made.unproved, broken.unproved].filter(said => said !== '').join('\n') }
  }

  // Its checks, when it reached the target, and the audit of its dependencies when it touched their manifests; and
  // what it does to the target's tests, wherever they are
  const manifests = manifestsOf(look.changes.get(target.label) ?? '')
  const checks = target.checks.map((command, index) => ({ name: target.checks.length === 1 ? `${target.label}.check` : `${target.label}.check #${index + 1}`, command }))
  const audits = target.audit !== '' && manifests.length > 0 ? [{ name: `${target.label}.audit`, command: target.audit }] : []
  const gates = isUntouched ? [] : [...checks, ...audits]
  const found: ReturnType<typeof gateOf>[] = []

  for (const gate of gates) {
    await machine.say(`Running ${gate.name} on the working tree…`)

    // Run on the working tree, and on the commit's source where it fails there, as the affected tests are
    const ran = await machine.handle('affected', { home: look.tree, label: target.label, tests: [], command: gated(gate.command, look.against), from: look.against })

    found.push(gateOf(ran.stdout, gate.name))
  }

  return {
    ...made,
    gates: found.map(one => one.broken).filter(said => said !== ''),
    gatesBefore: found.map(one => one.before).filter(said => said !== ''),
    unproved: [made.unproved, ...found.map(one => one.unproved)].filter(said => said !== '').join('\n'),
    weakened: weakenedOf(await testsDiffOf(machine.shell, target)),
    manifests,
  }
}

/** Looks at each target chosen in turn, keeping each radius as it is made. Says nothing more once it is done. */
export const lookAt = async (machine: Machine, look: Look): Promise<Looked[]> => {
  const found: Looked[] = []

  try {
    for (const target of look.chosen) {
      const one = await lookAtOne(machine, target, look)

      if (typeof one !== 'string') await machine.keep(one)
      found.push({ target, found: one })
    }
  } finally {
    await machine.say('')
  }

  return found
}
