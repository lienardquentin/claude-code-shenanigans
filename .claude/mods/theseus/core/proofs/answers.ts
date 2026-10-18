import { outcomesOf, lastLines } from './marks'

// What the proof's handlers answered: a service's requests played on both builds, a CLI's kept runs, the live stage,
// the affected tests and the checks.

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
 * What the recorder's `diff` said, read back: the line that names the two builds, each kept run that changed with how,
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

export type Side = { ref: string; sha: string; error: string; exitCode: number; output: string }

export const text = (value: unknown): string => (typeof value === 'string' ? value : '')

export const sideOf = (value: unknown): Side => {
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
