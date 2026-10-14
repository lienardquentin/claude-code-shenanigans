import type { ArgonathKind, ArgonathOutcome, ArgonathProofState, ArgonathRadius, ArgonathSeam, ArgonathState, ArgonathTarget, ArgonathTest } from '../types'

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

const KINDS: readonly ArgonathKind[] = ['cli', 'service', 'frontend']

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
 * - `$ label …`: a service's request kept to be played, `$ gondor GET /health`, with a JSON body as one quoted word
 *   after its path, `$ gondor POST /beacons/eilenach/light '{"keeper": "Hirgon"}'`. A CLI's runs are anduril's to keep.
 *
 * What does not read is left out, and a setting of a target the file does not name is dropped.
 */
export const parseProject = (text: string, cwd: string): ArgonathTarget[] => {
  const targets = new Map<string, ArgonathTarget>()
  const settings: [string, string, string][] = []
  const requests: string[] = []

  for (const raw of text.split('\n')) {
    const line = raw.trim()
    const kept = /^\$\s+(.+)$/.exec(line)
    // The shortest label that reads: `gondor.live.env` is gondor's `live.env`, not a `gondor.live`'s `env`
    const set = /^([\w.-]+?)\.(tests|test|python|env|mask|live|live\.forward|live\.env|live\.db|live\.before|live\.cleanup|live\.restore|live\.scratch)\s*=\s*(.*)$/.exec(line)
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
    } else if (what === 'tests') target.tests = value.split(',').map(path => path.trim()).filter(path => path !== '').map(path => under(cwd, path))
    else if (what === 'test') target.test = value
    else if (what === 'python') target.python = value.replace(/^\.\//, '')
    else if (what === 'mask') target.masks.push(value)
    else {
      const cut = value.indexOf('=')
      if (cut > 0) target.env[value.slice(0, cut)] = value.slice(cut + 1)
    }
  }

  for (const line of requests) targets.get(line.split(/\s+/)[0] ?? '')?.requests.push(line)

  // A live stage with no workload named is none
  return [...targets.values()].map(target => (target.live !== null && target.live.workload === '' ? { ...target, live: null } : target))
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

/** A change in a few characters, so the one last reviewed is known again: FNV-1a, in hex. */
export const fingerprintOf = (text: string): string => {
  let hash = 0x811c9dc5
  for (let at = 0; at < text.length; at += 1) hash = Math.imul(hash ^ text.charCodeAt(at), 0x01000193) >>> 0

  return `${text.length.toString(16)}-${hash.toString(16)}`
}

/**
 * The shell script that says what the change holds, as one text to fingerprint: HEAD, the diff against the merge base
 * of `$1` and HEAD, and the files git neither tracks nor ignores, by name and by content, so an edit of a new file
 * moves it too.
 */
export const CHANGE_SCRIPT =
  'b=$(git merge-base "$1" HEAD) || exit 1; git rev-parse HEAD; git diff "$b" --no-color --no-ext-diff; git ls-files -o --exclude-standard; git ls-files -o --exclude-standard -z | xargs -0 -r git hash-object --'

/** What each target's folders hold against HEAD, split from one diff and one list of new files, by label. */
export const changesByTarget = (output: string, targets: readonly Pick<ArgonathTarget, 'label' | 'roots'>[], cwd: string): Map<string, string> => {
  const [diff = '', fresh = ''] = output.split(`\n${UNTRACKED}\n`)
  const chunks = diff.split(/^(?=diff --git )/m).filter(chunk => chunk.startsWith('diff --git '))
  const pathOf = (chunk: string) => `${cwd}/${/^diff --git a\/(\S+)/.exec(chunk)?.[1] ?? ''}`
  const held = new Map<string, string>()

  for (const target of targets) {
    const isIn = (path: string) => targetsOf(path, [target as ArgonathTarget]).length > 0
    const files = fresh.split('\n').filter(line => line.trim() !== '' && isIn(`${cwd}/${line.trim()}`))

    held.set(target.label, [...chunks.filter(chunk => isIn(pathOf(chunk))), ...files].join('\n'))
  }

  return held
}

/** The line between the diff and the new files in what `changesByTarget` reads. */
export const UNTRACKED = '--argonath-untracked--'

/** Where one target stands in a proof: see `ArgonathProofState`. */
export const proofStateOf = (found: ArgonathRadius | string, kind: ArgonathTarget['kind'] | undefined, isTouched: boolean): ArgonathProofState => {
  if (typeof found === 'string') return !isTouched ? 'untouched' : kind === 'frontend' ? 'unhandled' : 'unlooked'
  if (found.seams.length === 0 && found.turned.length === 0) return isTouched ? 'unreached' : 'unchanged'

  return isQuiet(found) && found.unproved === '' ? 'pinned' : 'unsettled'
}

/** A proof as a mod reads it: whether it settles the change, why in a line, and each target's state. */
export type ProofAnswer = {
  verdict: 'settled' | 'unsettled' | 'unlooked'
  line: string
  targets: { label: string; kind: ArgonathTarget['kind'] | ''; state: ArgonathProofState; why: string }[]
  /** The targets the change reached that nothing proves: a statue judges them alone. */
  unhandled: string[]
  /** The targets the change reached where no kept run answers otherwise: a refactor, or behaviour no kept run reaches. */
  unreached: string[]
}

/** What a proof comes to, from each target's radius or why it has none. */
export const proofAnswer = (entries: readonly { label: string; kind: ArgonathTarget['kind'] | ''; found: ArgonathRadius | string; isTouched: boolean }[]): ProofAnswer => {
  const targets = entries.map(({ label, kind, found, isTouched }) => ({ label, kind, state: proofStateOf(found, kind === '' ? undefined : kind, isTouched), why: typeof found === 'string' ? found : found.unproved }))
  const radii = entries.map(({ found }) => found).filter((found): found is ArgonathRadius => typeof found !== 'string')
  const unlooked = targets.filter(one => one.state === 'unlooked')
  const unhandled = targets.filter(one => one.state === 'unhandled').map(one => one.label)
  const unreached = targets.filter(one => one.state === 'unreached').map(one => one.label)
  const counts = (['bare', 'marked', 'loose', 'broken'] as const).flatMap(state => {
    const many = radii.reduce((sum, radius) => sum + radius.seams.filter(seam => seam.state === state).length, 0)

    return many > 0 ? [`${many} ${state}`] : []
  })
  const isTurned = radii.some(radius => radius.turned.length > 0)
  const unproved = targets.filter(one => one.state === 'unsettled' && one.why !== '')

  const not = (verdict: ProofAnswer['verdict'], line: string): ProofAnswer => ({ verdict, line, targets, unhandled, unreached })

  if (entries.length === 0) return not('unlooked', 'Argonath knows no target to prove')
  if (unlooked.length > 0) return not('unlooked', `Argonath could not look at ${unlooked.map(one => `${one.label} (${one.why})`).join('; ')}`)
  if (counts.length > 0) return not('unsettled', `not pinned yet: ${counts.join(', ')}`)
  if (isTurned) return not('unsettled', 'a test that passed on the commit fails on the working tree')
  if (unproved.length > 0) return not('unsettled', `Argonath could not prove ${unproved.map(one => one.label).join(', ')}: ${unproved[0]?.why ?? ''}`)

  const isPinned = targets.some(one => one.state === 'pinned')
  const said = isPinned ? 'every changed run is pinned' : 'no kept run changed: nothing to pin'
  // A change no kept run sees settles, as a refactor does, but is said: the statues are left to tell a refactor from new behaviour
  const caveats = [...(unreached.length > 0 ? [`no kept run reaches what changed in ${unreached.join(', ')}`] : []), ...(unhandled.length > 0 ? [`nothing proves ${unhandled.join(', ')}`] : [])]

  return not('settled', [said, ...caveats].join('; '))
}

// How much of a changed run's evidence, and of the whole proof, the statues are handed
const BRIEF_EVIDENCE = 1_500
const BRIEF_CHARS = 12_000

/**
 * What a proof found, as the statues are handed it: each run whose answer changed, the tests that pin it and how it
 * answers now against before, and the targets the change reached that no kept run sees. Empty when there is nothing.
 */
export const proofBrief = (radii: readonly ArgonathRadius[], unreached: readonly string[]): string => {
  const lines = [
    ...radii.flatMap(radius =>
      radius.seams.map(seam => {
        const evidence = seam.evidence.trim()
        const shown = evidence.length > BRIEF_EVIDENCE ? `${evidence.slice(0, BRIEF_EVIDENCE)}\n… (cut)` : evidence

        return [`- ${radius.label}: ${seam.line} (${seam.state}${seam.tests.length > 0 ? `, by ${seam.tests.map(test => test.name).join(', ')}` : ''})`, ...(shown !== '' ? shown.split('\n').map(line => `    ${line}`) : [])].join('\n')
      }),
    ),
    ...unreached.map(label => `- ${label}: the change reached its source, but no kept run of it answers otherwise. No integration test proves this part of the change.`),
  ].join('\n')

  return lines.length > BRIEF_CHARS ? `${lines.slice(0, BRIEF_CHARS)}\n… (cut)` : lines
}

/** The targets an edited file is of: those with a root that holds it. */
export const targetsOf = (path: string, targets: readonly ArgonathTarget[]): ArgonathTarget[] =>
  targets.filter(({ roots }) => roots.some(root => tidy(path) === root || tidy(path).startsWith(`${root}/`)))

/** Whether a target can be proved: its tests and the command that runs them are named. */
export const isTested = (target: ArgonathTarget): boolean => target.tests.length > 0 && target.test !== ''

/**
 * What the service handler answered, read back as a comparison; `undefined` when it answered nothing that reads.
 * A sentence in place of the cases says why nothing was compared.
 */
export const parseServiceAnswer = (source: string): { summary: string; changed: { line: string; evidence: string }[]; unchanged: string[] } | string | undefined => {
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

  return {
    summary: `${value.label}, ${name(to)} against ${name(from)}: ${changed.length} of ${cases.length} kept ${cases.length === 1 ? 'request' : 'requests'} changed`,
    changed,
    unchanged: cases.filter(one => one.isChanged !== true).map(one => text(one.line)),
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

// How a runner names a test as it ends: cargo, pytest -v, go test -v, TAP, and a JavaScript runner's tick or cross
const ENDED: { pattern: RegExp; read: (found: RegExpExecArray) => [string, boolean] }[] = [
  { pattern: /^test (\S+) \.\.\. (ok|FAILED)\s*$/, read: found => [found[1] ?? '', found[2] === 'ok'] },
  { pattern: /^(\S+::\S+) (PASSED|FAILED|ERROR)\b/, read: found => [found[1] ?? '', found[2] === 'PASSED'] },
  { pattern: /^\s*--- (PASS|FAIL): (\S+)/, read: found => [found[2] ?? '', found[1] === 'PASS'] },
  { pattern: /^(ok|not ok) \d+(?: -)? (.+?)\s*$/, read: found => [found[2] ?? '', found[1] === 'ok'] },
  { pattern: /^\s*([✓✔]|[✗✘×✕])\s+(.+?)(?:\s+\(?\d+(?:\.\d+)?\s*m?s\)?)?\s*$/, read: found => [found[2] ?? '', /[✓✔]/.test(found[1] ?? '')] },
]

/** How each test ended, by the name its runner gave it; a test said to fail once has failed. */
export const outcomesOf = (output: string): Record<string, 'pass' | 'fail'> => {
  const outcomes: Record<string, 'pass' | 'fail'> = {}

  for (const line of output.split('\n')) {
    for (const { pattern, read } of ENDED) {
      const found = pattern.exec(line)

      if (found === null) continue

      const [name, isPassed] = read(found)

      if (name !== '') outcomes[name] = isPassed && outcomes[name] !== 'fail' ? 'pass' : 'fail'
      break
    }
  }

  return outcomes
}

/** Whether a runner's name for a test is the one a mark stands above: the same, or the same at the end of a path. */
export const isSameTest = (marked: string, ended: string): boolean => ended === marked || (ended.endsWith(marked) && /[^\w]$/.test(ended.slice(0, ended.length - marked.length)))

const outcomeOf = (outcomes: Record<string, 'pass' | 'fail'>, test: string): ArgonathOutcome => {
  const names = Object.keys(outcomes).filter(name => isSameTest(test, name))

  return names.length === 0 ? 'none' : names.some(name => outcomes[name] === 'fail') ? 'fail' : 'pass'
}

/** Where a changed run stands, by how the tests marked on it ended on each side. */
export const stateOf = (tests: readonly ArgonathTest[], isProved: boolean): ArgonathState =>
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
  kind: ArgonathKind
  at: number
  diff: { summary: string; changed: { line: string; evidence: string }[]; unchanged: string[] }
  marks: readonly { line: string; test: string }[]
}): ArgonathRadius => ({
  label: input.label,
  kind: input.kind,
  at: input.at,
  summary: input.diff.summary,
  // A run kept twice (a request before and after another) is one part of the radius, as a mark names it once
  seams: input.diff.changed
    .filter((one, index, all) => all.findIndex(other => other.line === one.line) === index)
    .map(({ line, evidence }): ArgonathSeam => {
      const tests = [...new Set(input.marks.filter(mark => mark.line === line).map(mark => mark.test))].map((name): ArgonathTest => ({ name, from: 'none', to: 'none' }))

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
export const markedTests = (radius: ArgonathRadius): string[] => [...new Set(radius.seams.flatMap(seam => seam.tests.map(({ name }) => name)))]

/** Whether a test command says where the tests in scope are named: one that does not is never run. */
export const isNarrowable = (command: string): boolean => /\{tests(?::[^}]*)?\}/.test(command)

/**
 * A target's test command narrowed to the tests in scope: `{tests}` becomes their names, a space between, and
 * `{tests:SEP}` their names with SEP between (`-k "{tests: or }"` for pytest).
 */
export const narrowed = (command: string, names: readonly string[]): string => command.replace(/\{tests(?::([^}]*))?\}/g, (_, between: string | undefined) => names.join(between ?? ' '))

/** The radius once its tests were run on both sides: each changed run by how its own tests ended. A test no changed run is marked by is out of scope, and not read. */
export const proved = (radius: ArgonathRadius, proof: { from: Side; to: Side }): ArgonathRadius => {
  const inScope = markedTests(radius)
  const scoped = (outcomes: Record<string, 'pass' | 'fail'>) => Object.fromEntries(Object.entries(outcomes).filter(([name]) => inScope.some(test => isSameTest(test, name))))
  const before = scoped(outcomesOf(proof.from.output))
  const after = scoped(outcomesOf(proof.to.output))

  return {
    ...radius,
    seams: radius.seams.map(seam => {
      const tests = seam.tests.map(({ name }): ArgonathTest => ({ name, from: outcomeOf(before, name), to: outcomeOf(after, name) }))

      return { ...seam, tests, state: stateOf(tests, true) }
    }),
    isProved: true,
    unproved: [silent(proof.from, before), silent(proof.to, after)].filter(said => said !== '').join('\n'),
    turned: Object.keys(after).filter(name => after[name] === 'fail' && before[name] === 'pass').sort(),
  }
}

/** How many changed runs stand in each state. */
export const tally = (radius: ArgonathRadius): Record<ArgonathState, number> => {
  const counts: Record<ArgonathState, number> = { bare: 0, marked: 0, pinned: 0, loose: 0, broken: 0 }
  for (const seam of radius.seams) counts[seam.state] += 1

  return counts
}

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`

/** Whether every changed run is pinned and no test turned: nothing is owed. */
export const isQuiet = (radius: ArgonathRadius): boolean => radius.seams.every(seam => seam.state === 'pinned') && radius.turned.length === 0

/** The radius in a line: how many kept runs changed and where they stand, and the tests that turned. */
export const radiusLine = (radius: ArgonathRadius): string => {
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
export const isLiveOnly = (seam: ArgonathSeam): boolean => seam.evidence.startsWith(LIVE_EVIDENCE)

/** What a changed run's state asks for, as a sentence. */
export const owed = (seam: ArgonathSeam): string => {
  const names = seam.tests.map(test => test.name).join(', ')

  return {
    // A change is not always meant: one that was not is a regression, and owes a fix rather than a test
    bare: isLiveOnly(seam)
      ? `it answered otherwise only with the real dependencies, so no test that runs without them can pin it. If that is not meant, it is a regression: fix the code. If it is, pin it with a test that runs against the real dependencies, marked \`${MARK} ${seam.line}\`; none is named for this target.`
      : `no test is marked on it. If the change is meant, write one that makes this run and asserts what it now does, with a comment \`${MARK} ${seam.line}\` above it; if not, it is a regression: fix the code.`,
    marked: `marked by ${names}, not proved: \`prove\` runs it on both sides.`,
    pinned: `pinned by ${names}: it fails on the commit's source and passes on the working tree.`,
    loose: `${names} ${seam.tests.length === 1 ? 'passes' : 'pass'} on both sides, so ${seam.tests.length === 1 ? 'it does' : 'they do'} not see the change: assert what changed.`,
    broken: `${seam.tests.filter(test => test.to === 'fail').map(test => test.name).join(', ')} ${seam.tests.filter(test => test.to === 'fail').length === 1 ? 'fails' : 'fail'} on the working tree.`,
  }[seam.state]
}

/** The radius in full, for the model: each changed run with where it stands and how it changed, then what is outside. */
export const radiusText = (radius: ArgonathRadius): string =>
  [
    `${radius.summary}.`,
    ...(radius.live !== '' ? [`${radius.live}.`] : []),
    radius.seams.length === 0 ? 'Nothing a kept run does changed: no integration test is owed.' : `${radiusLine(radius)}.`,
    ...(radius.isStale ? ['A file was edited since: this is of an earlier working tree.'] : []),
    ...radius.seams.flatMap(seam => ['', `${seam.state}: ${seam.line}`, `  ${owed(seam)}`, ...(seam.state === 'pinned' ? [] : seam.evidence.split('\n').filter(line => line !== '').map(line => `  ${line}`))]),
    ...(radius.turned.length > 0
      ? ['', `Passing on the commit's source and failing on the working tree: ${radius.turned.join(', ')}. Each pins what the change changed, and is to be brought to what the tool now does, or shows a regression.`]
      : []),
    ...(radius.unproved !== '' ? ['', radius.unproved] : []),
    ...(radius.unchanged.length > 0 ? ['', `Outside the radius, owed no test: ${radius.unchanged.join(' · ')}`] : []),
  ].join('\n')

/** Whether a live workload's context, the first part of `context/namespace/kind/name`, names prod: such a one is never touched. */
export const isProd = (workload: string): boolean => (workload.split('/')[0] ?? '').toLowerCase().includes('prod')

/** What a handler found changed: the line that names the two builds, each run that changed with how, the ones that did not. */
export type Changed = { summary: string; changed: { line: string; evidence: string }[]; unchanged: string[] }

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

/** How to have targets known, said where none are. */
export const HOW_TO = [
  `Argonath knows no target here. Name each thing the project builds in ${PROJECT_FILE}, a line each:`,
  '',
  '    narsil=cli@narsil',
  '    narsil.tests=narsil/tests',
  '    narsil.test=cargo test --manifest-path narsil/Cargo.toml --test cli',
  '',
  '    gondor=service:gondor.app:app@beacons/gondor',
  '    gondor.python=beacons',
  '    $ gondor GET /health',
  '',
  'Its kind and the folders of its source, then its tests and the command that runs them. A CLI\'s runs are kept by anduril, a service\'s requests here. Then /argonath.',
].join('\n')
