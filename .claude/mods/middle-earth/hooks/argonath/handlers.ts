import type { EngineInterface } from 'claude-code'

import type { ArgonathRadius, ArgonathTarget } from '../../types'
import { errorText } from '../flow'
import type { Changed } from './proof'
import { CHANGE_SCRIPT, UNTRACKED, affectedOf, changesByTarget, gateOf, markedTests, marksOf, narrowed, parseDiffText, parseLiveAnswer, parseProof, parseServiceAnswer, proved, sizeText, tidy, withLive } from './proof'

// What the Argonath runs on the machine for one target, in one place: Andúril's diff of a CLI, a service's requests,
// the tests on both sides, the affected tests, checks and audits, and what git says the change holds. Each is handed the
// folder it runs in; what the Argonath keeps of it, and shows, is its register's.
// A helper that takes `$` is a function declaration: past an import, the engine follows `$` into no other kind.

type $ = EngineInterface

/**
 * Where a look, a proof or a judgement is made: the project's own folder, whose radius the pane and the band show, or
 * a quest's worktree, whose answers go to the one who asked alone.
 */
export type Place = { tree: string; isHome: boolean }

// The mod whose diff plays a CLI's kept runs on two builds: a CLI's radius is read from what it says
const ANDURIL = 'anduril'
// A look builds and plays on two sides, and a proof runs the tests on each: as long as a host command may run
const RUN_TIMEOUT_MS = 600_000
// How many test files are read for marks
const READ_FILES = 300

/** Every mark in the files a target names as tests: what git tracks there, and what it neither tracks nor ignores. */
export async function marksIn($: $, cwd: string, target: ArgonathTarget): Promise<{ line: string; test: string }[]> {
  if (target.tests.length === 0) return []

  const listed = await $.process.run(['git', 'ls-files', '-co', '--exclude-standard', '--', ...target.tests], { cwd }).catch(() => undefined)
  const paths = (listed?.exitCode === 0 ? listed.stdout.split('\n') : []).map(path => path.trim()).filter(path => path !== '')
  const marks: { line: string; test: string }[] = []

  for (const path of paths.slice(0, READ_FILES)) marks.push(...marksOf(await $.fs.read(`${cwd}/${path}`).catch(() => '')))

  return marks
}

/** What a handler found, and for a service with a live stage, what that stage found in a line. */
export type Found = Changed & { live?: string }

/**
 * A CLI's handler: anduril plays its kept runs on both builds, and says what changed. Andúril is a plugin of its own,
 * useful alone, and this is the one call that crosses to it: through MCP, as a tool call would be put to the session's
 * permission check, which a proof no one is at the prompt for cannot answer.
 */
export async function cliChanged($: $, target: ArgonathTarget, against: string, place: Place): Promise<Changed | string> {
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

/** Runs a target's tests on both sides, and says where each changed run, and each test required, stands. */
export async function proveIn($: $, target: ArgonathTarget, made: ArgonathRadius, against: string, required: readonly string[], place: Place): Promise<ArgonathRadius | string> {
  // Only the tests marked on the runs that changed, and those required, are run, where the command says how to name them
  const job = { home: place.tree, label: target.label, tests: target.tests, test: narrowed(target.test, [...new Set([...markedTests(made), ...required])]), from: against }
  const ran = await $.process.run(['python3', `${tidy($.plugin.root)}/handlers/prove.py`], { stdin: JSON.stringify(job), timeoutMs: RUN_TIMEOUT_MS })
  const proof = parseProof(ran.stdout)

  return proof === undefined ? `The proof of ${target.label} could not be made: ${ran.stderr.trim().split('\n').slice(-3).join(' ') || `the prove script exited with ${ran.exitCode}`}` : proved(made, proof, required)
}

/** Runs the tests a change of the target can break, and tells what the change broke from what was broken before. */
export async function affectedIn($: $, target: ArgonathTarget, against: string, place: Place): Promise<ReturnType<typeof affectedOf>> {
  const job = { home: place.tree, label: target.label, tests: target.tests, command: target.affected, from: against }
  const ran = await $.process.run(['python3', `${tidy($.plugin.root)}/handlers/affected.py`], { stdin: JSON.stringify(job), timeoutMs: RUN_TIMEOUT_MS }).catch(() => undefined)

  return affectedOf(ran?.stdout ?? '')
}

/**
 * Runs a gate command of a target (its check, or its audit) on the working tree, and on the commit's source where it
 * fails there, as the affected tests are: what the change broke of it, what was broken before, or why it is not known.
 */
export async function gateIn($: $, target: ArgonathTarget, name: 'check' | 'audit', against: string, place: Place): Promise<ReturnType<typeof gateOf>> {
  const job = { home: place.tree, label: target.label, tests: [], command: target[name], from: against }
  const ran = await $.process.run(['python3', `${tidy($.plugin.root)}/handlers/affected.py`], { stdin: JSON.stringify(job), timeoutMs: RUN_TIMEOUT_MS }).catch((error: unknown) => ({ exitCode: -1, stdout: '', stderr: errorText(error) }))

  return gateOf(ran.stdout, `${target.label}.${name}`)
}

/** The diff of a target's tests against HEAD, the files they hold deleted with it: where a change weakens them. */
export async function testsDiffIn($: $, target: ArgonathTarget, place: Place): Promise<string> {
  if (target.tests.length === 0) return ''

  return (await $.process.run(['git', 'diff', 'HEAD', '--no-color', '--no-ext-diff', '--', ...target.tests], { cwd: place.tree }).catch(() => undefined))?.stdout ?? ''
}

// What a fingerprint of a change git could not read starts with: it matches no change that was read, so no proof or
// judgement made of one is ever taken for another's
export const UNREADABLE = 'unreadable:'

/**
 * The whole change as one fingerprint: HEAD, the diff since `against` left it, and the new files by name and content.
 * One git could not read is `unreadable:` and why, the same each time it fails alike, so a judgement of it is not stale.
 */
export async function wholeFingerprint($: $, tree: string, against = 'HEAD'): Promise<string> {
  const ran = await $.process.run(['sh', '-c', CHANGE_SCRIPT, 'sh', against], { cwd: tree }).catch((error: unknown) => ({ exitCode: -1, stdout: '', stderr: errorText(error) }))

  return ran.exitCode === 0 ? `git:${ran.stdout.trim()}` : `${UNREADABLE}${ran.stderr.trim().split('\n').slice(-1)[0] ?? ''}`
}

/** The change as the statues are handed it: the diff since `against` left HEAD, then the new files by name; or why git could not say it. */
export async function changeText($: $, tree: string, against = 'HEAD'): Promise<{ text: string } | { error: string }> {
  const ran = await $.process
    .run(['sh', '-c', 'b=$(git merge-base "$1" HEAD) || exit 1; git diff "$b" --no-color --no-ext-diff; echo; echo "New files:"; git ls-files -o --exclude-standard', 'sh', against], { cwd: tree })
    .catch((error: unknown) => ({ exitCode: -1, stdout: '', stderr: errorText(error) }))

  return ran.exitCode === 0 ? { text: ran.stdout } : { error: `git could not show the change since ${against}: ${ran.stderr.trim().split('\n').slice(-1)[0] || `it exited with ${ran.exitCode}`}` }
}

/** How big the change is, in a sentence for the statues: nothing when git could not count it, as a size is only a note. */
export async function sizeIn($: $, tree: string, against = 'HEAD'): Promise<string> {
  const ran = await $.process
    .run(['sh', '-c', `b=$(git merge-base "$1" HEAD) || exit 1; git diff "$b" --numstat --no-ext-diff; echo '${UNTRACKED}'; git ls-files -o --exclude-standard -z | xargs -0 -r wc -l --`, 'sh', against], { cwd: tree })
    .catch(() => undefined)

  return ran?.exitCode === 0 ? sizeText(ran.stdout) : ''
}

/** What each target's folders hold against HEAD in a place, by label, read in one go: empty for a target the change did not reach. */
export async function changesOf($: $, place: Place, list: readonly ArgonathTarget[]): Promise<Map<string, string>> {
  const cwd = place.tree
  const roots = [...new Set(list.flatMap(({ roots }) => roots))]

  if (roots.length === 0) return new Map()

  const ran = await $.process
    .run(['sh', '-c', `git diff HEAD --no-color --no-ext-diff -- "$@"; echo; echo '${UNTRACKED}'; git ls-files -o --exclude-standard -- "$@"`, 'sh', ...roots], { cwd })
    .catch(() => undefined)

  return ran === undefined || ran.exitCode !== 0 ? new Map() : changesByTarget(ran.stdout, list, cwd)
}

/** What a service's handler is handed: the target's kept requests, both builds, and the project's folder for a quest's worktree. */
export const serviceJob = (target: ArgonathTarget, against: string, place: Place, project?: string) => ({
  home: place.tree,
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

/** A service's kept requests, played in-process on both builds, standing alone: what changed, or why it could not be played. */
export async function servicePlayed($: $, job: ReturnType<typeof serviceJob>): Promise<Changed | string> {
  const ran = await $.process.run(['python3', `${tidy($.plugin.root)}/handlers/service.py`], { stdin: JSON.stringify(job), timeoutMs: RUN_TIMEOUT_MS })

  return parseServiceAnswer(ran.stdout) ?? `The requests could not be played: ${ran.stderr.trim().split('\n').slice(-3).join(' ') || `the service handler exited with ${ran.exitCode} and said nothing`}`
}

/** The same requests played on both builds again where the service is deployed, against its real dependencies, merged into what the fast stage found. */
export async function serviceLive($: $, job: ReturnType<typeof serviceJob>, live: NonNullable<ArgonathTarget['live']>, fast: Changed): Promise<Found> {
  const found = await $.process
    .run(['python3', `${tidy($.plugin.root)}/handlers/live.py`], { stdin: JSON.stringify({ ...job, live }), timeoutMs: RUN_TIMEOUT_MS })
    .then(done => parseLiveAnswer(done.stdout) ?? { where: live.workload, skipped: '', error: done.stderr.trim().split('\n').slice(-2).join(' ') || `the live handler exited with ${done.exitCode}`, cases: [] })
    .catch((error: unknown) => ({ where: live.workload, skipped: '', error: error instanceof Error ? error.message : String(error), cases: [] }))
  const merged = withLive(fast, found)

  return { ...merged.changed, live: merged.line }
}
