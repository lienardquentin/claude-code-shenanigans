import type { ChangedRun, ProofState, Radius, RunState, Target, TestResult } from '../../types'
import { MARK } from './project'

// What a proof comes to: each target's state, the verdict in a line, and what the reviewers are handed of it.

/** Where one target stands in a proof: see `ProofState`. */
export const proofStateOf = (found: Radius | string, kind: Target['kind'] | undefined, isTouched: boolean): ProofState => {
  if (typeof found === 'string') return !isTouched ? 'untouched' : kind === 'frontend' ? 'unhandled' : 'unlooked'

  const isClean = isQuiet(found) && found.unproved === ''

  // No kept run of it is compared: nothing proves what it does, and its tests and checks can still hold the change
  if (found.isUnhandled === true && isTouched) return isClean ? 'unhandled' : 'unsettled'

  if (found.seams.length === 0 && isClean) return isTouched ? 'unreached' : 'unchanged'

  return isClean ? 'pinned' : 'unsettled'
}

/** A proof as a mod reads it: whether it settles the change, why in a line, and each target's state. */
export type ProofAnswer = {
  verdict: 'settled' | 'unsettled' | 'unlooked'
  line: string
  targets: { label: string; kind: Target['kind'] | ''; state: ProofState; why: string }[]
  /** The targets the change reached that nothing proves: a reviewer judges them alone. */
  unhandled: string[]
  /** The targets the change reached where no kept run answers otherwise: a refactor, or behaviour no kept run reaches. */
  unreached: string[]
}

/** What a proof comes to, from each target's radius or why it has none. */
export const proofAnswer = (entries: readonly { label: string; kind: Target['kind'] | ''; found: Radius | string; isTouched: boolean }[]): ProofAnswer => {
  const targets = entries.map(({ label, kind, found, isTouched }) => ({ label, kind, state: proofStateOf(found, kind === '' ? undefined : kind, isTouched), why: typeof found === 'string' ? found : found.unproved }))
  const radii = entries.map(({ found }) => found).filter((found): found is Radius => typeof found !== 'string')
  const unlooked = targets.filter(one => one.state === 'unlooked')
  const unhandled = targets.filter(one => one.state === 'unhandled').map(one => one.label)
  // A target no kept run sees, or one with changed lines no kept run ran
  const unreached = entries.filter(({ found }, at) => targets[at]?.state === 'unreached' || (typeof found !== 'string' && unreachedText(found) !== '')).map(one => one.label)
  const counts = (['bare', 'marked', 'loose', 'broken'] as const).flatMap(state => {
    const many = radii.reduce((sum, radius) => sum + radius.seams.filter(seam => seam.state === state).length, 0)

    return many > 0 ? [`${many} ${state}`] : []
  })
  const isTurned = radii.some(radius => radius.turned.length > 0)
  const unproved = targets.filter(one => one.state === 'unsettled' && one.why !== '')

  const not = (verdict: ProofAnswer['verdict'], line: string): ProofAnswer => ({ verdict, line, targets, unhandled, unreached })

  if (entries.length === 0) return not('unlooked', 'Verify knows no target to prove')
  if (unlooked.length > 0) return not('unlooked', `Verify could not look at ${unlooked.map(one => `${one.label} (${one.why})`).join('; ')}`)
  const regressions = radii.flatMap(radius => radius.regressions ?? [])
  const unmetTests = radii.flatMap(radius => unmet(radius).map(test => test.name))

  if (counts.length > 0) return not('unsettled', `not pinned yet: ${counts.join(', ')}`)
  if (isTurned) return not('unsettled', 'a test that passed on the commit fails on the working tree')
  if (regressions.length > 0) return not('unsettled', `the change breaks ${regressions.length === 1 ? 'a test' : `${regressions.length} tests`}: ${regressions.slice(0, 5).join(', ')}`)
  const gates = radii.flatMap(radius => radius.gates ?? [])

  if (gates.length > 0) return not('unsettled', `the change fails ${gates.map(gate => gate.split(' ')[0] ?? gate).join(', ')}`)
  if (unmetTests.length > 0) return not('unsettled', `${unmetTests.length === 1 ? 'a test' : `${unmetTests.length} tests`} written before the change ${unmetTests.length === 1 ? 'does' : 'do'} not pass yet: ${unmetTests.slice(0, 5).join(', ')}`)
  if (unproved.length > 0) return not('unsettled', `Verify could not prove ${unproved.map(one => one.label).join(', ')}: ${unproved[0]?.why ?? ''}`)

  const isPinned = targets.some(one => one.state === 'pinned')
  const said = isPinned ? 'every changed run is pinned' : 'no kept run changed: nothing to pin'
  // A change no kept run sees settles, as a refactor does, but is said: the reviewers are left to tell a refactor from new behaviour
  const where = (label: string) => {
    const found = entries.find(one => one.label === label)?.found
    const lines = found === undefined || typeof found === 'string' ? '' : unreachedText(found)

    return lines === '' ? label : `${label} (${lines})`
  }
  const caveats = [...(unreached.length > 0 ? [`no kept run reaches what changed in ${unreached.map(where).join(', ')}`] : []), ...(unhandled.length > 0 ? [`nothing proves ${unhandled.join(', ')}`] : [])]

  return not('settled', [said, ...caveats].join('; '))
}

// How much of a changed run's evidence, and of the whole proof, the reviewers are handed
export const BRIEF_EVIDENCE = 1_500

export const BRIEF_CHARS = 12_000

/**
 * What a proof found, as the reviewers are handed it: each run whose answer changed, the tests that pin it and how it
 * answers now against before, and the targets the change reached that no kept run sees. Empty when there is nothing.
 */
export const proofBrief = (radii: readonly Radius[], unreached: readonly string[]): string => {
  const lines = [
    ...radii.flatMap(radius =>
      radius.seams.map(seam => {
        const evidence = seam.evidence.trim()
        const shown = evidence.length > BRIEF_EVIDENCE ? `${evidence.slice(0, BRIEF_EVIDENCE)}\n… (cut)` : evidence

        return [`- ${radius.label}: ${seam.line} (${seam.state}${seam.tests.length > 0 ? `, by ${seam.tests.map(test => test.name).join(', ')}` : ''})`, ...(shown !== '' ? shown.split('\n').map(line => `    ${line}`) : [])].join('\n')
      }),
    ),
    ...unreached.map(label => `- ${label}: the change reached its source, but no kept run of it answers otherwise. No integration test proves this part of the change.`),
    ...radii.filter(radius => unreachedText(radius) !== '').map(radius => `- ${radius.label}: changed lines no kept run ran, so no integration test checks them: ${unreachedText(radius)}.`),
    ...radii.flatMap(radius => (radius.weakened ?? []).map(one => `- ${radius.label}: a test weakened, ${one}. Blocking unless what the change is for takes away the behaviour it tested.`)),
    ...radii.flatMap(radius => ((radius.manifests ?? []).length > 0 ? [`- ${radius.label}: the change touches its dependency manifests (${(radius.manifests ?? []).join(', ')}). A dependency it adds or moves is a finding unless what the change is for needs it; one that is unmaintained, typo-squatted or pulled from outside the registry is blocking.`] : [])),
  ].join('\n')

  return lines.length > BRIEF_CHARS ? `${lines.slice(0, BRIEF_CHARS)}\n… (cut)` : lines
}

/** How many changed runs stand in each state. */
export const tally = (radius: Radius): Record<RunState, number> => {
  const counts: Record<RunState, number> = { bare: 0, marked: 0, pinned: 0, loose: 0, broken: 0 }
  for (const seam of radius.seams) counts[seam.state] += 1

  return counts
}

export const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`

/** The required tests that do not pass on the working tree. */
export const unmet = (radius: Radius): TestResult[] => (radius.required ?? []).filter(test => test.to !== 'pass')

/**
 * Whether nothing is owed: every changed run pinned, no test turned, none broken by the change, every required test
 * passing on the working tree, and no check or audit the change newly fails.
 */
export const isQuiet = (radius: Radius): boolean =>
  radius.seams.every(seam => seam.state === 'pinned') && radius.turned.length === 0 && (radius.regressions ?? []).length === 0 && unmet(radius).length === 0 && (radius.gates ?? []).length === 0

/** The changed lines no kept run ran, as `beacons/gondor/archive.py 93; beacons/gondor/app.py 10-12`. */
export const unreachedText = (radius: Pick<Radius, 'unreached'>): string =>
  Object.entries(radius.unreached ?? {})
    .map(([file, spans]) => `${file} ${spans}`)
    .join('; ')

/** The radius in a line: how many kept runs changed and where they stand, and the tests that turned. */
export const radiusLine = (radius: Radius): string => {
  const counts = tally(radius)
  const states = (['pinned', 'marked', 'loose', 'broken', 'bare'] as const).filter(state => counts[state] > 0).map(state => `${counts[state]} ${state}`)

  // A service keeps requests, any other target runs
  const kept = radius.kind === 'service' ? 'request' : 'run'

  return radius.seams.length === 0
    ? `${radius.label}: no kept ${kept} changed`
    : [`${radius.label}: ${plural(radius.seams.length, `kept ${kept}`, `kept ${kept}s`)} changed`, ...states, ...(radius.turned.length > 0 ? [plural(radius.turned.length, 'test turned', 'tests turned')] : [])].join(' · ')
}

/** What the live stage writes above what it saw: a run whose evidence starts with it changed only with the real dependencies. */
export const LIVE_EVIDENCE = 'live, with the real dependencies:'

/** Whether a run changed only with the real dependencies: the fast stage, which runs without them, saw it answer as before. */
export const isLiveOnly = (seam: ChangedRun): boolean => seam.evidence.startsWith(LIVE_EVIDENCE)

/** What a changed run's state asks for, as a sentence. */
export const owed = (seam: ChangedRun): string => {
  const names = seam.tests.map(test => test.name).join(', ')

  return {
    // A change is not always meant: one that was not is a regression, and owes a fix rather than a test
    bare: isLiveOnly(seam)
      ? `it answered otherwise only with the real dependencies, so no test that runs without them can pin it. If that is not meant, it is a regression: fix the code. If it is, pin it with a test that runs against the real dependencies, marked \`${MARK} ${seam.line}\`; none is named for this target.`
      : `no test marked. Meant: write one that makes this run and asserts what it now answers, \`${MARK} ${seam.line}\` above it. Not meant: a regression, fix the code.`,
    marked: `marked by ${names}, not proved yet.`,
    pinned: `pinned by ${names}.`,
    loose: `${names} ${seam.tests.length === 1 ? 'passes' : 'pass'} on both sides, so ${seam.tests.length === 1 ? 'it does' : 'they do'} not see the change: assert what changed.`,
    broken: `${seam.tests.filter(test => test.to === 'fail').map(test => test.name).join(', ')} ${seam.tests.filter(test => test.to === 'fail').length === 1 ? 'fails' : 'fail'} on the working tree.`,
  }[seam.state]
}

// How many lines of a changed run's evidence the model is shown: enough to see what changed, not a whole body
export const EVIDENCE_LINES = 16

export const capped = (evidence: string): string[] => {
  const lines = evidence.split('\n').filter(line => line !== '')

  return [...lines.slice(0, EVIDENCE_LINES), ...(lines.length > EVIDENCE_LINES ? [`… ${lines.length - EVIDENCE_LINES} more lines`] : [])].map(line => `  ${line}`)
}

/**
 * The radius for the model, as short as it can be said: each run still owed something with what it owes and how it
 * changed, each pinned one in a line, then what else the proof found. What did not change is a count.
 */
export const radiusText = (radius: Radius): string => {
  const kept = radius.kind === 'service' ? 'request' : 'run'
  const open = radius.seams.filter(seam => seam.state !== 'pinned')
  const pinned = radius.seams.filter(seam => seam.state === 'pinned')
  const regressions = radius.regressions ?? []
  const preexisting = radius.preexisting ?? []
  const unmetTests = unmet(radius)
  const lines = unreachedText(radius)

  return [
    `${radius.summary}.`,
    ...(radius.live !== '' ? [`${radius.live}.`] : []),
    ...(radius.seams.length > 0 ? [`${radiusLine(radius)}.`] : []),
    ...(radius.isStale ? ['A file was edited since: this is of an earlier working tree.'] : []),
    ...open.flatMap(seam => ['', `${seam.state}: ${seam.line}`, `  ${owed(seam)}`, ...capped(seam.evidence)]),
    ...(pinned.length > 0 ? ['', ...pinned.map(seam => `pinned: ${seam.line} (by ${seam.tests.map(test => test.name).join(', ')})`)] : []),
    ...(radius.turned.length > 0 ? ['', `Passing on the commit's source, failing on the working tree: ${radius.turned.join(', ')}. Bring each to what the code now does, or fix the regression it shows.`] : []),
    ...(regressions.length > 0 ? ['', `Broken by the change (they pass on the commit's source): ${regressions.join(', ')}. Fix the code, or the test where the change is meant.`] : []),
    ...(preexisting.length > 0 ? [`Failing before the change too, and not owed by it: ${preexisting.join(', ')}.`] : []),
    ...(unmetTests.length > 0 ? ['', `Written before the change, and not passing yet: ${unmetTests.map(test => `${test.name} (${test.to === 'none' ? 'not run' : test.to === 'skip' ? 'skipped by its runner' : 'fails'})`).join(', ')}.`] : []),
    ...(lines !== '' ? ['', `Changed lines no kept ${kept} ran: ${lines}. Where one is behaviour a caller sees, keep a ${kept} that reaches it and pin it.`] : []),
    ...(radius.gates ?? []).flatMap(gate => ['', `${gate}`, 'Fix what it finds in the change.']),
    ...(radius.gatesBefore ?? []),
    ...((radius.weakened ?? []).length > 0 ? ['', 'The change weakens tests: a test taken out or skipped is blocking unless what the change is for takes the behaviour it tested away.', ...(radius.weakened ?? []).map(one => `- ${one}`)] : []),
    ...((radius.manifests ?? []).length > 0 ? ['', `Dependency manifests the change touches: ${(radius.manifests ?? []).join(', ')}. A dependency added or bumped is judged as part of the change.`] : []),
    ...(radius.unproved !== '' ? ['', radius.unproved] : []),
    ...(radius.seams.length === 0 && regressions.length === 0 && unmetTests.length === 0 && radius.isUnhandled !== true ? [`No kept ${kept} answered otherwise: no integration test is owed.`] : []),
    ...(radius.unchanged.length > 0 ? [`${radius.unchanged.length} other kept ${radius.unchanged.length === 1 ? kept : `${kept}s`} answered as before.`] : []),
  ].join('\n')
}
