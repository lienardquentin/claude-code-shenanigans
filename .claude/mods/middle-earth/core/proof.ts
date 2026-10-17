export type { ChangedRun, Database, LiveStage, Outcome, ProofState, Radius, RunState, Target, TargetKind, TestResult } from '../types'
import type { ChangedRun, Outcome, ProofState, Radius, RunState, Target, TargetKind, TestResult } from '../types'

// What a project builds and how each is tested, which target an edit is of, what a handler said changed, which test
// is marked on which run, and how a test ended on each side. Text in, text out: nothing here touches the machine.

/** The project's own list of what it builds, beside its other Claude files. */
export const PROJECT_FILE = '.claude/argonath'

/** Where the checkouts a look plays and proves in are kept, under the working directory: per machine, never committed. */
export const HOME = '.argonath'

/** What a comment above a test says to mark it on a kept run: `sting: narsil show 999`. */
export const MARK = 'sting:'

/** A path with forward slashes and no trailing one, so two spellings of a folder compare equal. */
export const tidy = (path: string): string => path.replace(/\\/g, '/').replace(/\/+$/, '')

const under = (cwd: string, path: string): string => (/^([A-Za-z]:)?\//.test(tidy(path)) ? tidy(path) : `${tidy(cwd)}/${tidy(path).replace(/^\.\//, '')}`)

const KINDS: readonly TargetKind[] = ['cli', 'service', 'frontend']

/**
 * What a project's file says, a line each and a `#` line a comment:
 *
 * - `label=kind@root,root`: a target, `cli`, `service:module:app` (a service's app as Python imports it) or
 *   `frontend`, and the folders whose edits are edits of it;
 * - `label.tests=path,path` and `label.test=command`: its integration tests, and how they are run from the project's
 *   folder, each test named as it ends;
 * - `label.python=folder`: a service's Python folder, put on the path and its uv project when it has one;
 * - `label.env=NAME=value`: what a service is played with, the same on both builds;
 * - `label.mask=regex`: what to leave out of its answers when two builds are compared;
 * - `label.db=image`, `label.db.env=NAME`, `label.db.setup=command`: a service's database, each build played against
 *   one of its own in a warm container of that Postgres image, its address in NAME, made ready by the command;
 * - `label.ready=METHOD /path` and `label.ready.match=regex`: asked before a service is played, until it answers;
 * - `label.affected=command`: the tests a change of the target can break, run when its folders changed;
 * - `label.check=command`: its lint, type and format checks, run when its folders changed: the change may not newly
 *   fail it. `{against}` in it is the commit the change is compared with. Named again, each is a check of its own, run
 *   and judged apart (`label.check #1`, `#2`), so that one failing before the change hides none the change fails;
 * - `label.audit=command`: what audits its dependencies, run when the change touches a dependency manifest in its
 *   folders: the change may not newly fail it;
 * - `$ label …`: a service's request kept to be played, `$ gondor GET /health`, with a JSON body as one quoted word
 *   after its path, `$ gondor POST /beacons/eilenach/light '{"keeper": "Hirgon"}'`. A CLI's runs are anduril's to keep.
 *
 * What does not read is left out, and a setting of a target the file does not name is dropped.
 */
export const parseProject = (text: string, cwd: string): Target[] => {
  const targets = new Map<string, Target>()
  const settings: [string, string, string][] = []
  const requests: string[] = []

  for (const raw of text.split('\n')) {
    const line = raw.trim()
    const kept = /^\$\s+(.+)$/.exec(line)
    // The shortest label that reads: `gondor.live.env` is gondor's `live.env`, not a `gondor.live`'s `env`
    const set = /^([\w.-]+?)\.(tests|test|python|env|mask|affected|check|audit|ready|ready\.match|db|db\.env|db\.setup|live|live\.forward|live\.env|live\.db|live\.before|live\.cleanup|live\.restore|live\.scratch)\s*=\s*(.*)$/.exec(line)
    const named = /^([\w.-]+)\s*=\s*(cli|service|frontend)(?::([^@]*))?\s*@\s*(.+)$/.exec(line)

    if (line === '' || line.startsWith('#')) continue

    if (kept !== null) requests.push(kept[1] ?? '')
    else if (set !== null) settings.push([set[1] ?? '', set[2] ?? '', (set[3] ?? '').trim()])
    else if (named !== null) {
      const [, label = '', kind = 'cli', app = '', roots = ''] = named

      targets.set(label, {
        label,
        kind: KINDS.find(one => one === kind) ?? 'cli',
        roots: roots.split(',').map(root => root.trim()).filter(root => root !== '').map(root => under(cwd, root)),
        tests: [],
        test: '',
        app: kind === 'service' ? app.trim() : '',
        python: '',
        env: {},
        masks: [],
        requests: [],
        live: null,
        db: null,
        ready: null,
        affected: '',
        checks: [],
        audit: '',
      })
    }
  }

  for (const [label, what, value] of settings) {
    const target = targets.get(label)

    if (target === undefined) continue
    if (what.startsWith('live')) {
      // The workload makes a live stage; what goes with it is kept for it, the order of the lines aside
      target.live ??= { workload: '', forward: [], env: {}, db: '', before: '', cleanup: [], restore: '', scratch: '' }
      const live = target.live
      const cut = value.indexOf('=')

      if (what === 'live') live.workload = value
      else if (what === 'live.forward') live.forward.push(...value.split(',').map(one => one.trim()).filter(one => one !== ''))
      else if (what === 'live.env' && cut > 0) live.env[value.slice(0, cut)] = value.slice(cut + 1)
      else if (what === 'live.db') live.db = value
      else if (what === 'live.before') live.before = value
      else if (what === 'live.cleanup') live.cleanup.push(value)
      else if (what === 'live.restore') live.restore = value
      else if (what === 'live.scratch') live.scratch = value
    } else if (what.startsWith('db')) {
      target.db ??= { image: '', env: 'DATABASE_URL', setup: '' }
      if (what === 'db') target.db.image = value
      else if (what === 'db.env') target.db.env = value
      else target.db.setup = value
    } else if (what.startsWith('ready')) {
      target.ready ??= { request: '', match: '' }
      if (what === 'ready') target.ready.request = value
      else target.ready.match = value
    } else if (what === 'affected') target.affected = value
    else if (what === 'check') target.checks.push(value)
    else if (what === 'audit') target.audit = value
    else if (what === 'tests') target.tests = value.split(',').map(path => path.trim()).filter(path => path !== '').map(path => under(cwd, path))
    else if (what === 'test') target.test = value
    else if (what === 'python') target.python = value.replace(/^\.\//, '')
    else if (what === 'mask') target.masks.push(value)
    else {
      const cut = value.indexOf('=')
      if (cut > 0) target.env[value.slice(0, cut)] = value.slice(cut + 1)
    }
  }

  for (const line of requests) targets.get(line.split(/\s+/)[0] ?? '')?.requests.push(line)

  // A live stage with no workload named is none, as is a database with no image, or a readiness with no request
  return [...targets.values()].map(target => ({
    ...target,
    live: target.live !== null && target.live.workload === '' ? null : target.live,
    db: target.db !== null && target.db.image === '' ? null : target.db,
    ready: target.ready !== null && target.ready.request === '' ? null : target.ready,
  }))
}

/** A review a settled change is owed: a slash command and what follows its name, `/code-review medium`. */
export type Review = { command: string; args: string }

/** The reviews the project's file names, a `review=/command args` line each, in the order they are run. */
export const parseReviews = (text: string): Review[] =>
  text
    .split('\n')
    .map(line => /^review\s*=\s*\/?([\w:-]+)\s*(.*)$/.exec(line.trim()))
    .filter((found): found is RegExpExecArray => found !== null)
    .map(([, command = '', args = '']) => ({ command, args: args.trim() }))

/** The files of written standards the reviewers judge a change by, a `standards=path` line each, from the project's folder. */
export const parseStandards = (text: string): string[] =>
  text
    .split('\n')
    .map(line => /^standards\s*=\s*(.+)$/.exec(line.trim())?.[1]?.trim() ?? '')
    .filter(path => path !== '')

/** What each target's folders hold against HEAD, split from one diff and one list of new files, by label. */
export const changesByTarget = (output: string, targets: readonly Pick<Target, 'label' | 'roots'>[], cwd: string): Map<string, string> => {
  const [diff = '', fresh = ''] = output.split(`\n${UNTRACKED}\n`)
  const chunks = diff.split(/^(?=diff --git )/m).filter(chunk => chunk.startsWith('diff --git '))
  const pathOf = (chunk: string) => `${cwd}/${/^diff --git a\/(\S+)/.exec(chunk)?.[1] ?? ''}`
  const held = new Map<string, string>()

  for (const target of targets) {
    const isIn = (path: string) => targetsOf(path, [target as Target]).length > 0
    const files = fresh.split('\n').filter(line => line.trim() !== '' && isIn(`${cwd}/${line.trim()}`))

    held.set(target.label, [...chunks.filter(chunk => isIn(pathOf(chunk))), ...files].join('\n'))
  }

  return held
}

/** The line between the diff and the new files in what `changesByTarget` reads. */
export const UNTRACKED = '--untracked--'

/**
 * The shell script that says where the folders `$@` stand, cheaply: git status's lines, then a line a changed file
 * that is still there, `path<TAB>size mtime`. No file's content is read.
 */
export const STANDING_SCRIPT =
  'out=$(git status --porcelain=v1 -uall -- "$@") || exit 1; printf "%s\\n" "$out"; printf "%s\\n" "$out" | cut -c4- | sed "s/.* -> //" | tr "\\n" "\\0" | xargs -0 -r stat --printf "%n\\t%s %.9Y\\n" -- 2>/dev/null; true'

/** What `STANDING_SCRIPT` said, split by target: each line by the file it names. */
export const standingByTarget = (output: string, targets: readonly Pick<Target, 'label' | 'roots'>[], cwd: string): Map<string, string> => {
  const pathOf = (line: string) => {
    const [named = ''] = line.split('\t')

    // A status line names its file after two letters and a space; a rename names where it went last
    return (line.includes('\t') ? named : named.slice(3).split(' -> ').at(-1) ?? '').replace(/^"|"$/g, '')
  }
  const lines = output.split('\n').filter(line => line.trim() !== '')
  const held = new Map<string, string>()

  for (const target of targets) {
    const isIn = (path: string) => targetsOf(`${tidy(cwd)}/${path}`, [target as Target]).length > 0

    held.set(target.label, lines.filter(line => isIn(pathOf(line))).join('\n'))
  }

  return held
}

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
const BRIEF_EVIDENCE = 1_500
const BRIEF_CHARS = 12_000

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

/** The targets an edited file is of: those with a root that holds it. */
export const targetsOf = (path: string, targets: readonly Target[]): Target[] =>
  targets.filter(({ roots }) => roots.some(root => tidy(path) === root || tidy(path).startsWith(`${root}/`)))

/** Whether a target can be proved: its tests and the command that runs them are named. */
export const isTested = (target: Target): boolean => target.tests.length > 0 && target.test !== ''

/**
 * What the service handler answered, read back as a comparison; `undefined` when it answered nothing that reads.
 * A sentence in place of the cases says why nothing was compared.
 */
export const parseServiceAnswer = (source: string): Changed | string | undefined => {
  let value: Record<string, unknown>

  try {
    value = JSON.parse(source) as Record<string, unknown>
  } catch {
    return undefined
  }

  if (value === null || typeof value !== 'object' || typeof value.label !== 'string') return undefined

  const side = (held: unknown) => (held !== null && typeof held === 'object' ? (held as Record<string, unknown>) : {})
  const from = side(value.from)
  const to = side(value.to)
  const text = (held: unknown) => (typeof held === 'string' ? held : '')
  const name = (held: Record<string, unknown>) => (held.ref === 'work' ? 'the working tree' : text(held.sha) === '' ? text(held.ref) : `${text(held.ref)} (${text(held.sha).slice(0, 7)})`)
  const stopped = [text(value.error) !== '' ? `Nothing was played: ${text(value.error)}.` : '', ...[from, to].filter(held => text(held.error) !== '').map(held => `${name(held)} was not played: ${text(held.error)}`)].filter(said => said !== '')

  if (stopped.length > 0) return `${value.label}, the working tree against ${name(from)}: not compared. ${stopped.join(' ')}`

  const cases = (Array.isArray(value.cases) ? value.cases : []).map(one => side(one))
  const changed = cases.filter(one => one.isChanged === true).map(one => ({ line: text(one.line), evidence: text(one.evidence) }))
  const unreached = Object.fromEntries(Object.entries(side(value.unreached)).filter(([, spans]) => text(spans) !== '').map(([file, spans]) => [file, text(spans)]))

  return {
    summary: `${value.label}, ${name(to)} against ${name(from)}: ${changed.length} of ${cases.length} kept ${cases.length === 1 ? 'request' : 'requests'} changed`,
    changed,
    unchanged: cases.filter(one => one.isChanged !== true).map(one => text(one.line)),
    ...(value.measured === true ? { unreached } : {}),
  }
}

/**
 * What anduril's `diff` said, read back: the line that names the two builds, each kept run that changed with how,
 * and the ones that did not. `undefined` for an answer that is no comparison (no tool watched, a build that fails):
 * that answer is then the thing to say.
 */
export const parseDiffText = (text: string): { summary: string; changed: { line: string; evidence: string }[]; unchanged: string[] } | undefined => {
  const lines = text.split('\n')
  const head = /^(.+: \d+ of \d+ kept runs? changed)\./.exec(lines[0] ?? '')

  if (head === null) return undefined

  const changed: { line: string; evidence: string[] }[] = []
  const unchanged: string[] = []
  let open: { line: string; evidence: string[] } | undefined

  for (const line of lines.slice(1)) {
    if (line.startsWith('changed: ')) {
      open = { line: line.slice('changed: '.length).trim(), evidence: [] }
      changed.push(open)
    } else if (open !== undefined && line.startsWith('  ')) {
      open.evidence.push(line.slice(2))
    } else {
      open = undefined

      if (line.startsWith('unchanged: ')) unchanged.push(...line.slice('unchanged: '.length).split(' · ').map(one => one.trim()).filter(one => one !== ''))
    }
  }

  return { summary: head[1] ?? '', changed: changed.map(one => ({ line: one.line, evidence: one.evidence.join('\n') })), unchanged }
}

// How a test is declared, by the language it is written in: Rust, Python, Go, and a JavaScript runner's call
const DECLARED = [/\bfn\s+(\w+)/, /\bdef\s+(\w+)/, /\bfunc\s+(\w+)/, /\b(?:test|it)\s*\(\s*['"`](.+?)['"`]\s*,/]

const MARKED = new RegExp(`${MARK}\\s+(.+?)\\s*(?:\\*/|-->)?\\s*$`)

/** The marks a test file holds: each run named in a comment, with the test declared next beneath it. */
export const marksOf = (source: string): { line: string; test: string }[] => {
  const marks: { line: string; test: string }[] = []
  let waiting: string[] = []

  for (const line of source.split('\n')) {
    const mark = MARKED.exec(line)

    if (mark !== null) {
      waiting.push(mark[1] ?? '')
      continue
    }

    if (waiting.length === 0) continue

    const test = DECLARED.map(declared => declared.exec(line)?.[1]).find(name => name !== undefined)

    if (test !== undefined) {
      marks.push(...waiting.map(run => ({ line: run, test })))
      waiting = []
    }
  }

  return marks
}

// How a runner names a test as it ends: cargo, pytest -v, pytest's summary (-rfE), go test -v, TAP, and a JavaScript
// runner's tick or cross
type Ended = 'pass' | 'fail' | 'skip'

// A skip as each runner says it: cargo's `ignored` (with its reason or without), pytest's SKIPPED, go's SKIP, TAP's # SKIP
const ENDED: { pattern: RegExp; read: (found: RegExpExecArray) => [string, Ended] }[] = [
  { pattern: /^test (\S+) \.\.\. (ok|FAILED|ignored)\b/, read: found => [found[1] ?? '', found[2] === 'ok' ? 'pass' : found[2] === 'ignored' ? 'skip' : 'fail'] },
  { pattern: /^(\S+::\S+) (PASSED|FAILED|ERROR|SKIPPED)\b/, read: found => [found[1] ?? '', found[2] === 'PASSED' ? 'pass' : found[2] === 'SKIPPED' ? 'skip' : 'fail'] },
  { pattern: /^(FAILED|ERROR) (\S+)/, read: found => [found[2] ?? '', 'fail'] },
  { pattern: /^\s*--- (PASS|FAIL|SKIP): (\S+)/, read: found => [found[2] ?? '', found[1] === 'PASS' ? 'pass' : found[1] === 'SKIP' ? 'skip' : 'fail'] },
  { pattern: /^ok \d+(?: -)? (.+?)\s*# SKIP\b/i, read: found => [found[1] ?? '', 'skip'] },
  { pattern: /^(ok|not ok) \d+(?: -)? (.+?)\s*$/, read: found => [found[2] ?? '', found[1] === 'ok' ? 'pass' : 'fail'] },
  { pattern: /^\s*([✓✔]|[✗✘×✕])\s+(.+?)(?:\s+\(?\d+(?:\.\d+)?\s*m?s\)?)?\s*$/, read: found => [found[2] ?? '', /[✓✔]/.test(found[1] ?? '') ? 'pass' : 'fail'] },
]

/** How each test ended, by the name its runner gave it; a test said to fail once has failed, and one run once was not skipped. */
export const outcomesOf = (output: string): Record<string, Ended> => {
  const outcomes: Record<string, Ended> = {}

  for (const line of output.split('\n')) {
    for (const { pattern, read } of ENDED) {
      const found = pattern.exec(line)

      if (found === null) continue

      const [name, ended] = read(found)
      const was = outcomes[name]

      if (name !== '') outcomes[name] = was === 'fail' || ended === 'fail' ? 'fail' : was === 'pass' || ended === 'pass' ? 'pass' : 'skip'
      break
    }
  }

  return outcomes
}

/** Whether a runner's name for a test is the one a mark stands above: the same, or the same at the end of a path. */
export const isSameTest = (marked: string, ended: string): boolean => ended === marked || (ended.endsWith(marked) && /[^\w]$/.test(ended.slice(0, ended.length - marked.length)))

const outcomeOf = (outcomes: Record<string, Ended>, test: string): Outcome => {
  const names = Object.keys(outcomes).filter(name => isSameTest(test, name))

  return names.length === 0 ? 'none' : names.some(name => outcomes[name] === 'fail') ? 'fail' : names.some(name => outcomes[name] === 'pass') ? 'pass' : 'skip'
}

/** Where a changed run stands, by how the tests marked on it ended on each side. */
export const stateOf = (tests: readonly TestResult[], isProved: boolean): RunState =>
  tests.length === 0
    ? 'bare'
    : !isProved
      ? 'marked'
      : tests.some(test => test.to === 'fail')
        ? 'broken'
        : tests.some(test => test.from === 'fail' && test.to === 'pass')
          ? 'pinned'
          : tests.some(test => test.from === 'pass' && test.to === 'pass')
            ? 'loose'
            : 'marked'

/** The radius of a change: the kept runs anduril said changed, each with the tests marked on it. */
export const radiusOf = (input: {
  label: string
  kind: TargetKind
  at: number
  diff: Changed
  marks: readonly { line: string; test: string }[]
}): Radius => ({
  ...(input.diff.unreached !== undefined ? { unreached: input.diff.unreached } : {}),
  label: input.label,
  kind: input.kind,
  at: input.at,
  summary: input.diff.summary,
  // A run kept twice (a request before and after another) is one part of the radius, as a mark names it once
  seams: input.diff.changed
    .filter((one, index, all) => all.findIndex(other => other.line === one.line) === index)
    .map(({ line, evidence }): ChangedRun => {
      const tests = [...new Set(input.marks.filter(mark => mark.line === line).map(mark => mark.test))].map((name): TestResult => ({ name, from: 'none', to: 'none' }))

      return { line, evidence, tests, state: stateOf(tests, false) }
    }),
  unchanged: [...new Set(input.diff.unchanged)].filter(line => !input.diff.changed.some(one => one.line === line)),
  isProved: false,
  unproved: '',
  turned: [],
  isStale: false,
  live: '',
})

type Side = { ref: string; sha: string; error: string; exitCode: number; output: string }

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

const sideOf = (value: unknown): Side => {
  const held = (value !== null && typeof value === 'object' ? value : {}) as Record<string, unknown>

  return { ref: text(held.ref), sha: text(held.sha), error: text(held.error), exitCode: typeof held.exitCode === 'number' ? held.exitCode : -1, output: text(held.output) }
}

/** What the prove script answered; `undefined` when it answered nothing that reads. */
export const parseProof = (source: string): { from: Side; to: Side } | undefined => {
  let value: Record<string, unknown>

  try {
    value = JSON.parse(source) as Record<string, unknown>
  } catch {
    return undefined
  }

  return value === null || typeof value !== 'object' || typeof value.label !== 'string' ? undefined : { from: sideOf(value.from), to: sideOf(value.to) }
}

const sideName = (side: Side): string => (side.ref === 'work' ? 'the working tree' : side.sha === '' ? side.ref : `${side.ref} (${side.sha.slice(0, 7)})`)

const lastLines = (output: string, lines: number): string => output.trim().split('\n').slice(-lines).join('\n')

/** Why a side's tests say nothing of any test: it was not run, or its runner named none (a build that fails). */
const silent = (side: Side, outcomes: Record<string, unknown>): string =>
  side.error !== ''
    ? `The tests were not run on ${sideName(side)}: ${side.error}.`
    : Object.keys(outcomes).length === 0
      ? `The tests named no test on ${sideName(side)} (exit ${side.exitCode}):\n${lastLines(side.output, 8)}`
      : ''

/** The tests marked on the runs that changed, each once: the only tests in scope of a proof. */
export const markedTests = (radius: Radius): string[] => [...new Set(radius.seams.flatMap(seam => seam.tests.map(({ name }) => name)))]

/** Whether a test command says where the tests in scope are named: one that does not is never run. */
export const isNarrowable = (command: string): boolean => /\{tests(?::[^}]*)?\}/.test(command)

/**
 * A target's test command narrowed to the tests in scope: `{tests}` becomes their names, a space between, and
 * `{tests:SEP}` their names with SEP between (`-k "{tests: or }"` for pytest).
 */
export const narrowed = (command: string, names: readonly string[]): string => command.replace(/\{tests(?::([^}]*))?\}/g, (_, between: string | undefined) => names.join(between ?? ' '))

/**
 * A target's check or audit told the commit the change is compared with: `{against}` becomes it, as one word to the
 * shell whatever it holds (`orcrist check --since {against}` judges only the lines the change added).
 */
export const gated = (command: string, against: string): string => command.replaceAll('{against}', `'${against.replaceAll("'", "'\\''")}'`)

/**
 * The radius once its tests were run on both sides: each changed run by how its own tests ended, and each test the
 * caller requires by how it ended. A test neither marked on a changed run nor required is out of scope, and not read.
 */
export const proved = (radius: Radius, proof: { from: Side; to: Side }, required: readonly string[] = []): Radius => {
  const inScope = [...markedTests(radius), ...required]
  const scoped = (outcomes: Record<string, Ended>) => Object.fromEntries(Object.entries(outcomes).filter(([name]) => inScope.some(test => isSameTest(test, name))))
  const before = scoped(outcomesOf(proof.from.output))
  const after = scoped(outcomesOf(proof.to.output))

  return {
    ...radius,
    seams: radius.seams.map(seam => {
      const tests = seam.tests.map(({ name }): TestResult => ({ name, from: outcomeOf(before, name), to: outcomeOf(after, name) }))

      return { ...seam, tests, state: stateOf(tests, true) }
    }),
    isProved: true,
    unproved: [silent(proof.from, before), silent(proof.to, after)].filter(said => said !== '').join('\n'),
    turned: Object.keys(after).filter(name => after[name] === 'fail' && before[name] === 'pass').sort(),
    ...(required.length > 0 ? { required: [...new Set(required)].map((name): TestResult => ({ name, from: outcomeOf(before, name), to: outcomeOf(after, name) })) } : {}),
  }
}

/** A test as its runner is told to run it alone: its own name, without the file or module a caller may put before it. */
export const testName = (name: string): string => name.split('::').at(-1)?.trim() ?? name

/** The tests a caller requires, each `{ file, name }`, that are a target's own: those in a file its tests name. */
export const requiredOf = (target: Pick<Target, 'tests'>, cwd: string, tests: readonly { file: string; name: string }[]): string[] =>
  tests.filter(test => target.tests.some(root => { const path = under(cwd, test.file); return path === root || path.startsWith(`${root}/`) })).map(test => testName(test.name))

/**
 * What the affected command found, from its answer: the tests the change broke (failing on the working tree, not on
 * the commit), the ones broken before it (failing on both), or why it says nothing that reads.
 */
export const affectedOf = (source: string): { regressions: string[]; preexisting: string[]; unproved: string } => {
  let value: { to?: Partial<Side>; from?: Partial<Side> | null }

  try {
    value = JSON.parse(source) as typeof value
  } catch {
    return { regressions: [], preexisting: [], unproved: 'The affected tests could not be run: their script answered nothing that reads.' }
  }

  const after = sideOf(value.to)

  if (after.error !== '') return { regressions: [], preexisting: [], unproved: `The affected tests were not run: ${after.error}.` }
  if (after.exitCode === 0) return { regressions: [], preexisting: [], unproved: '' }

  const failing = Object.entries(outcomesOf(after.output)).filter(([, ended]) => ended === 'fail').map(([name]) => name).sort()

  if (failing.length === 0) return { regressions: [], preexisting: [], unproved: `The affected tests failed (exit ${after.exitCode}) and named no test that failed:\n${lastLines(after.output, 8)}` }

  const before = value.from === null || value.from === undefined ? undefined : sideOf(value.from)
  const brokenBefore = before === undefined || before.error !== '' ? {} : outcomesOf(before.output)
  const isOld = (name: string) => brokenBefore[name] === 'fail'

  return {
    regressions: failing.filter(name => !isOld(name)),
    preexisting: failing.filter(isOld),
    unproved: before !== undefined && before.error !== '' ? `What failed could not be told from what failed before: ${before.error}.` : '',
  }
}

/**
 * What a gate command found (a target's `check`, or its `audit` of the dependencies), from the answer of the script
 * that runs it on the working tree and, where it fails there, on the commit's source: `broken`, why the change fails
 * it; `before`, that it failed before the change too, and so is not owed by it; `unproved`, why it could not be told.
 * Failing on the working tree where the commit's source could not be tried is the change's to answer, not a pass.
 */
export const gateOf = (source: string, name: string): { broken: string; before: string; unproved: string } => {
  let value: { to?: Partial<Side>; from?: Partial<Side> | null }

  try {
    value = JSON.parse(source) as typeof value
  } catch {
    return { broken: '', before: '', unproved: `${name} could not be run: its script answered nothing that reads.` }
  }

  const after = sideOf(value.to)

  if (after.error !== '') return { broken: '', before: '', unproved: `${name} was not run: ${after.error}.` }
  if (after.exitCode === 0) return { broken: '', before: '', unproved: '' }

  const before = value.from === null || value.from === undefined ? undefined : sideOf(value.from)
  const said = lastLines(after.output, 12)

  if (before !== undefined && before.error === '' && before.exitCode !== 0) return { broken: '', before: `${name} fails on the commit's source too, so it is not owed by the change (exit ${before.exitCode}).`, unproved: '' }

  return {
    broken: `${name} fails on the working tree (exit ${after.exitCode})${before === undefined || before.error !== '' ? `, and whether it failed before could not be told${before?.error ? ` (${before.error})` : ''}` : ' and passes on the commit\'s source'}:\n${said}`,
    before: '',
    unproved: '',
  }
}

// The files a dependency is declared or locked in, by name
const MANIFEST = /(^|\/)(Cargo\.(toml|lock)|package(-lock)?\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|pyproject\.toml|uv\.lock|poetry\.lock|Pipfile(\.lock)?|requirements[\w.-]*\.txt|go\.(mod|sum)|Gemfile(\.lock)?|composer\.(json|lock))$/

/** The dependency manifests a change touches, from its diff and the new files after it, a path each. */
export const manifestsOf = (change: string): string[] =>
  [
    ...new Set(
      change.split('\n').flatMap(line => {
        // A chunk's header names its file; a new file is a bare path, where every line of a chunk starts otherwise
        const path = /^diff --git a\/(\S+)/.exec(line)?.[1] ?? (/^[\w.][^\s]*$/.test(line) && !line.startsWith('index') ? line : '')

        return MANIFEST.test(path) ? [path] : []
      }),
    ),
  ]

// The files a dependency's lock is written whole in: they say nothing of what a change wrote
const LOCKED = /(^|\/)(Cargo\.lock|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|uv\.lock|poetry\.lock|Pipfile\.lock|go\.sum|Gemfile\.lock|composer\.lock)$/

// How many of the files a change adds most to are named
const SIZE_FILES = 5

/**
 * The files git's `--numstat -z` names, each with the lines it adds and takes out: `added<TAB>removed<TAB>path`, or for
 * a rename `added<TAB>removed<TAB>`, then where from and where to, each ended by a NUL. A binary file adds no line.
 */
const numstatOf = (tokens: readonly string[], isNew: boolean): { path: string; added: number; removed: number; isNew: boolean }[] => {
  const files: { path: string; added: number; removed: number; isNew: boolean }[] = []

  for (let at = 0; at < tokens.length; at += 1) {
    const found = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(tokens[at] ?? '')

    if (found === null) continue

    // A rename names where it came from and where it went, after its counts
    const path = found[3] !== '' ? (found[3] ?? '') : (tokens[(at += 2)] ?? '')

    files.push({ path, added: Number(found[1]) || 0, removed: Number(found[2]) || 0, isNew })
  }

  return files
}

/**
 * How big a change is, in a sentence for the reviewers, from git's `--numstat -z` of its diff, `UNTRACKED`, then of each
 * new file against nothing: the lines it adds and takes out, across how many files, how many new, and where it adds
 * most. Lock files are not counted. Nothing for a change of no line.
 */
export const sizeText = (output: string): string => {
  const tokens = output.split('\0')
  const split = tokens.indexOf(UNTRACKED)
  const all = [...numstatOf(split === -1 ? tokens : tokens.slice(0, split), false), ...(split === -1 ? [] : numstatOf(tokens.slice(split + 1), true))]
  const counted = all.filter(one => !LOCKED.test(one.path))
  const added = counted.reduce((sum, one) => sum + one.added, 0)
  const removed = counted.reduce((sum, one) => sum + one.removed, 0)

  if (added === 0 && removed === 0) return ''

  const news = counted.filter(one => one.isNew).length
  const most = [...counted].filter(one => one.added > 0).sort((one, other) => other.added - one.added).slice(0, SIZE_FILES)

  return [
    `The change adds ${plural(added, 'line', 'lines')} and takes out ${removed}, across ${plural(counted.length, 'file', 'files')}${news > 0 ? `, ${news} of them new` : ''}.`,
    ...(most.length > 0 ? [`Where it adds most: ${most.map(one => `${one.path} +${one.added}${one.isNew ? ' (new)' : ''}`).join(', ')}.`] : []),
    ...(counted.length < all.length ? ['Lock files are not counted.'] : []),
  ].join(' ')
}

// A test declared, as a removed or added line of a diff spells it: Rust's attribute, Python's and Go's test functions,
// a JavaScript runner's call
const TEST_DECLARED = /^\s*(#\[(\w+::)?test\]|(async\s+)?def\s+test_\w+|func\s+Test\w+|(it|test)\s*\(\s*['"`])/

// A test skipped, or the rest of a file's tests skipped by running one alone, as an added line spells it
const TEST_SKIPPED = /#\[ignore\b|@pytest\.mark\.(skip|skipif|xfail)\b|\bpytest\.skip\(|@unittest\.skip|\b(it|test|describe)\.(skip|only|todo)\s*\(|\bx(it|test|describe)\s*\(|\bt\.Skip(Now|f)?\(/

/**
 * What a change does to the tests it touches that weakens them, as its diff of their files shows: a test file
 * deleted, tests taken out of a file (more declared on removed lines than on added ones), a test skipped or run
 * alone. A line each; none when it weakens nothing. Moving a test within the diff takes out nothing.
 */
export const weakenedOf = (diff: string): string[] =>
  diff
    .split(/^(?=diff --git )/m)
    .filter(chunk => chunk.startsWith('diff --git '))
    .flatMap(chunk => {
      const file = /^diff --git a\/(\S+)/.exec(chunk)?.[1] ?? ''
      const lines = chunk.split('\n').filter(line => !line.startsWith('---') && !line.startsWith('+++'))
      const removed = lines.filter(line => line.startsWith('-') && TEST_DECLARED.test(line.slice(1))).length
      const added = lines.filter(line => line.startsWith('+') && TEST_DECLARED.test(line.slice(1))).length
      const skipped = lines.filter(line => line.startsWith('+') && TEST_SKIPPED.test(line.slice(1))).map(line => line.slice(1).trim())

      if (/^deleted file mode/m.test(chunk)) return [`${file}: the test file is deleted${removed > 0 ? `, with its ${plural(removed, 'test', 'tests')}` : ''}`]

      return [
        ...(removed > added ? [`${file}: ${plural(removed - added, 'test', 'tests')} taken out`] : []),
        ...skipped.map(line => `${file}: skipped or run alone, \`${line.slice(0, 120)}\``),
      ]
    })

/** How many changed runs stand in each state. */
export const tally = (radius: Radius): Record<RunState, number> => {
  const counts: Record<RunState, number> = { bare: 0, marked: 0, pinned: 0, loose: 0, broken: 0 }
  for (const seam of radius.seams) counts[seam.state] += 1

  return counts
}

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`

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
const EVIDENCE_LINES = 16

const capped = (evidence: string): string[] => {
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

/** Whether a live workload's context, the first part of `context/namespace/kind/name`, names prod: such a one is never touched. */
export const isProd = (workload: string): boolean => (workload.split('/')[0] ?? '').toLowerCase().includes('prod')

/**
 * What a handler found changed: the line that names the two builds, each run that changed with how, the ones that did
 * not, and, where it measured them, the changed lines no kept run ran.
 */
export type Changed = { summary: string; changed: { line: string; evidence: string }[]; unchanged: string[]; unreached?: Record<string, string> }

/** What the live stage answered, read back; `undefined` when it answered nothing that reads. */
export const parseLiveAnswer = (source: string): { where: string; skipped: string; error: string; cases: { line: string; isChanged: boolean; evidence: string }[] } | undefined => {
  let value: Record<string, unknown>

  try {
    value = JSON.parse(source) as Record<string, unknown>
  } catch {
    return undefined
  }

  if (value === null || typeof value !== 'object' || typeof value.label !== 'string') return undefined

  const text = (held: unknown) => (typeof held === 'string' ? held : '')
  const cases = (Array.isArray(value.cases) ? value.cases : []).map(one => (one !== null && typeof one === 'object' ? (one as Record<string, unknown>) : {}))

  return { where: text(value.where), skipped: text(value.skipped), error: text(value.error), cases: cases.map(one => ({ line: text(one.line), isChanged: one.isChanged === true, evidence: text(one.evidence) })) }
}

/**
 * The fast stage's findings with the live stage's laid in: a request that answered otherwise with the real
 * dependencies is in the radius, its live evidence under what the fast stage saw. Answers them, and the live stage in a line.
 */
export const withLive = (changed: Changed, live: NonNullable<ReturnType<typeof parseLiveAnswer>>): { changed: Changed; line: string } => {
  if (live.error !== '') return { changed, line: `Live, on ${live.where}: not played, ${live.error}` }
  if (live.skipped !== '') return { changed, line: `Live: not played, ${live.skipped}` }

  const otherwise = live.cases.filter(one => one.isChanged)
  const merged = changed.changed.map(one => {
    const seen = otherwise.find(held => held.line === one.line)

    return seen === undefined ? one : { ...one, evidence: `${one.evidence}\n${seen.evidence}`.trim() }
  })
  const added = otherwise.filter(one => !changed.changed.some(held => held.line === one.line)).map(one => ({ line: one.line, evidence: one.evidence }))

  return {
    changed: { ...changed, changed: [...merged, ...added], unchanged: changed.unchanged.filter(line => !added.some(one => one.line === line)) },
    line: `Live, on ${live.where}, with the real dependencies and cleaned up after: ${otherwise.length} of ${live.cases.length} kept requests answered otherwise`,
  }
}
