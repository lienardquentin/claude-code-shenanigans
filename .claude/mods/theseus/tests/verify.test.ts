import { describe, expect, mock } from 'claude-code/testing'
import { test } from './hook-test'
import type { TestBody } from 'claude-code/testing'

import { UNTRACKED, changesByTarget, gateOf, isProd, manifestsOf, weakenedOf, markedTests, narrowed, owed, parseProject, parseProof, parseReviews, parseServiceAnswer, parseStandards, proofAnswer, proved, requiredOf, sizeText, standingByTarget, targetsOf, withLive } from '../core/proof'
import type { Radius, RunState } from '../types'
import { dealt, parseFindings } from '../core/review'
import { isChanging } from '../hooks/flow'
import { secretsIn } from '../core/change'

type Engine = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

const CWD = '/proj'

const PROJECT = [
  '# what the project builds',
  'review=/code-review medium',
  'review=security-review',
  'narsil=cli@narsil',
  'narsil.tests=narsil/tests',
  'narsil.test=cargo test --test cli',
  'gondor=service:gondor.app:app@beacons/gondor',
  'gondor.python=beacons',
  'gondor.env=ROHAN_URL=http://127.0.0.1:9',
  'gondor.env=DATABASE_URL=',
  'gondor.tests=beacons/tests',
  'gondor.test=uv run pytest -v beacons/tests/test_gondor.py -k "{tests: or }"',
  '$ gondor GET /health',
  '$ gondor POST /beacons/amon-din/light',
  '$ quill GET /nothing',
  'anor=frontend@beacons/anor',
  'quill.test=make it',
].join('\n')

// A path as the tests write it, however the host spells it
const whole = (path: string) => path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')

// What the recorder's diff says of narsil: one kept run changed
const CLI_DIFF = [
  "narsil, the working tree against HEAD (209dec6): 1 of 2 kept runs changed. Each was played on both builds in a copy of the tool's source folder, with no terminal; a line with - is HEAD (209dec6)'s, one with + the working tree's.",
  '',
  'changed: narsil show 999',
  '  --- from/stderr',
  '  +++ to/stderr',
  '  -narsil: no lighting 999 in the chronicle',
  '  +narsil: lighting 999 is not in the chronicle',
  '',
  'unchanged: narsil ls',
].join('\n')

// What the service handler answers of gondor: the health check now counts what burns
const SERVICE = {
  label: 'gondor',
  from: { ref: 'HEAD', sha: '209dec6ccef9', error: '' },
  to: { ref: 'work', sha: '', error: '' },
  error: '',
  cases: [
    { line: 'gondor GET /health', isChanged: true, evidence: '--- from/body\n+++ to/body\n@@ -1,3 +1,4 @@\n {\n+  "lit": 0,\n   "realm": "gondor",' },
    { line: 'gondor POST /beacons/amon-din/light', isChanged: false, evidence: '' },
  ],
}

const TESTS = ['# pins: gondor GET /health', 'def test_health_counts_what_burns(client):', '    assert client.get("/health").json()["lit"] == 0'].join('\n')

const pytest = (ended: Record<string, boolean>) => Object.entries(ended).map(([name, isOk]) => `beacons/tests/test_gondor.py::${name} ${isOk ? 'PASSED' : 'FAILED'}`).join('\n')

const PROOF = {
  label: 'gondor',
  from: { ref: 'HEAD', sha: '209dec6ccef9', error: '', exitCode: 1, output: pytest({ test_health_counts_what_burns: false, test_health: true }) },
  to: { ref: 'work', sha: '', error: '', exitCode: 1, output: pytest({ test_health_counts_what_burns: true, test_health: false }) },
}

/** Stands for the machine beneath the mod and for the recorder beside it. */
const machine = (on: On, given: Record<string, string> = {}) => {
  const files: Record<string, string> = { [`${CWD}/.claude/verify`]: PROJECT, [`${CWD}/beacons/tests/test_gondor.py`]: TESTS, ...given }
  // `fingerprint` is the diff git shows of the targets' folders (each of the three changed), `standing` what its
  // status says of them, read around each shell command and counted in `fingerprints`
  const world = { files, ran: [] as string[], fingerprint: 'diff --git a/beacons/gondor/app.py b/beacons/gondor/app.py\n+    lit = 0\ndiff --git a/narsil/src/main.rs b/narsil/src/main.rs\n+fn main() {}\ndiff --git a/beacons/anor/app.vue b/beacons/anor/app.vue\n+<p/>\n', standing: '', fingerprints: 0, whole: 'abc123\n', change: 'diff --git a/beacons/gondor/app.py\n+    lit = 0\n', size: `1\t0\tbeacons/gondor/app.py\0${UNTRACKED}\0`, cli: CLI_DIFF, service: JSON.stringify(SERVICE), proof: JSON.stringify(PROOF), asked: [] as Record<string, unknown>[], isRecorderGone: false, jobs: { service: [] as Record<string, unknown>[], prove: [] as Record<string, unknown>[], live: [] as Record<string, unknown>[], affected: [] as Record<string, unknown>[] }, affected: JSON.stringify({ label: 'gondor', to: { error: '', exitCode: 0, output: '3 passed' }, from: null }), gates: {} as Record<string, string>, missing: [] as string[] }
  const clock = mock.clock(on, { now: 1_800_000_000_000 })

  on('session.cwd', () => ({ value: CWD }) as never)
  on('fs.exists', (_, e) => ({ value: whole(e.path) in files }) as never)
  on('fs.read', (_, e) => {
    const text = files[whole(e.path)]
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)

    return { value: text } as never
  })
  on('fs.write', (_, e) => {
    files[whole(e.path)] = e.text

    return { value: undefined } as never
  })
  on('process.run', (_, e) => {
    const given = e as unknown as { stdin?: string; init?: { stdin?: string } }
    const job = () => JSON.parse(given.stdin ?? given.init?.stdin ?? '{}') as Record<string, unknown>
    const script = e.argv.find(arg => arg.endsWith('.py')) ?? ''
    let stdout = ''

    world.ran.push(e.argv.join(' '))

    // A base git does not know: the merge base cannot be found, and the script says so and stops
    if (e.argv[0] === 'sh' && (e.argv[2] ?? '').includes('git merge-base') && world.missing.includes(e.argv.at(-1) ?? '')) {
      return { value: { exitCode: 1, stdout: '', stderr: `fatal: Not a valid object name ${e.argv.at(-1) ?? ''}`, isStdoutTruncated: false, isStderrTruncated: false } } as never
    }
    if (e.argv[0] === 'sh' && (e.argv[2] ?? '').includes('git rev-parse HEAD')) stdout = world.whole
    else if (e.argv[0] === 'sh' && (e.argv[2] ?? '').includes('New files:')) stdout = world.change
    else if (e.argv[0] === 'sh' && (e.argv[2] ?? '').includes('--numstat')) stdout = world.size
    else if (script.endsWith('service.py')) {
      world.jobs.service.push(job())
      stdout = world.service
    } else if (e.argv[0] === 'sh' && e.argv.some(arg => arg.endsWith('/beacons/gondor')) && (e.argv[2] ?? '').includes('git status')) {
      // Where the targets' folders stand, as git status says it around a shell command
      world.fingerprints += 1
      stdout = world.standing
    } else if (e.argv[0] === 'sh' && e.argv.some(arg => arg.endsWith('/beacons/gondor'))) {
      // What git says of the targets' folders against HEAD
      stdout = world.fingerprint
    } else if (script.endsWith('live.py')) {
      world.jobs.live.push(job())
      stdout = JSON.stringify({ label: 'gondor', where: 'k3d-beacons/beacons/deployment/gondor', skipped: '', error: '', cases: [] })
    } else if (script.endsWith('prove.py')) {
      world.jobs.prove.push(job())
      stdout = world.proof
    } else if (script.endsWith('affected.py')) {
      world.jobs.affected.push(job())
      // A check or an audit is run by the same script, and answered by its command
      stdout = world.gates[String(job().command)] ?? world.affected
    } else {
      // git listing a target's test files, from the folder it runs in: the project's, or a run's worktree
      const folders = e.argv.slice(e.argv.indexOf('--') + 1).map(whole)
      const at = whole((e as unknown as { cwd?: string; init?: { cwd?: string } }).cwd ?? (e as unknown as { init?: { cwd?: string } }).init?.cwd ?? CWD)
      stdout = Object.keys(files).filter(path => folders.some(folder => path.startsWith(`${folder}/`))).map(path => path.slice(at.length + 1)).join('\n')
    }

    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
  // The recorder is asked as the mods ask one another, through MCP, never through a tool call the permission check sees
  on('mcp.call', (_, e) => {
    if (e.server !== 'recorder' || e.tool !== 'diff') throw new Error(`no ${e.server} ${e.tool}`)
    // A session that never loaded the recorder answers as the engine does
    if (world.isRecorderGone) return { deny: 'no connected MCP tool "diff" on a server named "recorder"' } as never
    world.asked.push(e.args)

    return { value: { content: [{ type: 'text', text: world.cli }], isError: false } } as never
  })

  // The world itself, not a copy: a test that changes what it answers changes what the mocks above read
  return Object.assign(world, { clock })
}

const call = async ($: Engine, tool: string, input: Record<string, unknown> = {}) => String((await $.tool.call({ tool, ...input } as never)).result)

const ends = ($: Engine, agentId: string, answer: string) => $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId: 's', reason: 'answer', agentId } as never)

/** A reviewer's answer: its account, then its findings as the json block it ends with. */
const FOUND = (findings: Record<string, string>[]) => ['I ran the review on the change.', '', '```json', JSON.stringify({ findings }), '```'].join('\n')

/**
 * Stands for the engine that sends the reviewers, and for the Claude they report to. `isMinting` has the spawn answer
 * an id, `<type>-1`, as core does for an agent another mod sends.
 */
const reviewers = (on: On, isMinting = false) => {
  const spawned: Record<string, unknown>[] = []
  const submitted: string[] = []

  on('agent.spawn', (_, e) => {
    const given = e as unknown as Record<string, unknown> & { subagentType?: string; subagent_type?: string }

    spawned.push(given)

    return { model: 'opus', ...(isMinting ? { agentId: `${String(given.subagentType ?? given.subagent_type ?? '').split(':')[1] ?? ''}-1` } : {}) } as never
  })
  // Core alone mints an agent's id: a reviewer is known by the type it runs as
  on('agent.list', () => ({
    value: [
      { id: 'reviewer-correctness-1', description: 'x', type: 'theseus:reviewer-correctness', status: 'running' },
      { id: 'reviewer-security-1', description: 'x', type: 'theseus:reviewer-security', status: 'running' },
      { id: 'someone', description: 'x', type: 'Explore', status: 'running' },
      // A builder another mod sent, and a helper the person spawned
      { id: 'builder-service-1', description: 'x', type: 'theseus:builder-service', status: 'running' },
      { id: 'helper-1', description: 'x', type: 'general-purpose', status: 'running' },
    ],
  }) as never)
  on('agent.register', () => ({ value: { agent: 'theseus:reviewer-correctness' } }) as never)
  on('prompt.submit', (_, e) => {
    submitted.push(e.text)

    return { text: e.text } as never
  })
  on('command.register', () => ({ value: undefined }) as never)
  on('tool.register', () => ({ value: undefined }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('session.start', () => ({ cwd: CWD }) as never)
  on('turn.complete', () => ({ text: 'done' }) as never)

  return { spawned, submitted }
}

describe('what the project builds', () => {
  test('is read a target each, with its kind, its folders, its tests and what a service is played with', () => {
    const [narsil, gondor, anor] = parseProject(PROJECT, CWD)

    expect(narsil).toMatchObject({ label: 'narsil', kind: 'cli', roots: [`${CWD}/narsil`], tests: [`${CWD}/narsil/tests`], test: 'cargo test --test cli', requests: [] })
    expect(gondor).toMatchObject({
      label: 'gondor',
      kind: 'service',
      app: 'gondor.app:app',
      python: 'beacons',
      env: { ROHAN_URL: 'http://127.0.0.1:9', DATABASE_URL: '' },
      requests: ['gondor GET /health', 'gondor POST /beacons/amon-din/light'],
    })
    expect(anor).toMatchObject({ label: 'anor', kind: 'frontend', roots: [`${CWD}/beacons/anor`] })
    // A setting or a request of a target the file does not name is dropped
    expect(parseProject(PROJECT, CWD).map(({ label }) => label)).toEqual(['narsil', 'gondor', 'anor'])
  })

  test('reads the reviews a settled change is owed, in order, and no target from them', () => {
    expect(parseReviews(PROJECT)).toEqual([
      { command: 'code-review', args: 'medium' },
      { command: 'security-review', args: '' },
    ])
    expect(parseReviews('narsil=cli@narsil')).toEqual([])
  })

  test('reads the files of standards the reviewers judge by, and no target from them', () => {
    expect(parseStandards('standards=docs/agents/standards.md\n  standards = docs/more.md \nstandards=\nnarsil=cli@narsil')).toEqual(['docs/agents/standards.md', 'docs/more.md'])
    expect(parseProject('standards=docs/agents/standards.md', CWD)).toEqual([])
  })

  test('routes an edited file to the target whose folder holds it, and no other', () => {
    const list = parseProject(PROJECT, CWD)

    expect(targetsOf(`${CWD}/beacons/gondor/app.py`, list).map(({ label }) => label)).toEqual(['gondor'])
    expect(targetsOf(`${CWD}/narsil/src/main.rs`, list).map(({ label }) => label)).toEqual(['narsil'])
    expect(targetsOf(`${CWD}/beacons/gondorian/app.py`, list)).toEqual([])
    expect(targetsOf(`${CWD}/README.md`, list)).toEqual([])
  })
})

const LIVE = [
  'gondor.live=k3d-beacons/beacons/deployment/gondor',
  'gondor.live.forward=postgres:5432, rohan:8102',
  'gondor.live.env=KAFKA_BROKERS=',
  'gondor.live.db=deployment/postgres',
  'gondor.live.before=SELECT beacon, rid FROM burning',
  "gondor.live.cleanup=DELETE FROM lightings WHERE rid LIKE '{rid}%'",
  "gondor.live.cleanup=DELETE FROM burning WHERE rid LIKE '{rid}%'",
  'gondor.live.restore=INSERT INTO burning (beacon, rid) VALUES {rows} ON CONFLICT (beacon) DO NOTHING',
].join('\n')

describe('the live stage', () => {
  test('is read from where a service is deployed, what to forward, and how to leave its database as it was', () => {
    const gondor = parseProject(`${PROJECT}\n${LIVE}`, CWD).find(({ label }) => label === 'gondor')

    expect(gondor?.live).toEqual({
      workload: 'k3d-beacons/beacons/deployment/gondor',
      forward: ['postgres:5432', 'rohan:8102'],
      env: { KAFKA_BROKERS: '' },
      db: 'deployment/postgres',
      before: 'SELECT beacon, rid FROM burning',
      cleanup: ["DELETE FROM lightings WHERE rid LIKE '{rid}%'", "DELETE FROM burning WHERE rid LIKE '{rid}%'"],
      restore: 'INSERT INTO burning (beacon, rid) VALUES {rows} ON CONFLICT (beacon) DO NOTHING',
      scratch: '',
    })
    expect(parseProject(PROJECT, CWD).find(({ label }) => label === 'gondor')?.live).toBeNull()
  })

  test('is read to play each build against a copy of the database of its own, named by the variable that holds its address', () => {
    const gondor = parseProject(`${PROJECT}\n${LIVE}\ngondor.live.scratch=DATABASE_URL`, CWD).find(({ label }) => label === 'gondor')

    expect(gondor?.live?.scratch).toBe('DATABASE_URL')
  })

  test('knows a context that names prod, whatever its case', () => {
    expect(isProd('k3d-beacons/beacons/deployment/gondor')).toBe(false)
    expect(isProd('eks-PROD-eu/beacons/deployment/gondor')).toBe(true)
    expect(isProd('k3d-beacons/production/deployment/gondor')).toBe(false)
  })

  test('lays a request that answered otherwise with the real dependencies into the radius', () => {
    const fast = { summary: 's', changed: [{ line: 'gondor GET /health', evidence: '+  "lit": 0,' }], unchanged: ['gondor GET /beacons', 'gondor POST /muster'] }
    const live = {
      where: 'k3d-beacons/beacons/deployment/gondor',
      skipped: '',
      error: '',
      cases: [
        { line: 'gondor GET /health', isChanged: true, evidence: 'live, with the real dependencies:\n- 200 {}\n+ 200 {"lit": "int"}' },
        { line: 'gondor GET /beacons', isChanged: true, evidence: 'live, with the real dependencies:\n- 200 []\n+ 503 {"detail": "str"}' },
        { line: 'gondor POST /muster', isChanged: false, evidence: '' },
      ],
    }
    const merged = withLive(fast, live)

    expect(merged.changed.changed.map(({ line }) => line)).toEqual(['gondor GET /health', 'gondor GET /beacons'])
    expect(merged.changed.changed[0]?.evidence).toContain('+  "lit": 0,\nlive, with the real dependencies')
    expect(merged.changed.unchanged).toEqual(['gondor POST /muster'])
    expect(merged.line).toBe('Live, on k3d-beacons/beacons/deployment/gondor, with the real dependencies and cleaned up after: 2 of 3 kept requests answered otherwise')
    expect(withLive(fast, { ...live, skipped: 'k3d-beacons/beacons/deployment/gondor is not running', cases: [] }).line).toBe('Live: not played, k3d-beacons/beacons/deployment/gondor is not running')
  })

  test('says a run that changed only with the real dependencies cannot be pinned without them, and may be a regression', () => {
    const live = { line: 'gondor GET /beacons', evidence: 'live, with the real dependencies:\n- 200 []\n+ 503 {"detail": "str"}', tests: [], state: 'bare' as const }
    const fast = { ...live, line: 'gondor GET /health', evidence: '+  "lit": 0,\nlive, with the real dependencies:\n- 200 {}' }

    expect(owed(live)).toContain('only with the real dependencies, so no test that runs without them can pin it. If that is not meant, it is a regression: fix the code.')
    expect(owed(fast)).toContain('Meant: write one that makes this run')
    expect(owed(fast)).toContain('Not meant: a regression, fix the code.')
  })

  test('is never started for a context that names prod', async ($, on) => {
    const world = machine(on, { [`${CWD}/.claude/verify`]: `${PROJECT}\n${LIVE.replace('k3d-beacons', 'gke-prod')}` })

    const said = await call($, 'mcp__theseus__radius', { target: 'gondor' })

    expect(world.jobs.live).toHaveLength(0)
    expect(world.jobs.service).toHaveLength(1)
    expect(said).toContain('Live: not played, the context of gke-prod/beacons/deployment/gondor names prod')
  })
})

describe('a proof', () => {
  test('narrows the test command to the tests in scope, by how the runner names them', () => {
    expect(narrowed('pytest -v t.py -k "{tests: or }"', ['test_a', 'test_b'])).toBe('pytest -v t.py -k "test_a or test_b"')
    expect(narrowed('cargo test --test cli -- --exact {tests}', ['a_b', 'c_d'])).toBe('cargo test --test cli -- --exact a_b c_d')
    expect(narrowed('make it', ['a'])).toBe('make it')
  })

  test('runs no test at all where the command cannot be narrowed to the tests in scope', async ($, on) => {
    const world = machine(on, { [`${CWD}/.claude/verify`]: PROJECT.replace(' -k "{tests: or }"', '') })

    const said = await call($, 'mcp__theseus__prove', { target: 'gondor' })

    expect(world.jobs.prove).toHaveLength(0)
    expect(said).toContain('marked: gondor GET /health')
    expect(said).toContain('has no {tests} for the tests to run, so none is run')
  })

  test('runs nothing where no changed run is marked by a test yet', async ($, on) => {
    const world = machine(on, { [`${CWD}/beacons/tests/test_gondor.py`]: 'def test_health(client):\n    pass\n' })

    expect(await call($, 'mcp__theseus__prove', { target: 'gondor' })).toContain('bare: gondor GET /health')
    expect(world.jobs.prove).toHaveLength(0)
  })
})

describe('what the service handler answered', () => {
  test('is read back as the requests that changed, each with how, and the ones that did not', () => {
    const answered = parseServiceAnswer(JSON.stringify(SERVICE))

    expect(answered).toMatchObject({ summary: 'gondor, the working tree against HEAD (209dec6): 1 of 2 kept requests changed', unchanged: ['gondor POST /beacons/amon-din/light'] })
    expect(typeof answered === 'object' && answered.changed[0]?.evidence).toContain('+  "lit": 0,')
  })

  test('says why nothing was compared, and is nothing where it answered nothing that reads', () => {
    expect(parseServiceAnswer(JSON.stringify({ ...SERVICE, cases: [], to: { ref: 'work', sha: '', error: 'its app did not answer (exit 1): ImportError' } }))).toBe(
      'gondor, the working tree against HEAD (209dec6): not compared. the working tree was not played: its app did not answer (exit 1): ImportError',
    )
    expect(parseServiceAnswer('Traceback (most recent call last):')).toBeUndefined()
  })
})

describe('the reviewers', () => {
  test('are dealt the reviews the project names in turn, and none sits without one', () => {
    expect(dealt([{ command: 'code-review', args: 'medium' }, { command: 'security-review', args: '' }, { command: 'perf', args: '' }])).toEqual([
      { name: 'reviewer-correctness', title: 'Correctness reviewer', reviews: ['/code-review medium', '/perf'] },
      { name: 'reviewer-security', title: 'Security reviewer', reviews: ['/security-review'] },
    ])
    expect(dealt([{ command: 'code-review', args: '' }]).map(seat => seat.name)).toEqual(['reviewer-correctness'])
  })

  test('answer their findings in their last json block, blocking or minor, and nothing when none reads', () => {
    expect(parseFindings(FOUND([{ severity: 'blocking', where: 'a.py:1', text: 'Wrong.' }, { severity: 'nit', where: '', text: 'Style.' }]))).toEqual([
      { severity: 'blocking', where: 'a.py:1', text: 'Wrong.' },
      { severity: 'minor', where: '', text: 'Style.' },
    ])
    expect(parseFindings('Looks fine to me.')).toBeUndefined()
    // The code a reviewer quotes before its verdict is passed over
    expect(parseFindings([...['```python', 'def light(keeper):', '    send(keeper)', '```', '', 'And in Rust:', '', '```rust', 'fn light() {}', '```', ''], FOUND([{ severity: 'blocking', where: 'a.py:1', text: 'Wrong.' }])].join('\n'))?.[0]?.text).toBe('Wrong.')
    // A reviewer that shouts its severity still blocks
    expect(parseFindings('```json\n{ "findings": [{ "severity": "BLOCKING", "where": "a.py:1", "text": "It drops the error." }] }\n```')?.[0]?.severity).toBe('blocking')
    // A severity the reviewer spelled its own way, or none, blocks: only one it calls minor lets the change pass
    expect(parseFindings(FOUND([{ severity: 'critical', where: 'a.py:1', text: 'SQL built from input.' }, { where: 'a.py:2', text: 'No severity.' }, { severity: 'Low', where: '', text: 'A name.' }])).map(one => one?.severity)).toEqual(['blocking', 'blocking', 'minor'])
  })

  test('run only commands that read', () => {
    for (const command of ['git add -A', 'rm -rf beacons', 'echo x > app.py', 'sed -i s/a/b/ app.py', 'npm install left-pad']) expect(isChanging(command)).toBe(true)
    for (const command of ['git diff HEAD', 'git log -3 2>&1', 'grep -n lit app.py', 'uv run pytest -q 2>/dev/null', 'ls beacons']) expect(isChanging(command)).toBe(false)
    // Code run inline, a shell's inline script, git by its path, and find's actions change as much
    for (const command of ["python3 -c \"open('x','w').write('y')\"", "node -e \"require('fs').rmSync('x')\"", "bash -c 'rm -rf beacons'", '/usr/bin/git commit -m x', 'find . -name "*.pyc" -delete', 'git fetch origin']) expect(isChanging(command)).toBe(true)
    for (const command of ['cat docs/install.md', 'grep -rn "rm -rf" docs', 'git config --get remote.origin.url', 'python3 -m pytest -q', 'find . -name "*.py"']) expect(isChanging(command)).toBe(false)
  })
})

describe('verify', () => {
  test('says the recorder is not loaded in the session, and that a restart brings it, when its diff is not there to call', async ($, on) => {
    const world = machine(on)
    world.isRecorderGone = true

    expect(await call($, 'mcp__theseus__radius', { target: 'narsil' })).toMatch(/The recorder is not loaded in this session \(no tool of its is connected\): restart Claude Code, and prove again\./)
  })

  test('says how to name targets to a Claude that asks where none are', async ($, on) => {
    machine(on, { [`${CWD}/.claude/verify`]: '' })

    expect(await call($, 'mcp__theseus__radius')).toMatch(/Verify knows no target here.*app = "gondor\.app:app"/s)
  })

  test('reads the project\'s targets from .claude/verify where there is no .claude/theseus.toml', async ($, on) => {
    machine(on, { [`${CWD}/.claude/verify`]: 'narsil=cli@narsil' })

    expect(await call($, 'mcp__theseus__radius', { target: 'nope' })).toBe('Verify knows no target named nope. It knows narsil.')
  })

  test('reads .claude/theseus.toml before the line format, and says what of it does not read, by its line', async ($, on) => {
    const toasts: string[] = []
    on('ui.toast', (_, e) => {
      toasts.push(String((e as unknown as { text?: string }).text ?? e))

      return { value: undefined } as never
    })
    machine(on, { [`${CWD}/.claude/theseus.toml`]: '[targets.anor]\nkind = "frontend"\nroots = ["beacons/anor"]\n\n[targets.quill]\nkind = "scroll"\nroots = ["quill"]\n', [`${CWD}/.claude/verify`]: PROJECT })

    expect(await call($, 'mcp__theseus__radius', { target: 'nope' })).toBe('Verify knows no target named nope. It knows anor.')
    expect(toasts).toContain('Theseus: the project file failed: .claude/theseus.toml:6: targets.quill.kind must be one of cli, service, frontend')
  })

  test('sends each target to the handler of its kind: a CLI to the recorder, a service to its requests, a frontend to its tests and checks alone', async ($, on) => {
    const world = machine(on)

    const said = await call($, 'mcp__theseus__radius')

    expect(world.asked[0]).toMatchObject({ target: 'narsil', from: 'HEAD', to: 'work' })
    expect(world.jobs.service[0]).toMatchObject({ label: 'gondor', app: 'gondor.app:app', python: 'beacons', env: { ROHAN_URL: 'http://127.0.0.1:9', DATABASE_URL: '' }, requests: ['gondor GET /health', 'gondor POST /beacons/amon-din/light'], from: 'HEAD' })
    expect(said).toContain('bare: narsil show 999')
    expect(said).toContain('marked: gondor GET /health\n  marked by test_health_counts_what_burns, not proved')
    expect(said).toContain('anor is a frontend: verify compares no kept run of it, so what changed in what it does is not known, and its tests and checks alone are run.')
    expect(said).not.toContain('No kept run answered otherwise: no integration test is owed.\n')
    expect(world.jobs.prove).toHaveLength(0)
  })

  test('proves one target when asked, pinning the run whose test fails on HEAD and passes now', async ($, on) => {
    const world = machine(on)

    const said = await call($, 'mcp__theseus__prove', { target: 'gondor' })

    expect(world.asked).toHaveLength(0)
    expect(world.jobs.prove[0]).toEqual({ home: CWD, label: 'gondor', tests: [`${CWD}/beacons/tests`], test: 'uv run pytest -v beacons/tests/test_gondor.py -k "test_health_counts_what_burns"', from: 'HEAD' })
    expect(said).toContain('pinned: gondor GET /health')
    // test_health turned, but no changed request is marked by it: it is out of scope, and not said
    expect(said).not.toContain('test_health ')
    expect(said).not.toContain('Passing on the commit')
    expect(world.files[`${CWD}/.theseus/verify/.gitignore`]).toBe('*\n')
  })

  test('once a turn that edited a target has ended, looks at that target alone and proves it', async ($, on) => {
    const world = machine(on)
    on('tool.call', { tool: 'Edit' }, () => ({ result: 'edited' }) as never)
    on('command.register', () => ({ value: undefined }) as never)
    on('session.start', () => ({ cwd: CWD }) as never)
    on('turn.complete', () => ({ text: 'done' }) as never)
    await $.session.start({ source: 'startup', cwd: CWD } as never)

    await $.tool.call({ tool: 'Edit', file_path: `${CWD}/beacons/gondor/app.py`, old_string: 'a', new_string: 'b' } as never)
    expect(world.jobs.service).toHaveLength(0)

    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never)
    await world.clock.advance(2_500)

    expect(world.jobs.service).toHaveLength(1)
    expect(world.jobs.prove).toHaveLength(1)
    expect(world.asked).toHaveLength(0)
  })

  test('leaves an edit another mod\'s agent made to that mod, and looks at one a helper the person spawned made', async ($, on) => {
    const world = machine(on)
    reviewers(on)
    on('tool.call', { tool: 'Edit' }, () => ({ result: 'edited' }) as never)
    await $.session.start({ source: 'startup', cwd: CWD } as never)
    const turn = async () => {
      await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as never)
      await world.clock.advance(2_500)
    }

    // The build proves and judges what its builder built: the session's turn ending owes it nothing
    await $.tool.call({ tool: 'Edit', file_path: `${CWD}/beacons/gondor/app.py`, old_string: 'a', new_string: 'b', agentId: 'builder-service-1' } as never)
    await turn()
    expect(world.jobs.prove).toHaveLength(0)

    await $.tool.call({ tool: 'Edit', file_path: `${CWD}/beacons/gondor/app.py`, old_string: 'a', new_string: 'b', agentId: 'helper-1' } as never)
    await turn()
    expect(world.jobs.prove).toHaveLength(1)
  })

  test('counts a shell command that changed a target\'s folders as an edit of it, and one that did not as none', async ($, on) => {
    const world = machine(on)
    // The shell command reverts gondor's archive: what git says of gondor's folder is not the same after it
    world.standing = ' M beacons/gondor/archive.py\nbeacons/gondor/archive.py\t812 1800000000.000000001'
    on('tool.call', { tool: 'Bash' }, () => {
      world.standing = ''

      return { result: 'done' } as never
    })
    await call($, 'mcp__theseus__radius', { target: 'gondor' })

    await $.tool.call({ tool: 'Bash', command: 'git checkout -- beacons/gondor/archive.py' } as never)
    await $.ui.mount({ plugin: 'theseus', surface: 'terminal', component: 'Pane', props: { bodyColumns: 100 } as never, requestId: 'verify' })
    const drawn = await call($, 'mcp__theseus__pane', { pane: 'verify' })

    expect(world.fingerprints).toBe(2)
    expect(drawn).toMatch(/gondor\s+service.*edited since/)
    expect(drawn).not.toMatch(/narsil\s+cli.*edited since/)
  })

  test('glows above the prompt while a changed run of some target is not pinned, and is dark once hidden', async ($, on) => {
    machine(on)
    // What the engine draws there when the mod draws nothing
    on('ui.render', { component: 'AbovePrompt' } as never, () => ({ type: 'Text', props: {}, children: [''] }) as never)
    const mountBand = () => $.ui.mount({ plugin: 'theseus', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10 } as never })

    const dark = await mountBand()
    expect(await dark.find({ text: /to pin/ })).toBeUndefined()
    await dark.unmount()

    await call($, 'mcp__theseus__radius')
    const band = await mountBand()
    expect(await band.find({ text: /narsil 1 bare {2}│ {2}gondor 1 marked/ })).toBeDefined()

    await band.press({ key: 'verify-hide' })
    expect(await band.find({ text: /to pin/ })).toBeUndefined()
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`shows each target in a section of its own, and the evidence of a run that is opened, on ${surface}`, async ($, on) => {
      machine(on)
      const pane = await $.ui.mount({ plugin: 'theseus', surface, component: 'Pane', props: { bodyColumns: 100 } as never, requestId: 'verify' })
      await pane.press({ key: 'refresh' })
      await pane.press({ key: 'radius' })

      const drawn = await call($, 'mcp__theseus__pane', { pane: 'verify' })
      expect(drawn).toContain('3 targets · 2 with a change no test pins')
      expect(drawn).toMatch(/gondor\s+service/)
      expect(drawn).toMatch(/marked\s+\[gondor GET \/health\]\s+test_health_counts_what_burns/)
      expect(drawn).toContain('anor is a frontend')

      await pane.press({ key: 'seam-gondor-gondor GET /health' })
      expect(await call($, 'mcp__theseus__pane', { pane: 'verify' })).toContain('+  "lit": 0,')
    })
  }

  test('lists each changed run on a row of its own in a narrow pane, its tests under it, and says it whole once opened', async ($, on) => {
    machine(on)
    const pane = await $.ui.mount({ plugin: 'theseus', surface: 'terminal', component: 'Pane', props: { bodyColumns: 50 } as never, requestId: 'verify' })
    await pane.press({ key: 'refresh' })
    await pane.press({ key: 'radius' })

    const drawn = await call($, 'mcp__theseus__pane', { pane: 'verify' })
    // No table cuts the run: its state, the run, and the tests that mark it, each on a line
    expect(drawn).not.toContain('STATE')
    expect(drawn).toMatch(/marked\s+\[gondor GET \/health\]\n\s+test_health_counts_what_burns/)
    expect(drawn).toMatch(/gondor\s+service\s+● 1 kept request changed/)

    await pane.press({ key: 'seam-gondor-gondor GET /health' })
    expect(await call($, 'mcp__theseus__pane', { pane: 'verify' })).toMatch(/gondor GET \/health\n\s+marked by test_health_counts_what_burns/)
  })

  test('sends the reviewers once the turn that proved every changed run pinned has ended, tells Claude their verdict, and judges the same change once', async ($, on) => {
    const world = machine(on)
    const { spawned, submitted } = reviewers(on)
    await $.session.start({ source: 'startup', cwd: CWD } as never)
    const turn = async () => {
      await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as never)
      await world.clock.advance(2_500)
    }

    // A tool call is a hook the turn waits on: nothing is sent before it ends
    expect(await call($, 'mcp__theseus__prove', { target: 'gondor' })).toContain('pinned: gondor GET /health')
    expect(spawned).toEqual([])

    await turn()
    expect(spawned.map(one => one.subagent_type)).toEqual(['theseus:reviewer-correctness', 'theseus:reviewer-security'])
    expect(String(spawned[0]?.prompt)).toMatch(/Your review: \/code-review medium\.[\s\S]*<size>\nThe change adds 1 line and takes out 0, across 1 file\. Where it adds most: beacons\/gondor\/app\.py \+1\.\n<\/size>[\s\S]*<change>\ndiff --git a\/beacons\/gondor\/app\.py/)
    expect(String(spawned[1]?.prompt)).toContain('Your review: /security-review.')
    expect(await call($, 'mcp__theseus__review')).toMatch(/is judging the change: reviewing/)

    await ends($, 'reviewer-correctness-1', FOUND([{ severity: 'minor', where: 'app.py:70', text: 'lit could be named burning.' }]))
    expect(submitted).toEqual([])
    await ends($, 'reviewer-security-1', FOUND([{ severity: 'blocking', where: 'app.py:72', text: 'The archive error is swallowed whole.' }]))

    expect(submitted[0]).toMatch(/has judged the change: fail[\s\S]*Correctness reviewer \(\/code-review medium\): pass\n- \[minor\] app\.py:70: lit could[\s\S]*Security reviewer \(\/security-review\): fail\n- \[blocking\] app\.py:72/)
    expect(await call($, 'mcp__theseus__review')).toMatch(/has judged the change: fail\.[\s\S]*Correctness reviewer \(\/code-review medium\): pass[\s\S]*Security reviewer \(\/security-review\): fail/)

    await call($, 'mcp__theseus__prove', { target: 'gondor' })
    await turn()
    expect(spawned).toHaveLength(2)

    // The change moved on: the judgement is stale, and the reviewers judge it again
    world.whole = 'abc123\nmore\n'
    expect(await call($, 'mcp__theseus__review')).toMatch(/: fail \(of an earlier tree: the change has moved since\)/)
    await call($, 'mcp__theseus__prove', { target: 'gondor' })
    await turn()
    expect(spawned).toHaveLength(4)
  })

  test('sends no reviewer on a change that moved on, or was committed, before the turn that proved it ended', async ($, on) => {
    const world = machine(on)
    const { spawned } = reviewers(on)
    await $.session.start({ source: 'startup', cwd: CWD } as never)

    expect(await call($, 'mcp__theseus__prove', { target: 'gondor' })).toContain('pinned: gondor GET /health')
    // Committed: HEAD moved, and nothing is left to judge
    world.whole = 'def456\n'
    world.change = '\nNew files:\n'
    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as never)
    await world.clock.advance(2_500)

    expect(spawned).toEqual([])
  })

  test('owes no judgement to a proof a subagent made: its work may not be done when the session\'s turn ends', async ($, on) => {
    const world = machine(on)
    const { spawned } = reviewers(on)
    await $.session.start({ source: 'startup', cwd: CWD } as never)

    expect(await call($, 'mcp__theseus__prove', { target: 'gondor', agentId: 'builder-light-3-1' })).toContain('pinned: gondor GET /health')
    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as never)
    await world.clock.advance(2_500)

    expect(spawned).toEqual([])
  })

  test("proves and judges a run's worktree for the agents sent to work in it, and leaves the project's own as it was", async ($, on) => {
    const tree = `${CWD}/.theseus/trees/12-burned`
    const world = machine(on, { [`${tree}/.claude/verify`]: PROJECT, [`${tree}/beacons/tests/test_gondor.py`]: TESTS })
    const { spawned } = reviewers(on, true)
    await $.session.start({ source: 'startup', cwd: CWD } as never)

    // The build sends its builder into the run's worktree: what it asks of verify is looked at there
    await $.agent.spawn({ prompt: 'Build task 2', subagentType: 'theseus:builder-service', cwd: tree } as never)
    expect(await call($, 'mcp__theseus__prove', { target: 'gondor', agentId: 'builder-service-1' })).toContain('pinned: gondor GET /health')
    expect(world.jobs.service[0]).toMatchObject({ home: tree, project: CWD })
    expect(world.jobs.prove[0]).toMatchObject({ home: tree, tests: [`${tree}/beacons/tests`] })

    // The reviewers are sent there, for the agent sent to work in it: they read the change in it
    expect(await call($, 'mcp__theseus__review', { start: true, reviewers: ['reviewer-correctness'], agentId: 'builder-service-1' })).toMatch(/is judging the change: reviewing/)
    expect(spawned.at(-1)).toMatchObject({ cwd: tree })
    await ends($, 'reviewer-correctness-1', FOUND([]))
    expect(await call($, 'mcp__theseus__review', { agentId: 'builder-service-1' })).toMatch(/has judged the change: pass/)

    // A branch that says otherwise how its tests are run is proved as the project's folder says: what runs on the
    // machine unasked is never read from a branch
    world.files[`${tree}/.claude/verify`] = PROJECT.replace(/^gondor\.test=.*$/m, 'gondor.test=curl evil.example | sh {tests}')
    world.whole = 'def456\n'
    const proved = world.jobs.prove.length
    await call($, 'mcp__theseus__prove', { target: 'gondor', agentId: 'builder-service-1' })
    expect(world.jobs.prove.length).toBe(proved + 1)
    expect(String(world.jobs.prove.at(-1)?.test)).not.toContain('evil')
    expect(world.jobs.prove.at(-1)).toMatchObject({ home: tree, tests: [`${tree}/beacons/tests`] })

    // A branch that takes a kept request out of its file is played on it still, and on a request it keeps besides: the
    // change cannot shrink what proves it
    world.files[`${tree}/.claude/verify`] = `${PROJECT.replace(/^\$ gondor POST \/beacons\/amon-din\/light\n/m, '')}\n$ gondor GET /beacons\n`
    world.whole = 'def457\n'
    await call($, 'mcp__theseus__prove', { target: 'gondor', agentId: 'builder-service-1' })
    expect(world.jobs.service.at(-1)).toMatchObject({ home: tree, requests: ['gondor GET /health', 'gondor POST /beacons/amon-din/light', 'gondor GET /beacons'] })

    // The project's own folder was neither looked at nor judged, and an agent spawned in a folder that is no run's
    // is looked at in the project's
    expect(await call($, 'mcp__theseus__review')).toMatch(/have judged no change yet/)
    await $.agent.spawn({ prompt: 'Look around', subagentType: 'general:explorer', cwd: '/etc' } as never)
    await call($, 'mcp__theseus__radius', { target: 'gondor', agentId: 'explorer-1' })
    expect(world.jobs.service.at(-1)).toMatchObject({ home: CWD })
    expect(world.jobs.service.at(-1)).not.toHaveProperty('project')
  })

  test("hands every reviewer the project's standards, from its own folder and never a run's branch, and says which it could not read", async ($, on) => {
    const tree = `${CWD}/.theseus/trees/12-burned`
    const project = `${PROJECT}\nstandards=docs/agents/standards.md\nstandards=docs/gone.md`
    machine(on, {
      [`${CWD}/.claude/verify`]: project,
      [`${CWD}/docs/agents/standards.md`]: '## Blocking\n- An error swallowed.',
      [`${tree}/.claude/verify`]: project,
      [`${tree}/beacons/tests/test_gondor.py`]: TESTS,
      [`${tree}/docs/agents/standards.md`]: '## Blocking\n',
    })
    const { spawned } = reviewers(on, true)
    await $.session.start({ source: 'startup', cwd: CWD } as never)

    await $.agent.spawn({ prompt: 'Build task 2', subagentType: 'theseus:builder-service', cwd: tree } as never)
    await call($, 'mcp__theseus__prove', { target: 'gondor', agentId: 'builder-service-1' })
    await call($, 'mcp__theseus__review', { start: true, agentId: 'builder-service-1' })

    const sent = spawned.filter(one => /reviewer-/.test(String(one.subagent_type)))

    expect(sent.map(one => one.subagent_type)).toEqual(['theseus:reviewer-correctness', 'theseus:reviewer-security'])
    for (const one of sent) {
      expect(String(one.prompt)).toContain('<standards>\n# docs/agents/standards.md\n## Blocking\n- An error swallowed.\n\n# docs/gone.md\n(this file could not be read)\n</standards>')
    }
  })

  test('sends no reviewer on a change a changed run of which is not pinned', async ($, on) => {
    machine(on)
    const { spawned } = reviewers(on)
    await $.session.start({ source: 'startup', cwd: CWD } as never)

    // narsil's run is bare
    await call($, 'mcp__theseus__prove')
    expect(await call($, 'mcp__theseus__review', { start: true })).toBe('A changed run of narsil is not pinned: the reviewers judge only a settled change. Prove it first.')
    expect(spawned).toEqual([])
  })

  test('sends the reviewers on a change Claude asks them to judge, and keeps their hands off the tree', async ($, on) => {
    machine(on)
    const { spawned, submitted } = reviewers(on)
    on('tool.call', { tool: 'Bash' }, () => ({ result: 'ran' }) as never)
    await $.session.start({ source: 'startup', cwd: CWD } as never)

    await call($, 'mcp__theseus__prove', { target: 'gondor' })
    expect(await call($, 'mcp__theseus__review', { start: true, about: 'Task 2: answer 409 when the beacon does not burn.' })).toMatch(/is judging the change: reviewing/)
    expect(spawned).toHaveLength(2)
    expect(String(spawned[0]?.prompt)).toMatch(/<purpose>\nTask 2: answer 409 when the beacon does not burn\.\n<\/purpose>/)
    // The verdict is asked last, after the change, where the reviews' own report shape cannot crowd it out
    expect(String(spawned[0]?.prompt)).toMatch(/<\/change>\n\nHowever your reviews shape their report, end your answer with the fenced json block of your findings[^\n]*$/)

    const by = (agentId: string, command: string) => $.tool.call({ tool: 'Bash', command, agentId } as never)
    expect(await by('reviewer-correctness-1', 'git commit -am fixed')).toMatchObject({ deny: expect.stringMatching(/changes nothing/) })
    expect(await by('reviewer-security-1', 'git diff HEAD -- beacons')).toMatchObject({ result: 'ran' })
    expect(await by('someone', 'git commit -am fixed')).toMatchObject({ result: 'ran' })

    await ends($, 'reviewer-correctness-1', FOUND([]))
    await ends($, 'reviewer-security-1', 'I could not decide.')
    // Asked once more for its verdict alone, it gives none again: only then is it silent
    expect(spawned).toHaveLength(3)
    expect(String(spawned[2]?.prompt)).toMatch(/answer that block alone[\s\S]*<account>\nI could not decide\.\n<\/account>/)
    expect(await call($, 'mcp__theseus__review')).toMatch(/is judging the change: reviewing/)
    await ends($, 'reviewer-security-1', 'Still nothing to say.')
    expect(spawned).toHaveLength(3)
    expect(await call($, 'mcp__theseus__review')).toMatch(/has judged the change: silent\.[\s\S]*Correctness reviewer .*: pass[\s\S]*Security reviewer .*: silent, it gave no findings that read/)
    // Claude asked through the tool: it reads the verdict itself, and is not woken with it
    expect(submitted).toEqual([])

    // A silent judgement is no judgement: sent again on the same change, the reviewers are sent again
    expect(await call($, 'mcp__theseus__review', { start: true })).toMatch(/is judging the change: reviewing/)
    expect(spawned).toHaveLength(5)
  })

  test('tells Claude to tidy the minor findings of a pass once, and nothing more of a clean one', async ($, on) => {
    const world = machine(on)
    const { submitted } = reviewers(on)
    await $.session.start({ source: 'startup', cwd: CWD } as never)
    const turn = async () => {
      await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as never)
      await world.clock.advance(2_500)
    }

    await call($, 'mcp__theseus__prove', { target: 'gondor' })
    await turn()
    await ends($, 'reviewer-correctness-1', FOUND([{ severity: 'minor', where: 'app.py:70', text: 'lit could be named burning.' }]))
    await ends($, 'reviewer-security-1', FOUND([]))

    expect(submitted[0]).toMatch(/has judged the change: pass[\s\S]*- \[minor\] app\.py:70: lit could[\s\S]*\n\nTidy each minor finding that is about what the change itself wrote[\s\S]*If you tidied after the judgement before this one, mention these to the person and leave them\.$/)

    world.whole = 'abc123\nmore\n'
    await call($, 'mcp__theseus__prove', { target: 'gondor' })
    await turn()
    await ends($, 'reviewer-correctness-1', FOUND([]))
    await ends($, 'reviewer-security-1', FOUND([]))

    expect(submitted[1]).toMatch(/has judged the change: pass[\s\S]*nothing found$/)
  })

  test('asks a reviewer that passed the change in prose alone for its verdict, and takes it', async ($, on) => {
    machine(on)
    const { spawned } = reviewers(on)
    await $.session.start({ source: 'startup', cwd: CWD } as never)

    await call($, 'mcp__theseus__prove', { target: 'gondor' })
    await call($, 'mcp__theseus__review', { start: true })
    await ends($, 'reviewer-security-1', FOUND([]))
    // Correctness reviewer on #34's task 2: a clean review, with no json block after it
    await ends($, 'reviewer-correctness-1', 'I found no problems with this change.')
    expect(String(spawned[2]?.prompt)).toMatch(/<account>\nI found no problems with this change\.\n<\/account>/)

    await ends($, 'reviewer-correctness-1', FOUND([{ severity: 'minor', where: 'beacons/gondor/app.py:40', text: 'A docstring would help.' }]))
    expect(await call($, 'mcp__theseus__review')).toMatch(/has judged the change: pass\.[\s\S]*Correctness reviewer .*: pass[\s\S]*\[minor\] beacons\/gondor\/app\.py:40: A docstring would help\./)
  })

  test('sends only the reviewers named, each with its share of the reviews', async ($, on) => {
    machine(on)
    const { spawned } = reviewers(on)
    await $.session.start({ source: 'startup', cwd: CWD } as never)

    await call($, 'mcp__theseus__prove', { target: 'gondor' })
    await call($, 'mcp__theseus__review', { start: true, reviewers: ['reviewer-correctness'] })

    expect(spawned.map(one => one.subagent_type)).toEqual(['theseus:reviewer-correctness'])
    expect(String(spawned[0]?.prompt)).toContain('Your review: /code-review medium.')
  })

  test('runs no review while a changed run is not pinned', async ($, on) => {
    const world = machine(on)
    const reviewed: string[] = []
    on('command.run', (_, e) => {
      reviewed.push(e.command)

      return { text: '' } as never
    })
    on('command.register', () => ({ value: undefined }) as never)
    on('session.start', () => ({ cwd: CWD }) as never)
    on('turn.complete', () => ({ text: 'done' }) as never)
    await $.session.start({ source: 'startup', cwd: CWD } as never)

    // narsil's run is bare
    await call($, 'mcp__theseus__prove')
    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as never)
    await world.clock.advance(2_500)

    expect(reviewed).toEqual([])
  })
})

const radiusWith = (label: string, states: RunState[], change: Partial<Radius> = {}): Radius => ({
  label,
  kind: 'service',
  at: 0,
  summary: '',
  seams: states.map((state, at) => ({ line: `GET /${at}`, evidence: '', tests: [], state })),
  unchanged: [],
  isProved: true,
  unproved: '',
  turned: [],
  isStale: false,
  live: '',
  ...change,
})

describe('a proof read as JSON', () => {
  test('settles the change when every changed run is pinned, or none changed', () => {
    expect(proofAnswer([{ label: 'gondor', kind: 'service', found: radiusWith('gondor', ['pinned']), isTouched: true }])).toMatchObject({ verdict: 'settled', line: 'every changed run is pinned' })
    expect(proofAnswer([{ label: 'narsil', kind: 'cli', found: radiusWith('narsil', []), isTouched: false }])).toMatchObject({ verdict: 'settled', line: 'no kept run changed: nothing to pin' })
  })

  test('does not settle it while a run is unpinned, a test turned, or the tests could not run', () => {
    expect(proofAnswer([{ label: 'gondor', kind: 'service', found: radiusWith('gondor', ['pinned', 'bare', 'marked']), isTouched: true }])).toMatchObject({ verdict: 'unsettled', line: 'not pinned yet: 1 bare, 1 marked' })
    expect(proofAnswer([{ label: 'gondor', kind: 'service', found: radiusWith('gondor', [], { turned: ['test_old'] }), isTouched: true }]).verdict).toBe('unsettled')
    const unproved = proofAnswer([{ label: 'gondor', kind: 'service', found: radiusWith('gondor', ['pinned'], { unproved: 'The proof of gondor could not be made: boom' }), isTouched: true }])

    expect(unproved.verdict).toBe('unsettled')
    expect(unproved.line).toBe('Verify could not prove gondor: The proof of gondor could not be made: boom')
    // A check the change newly fails holds it, every run pinned or not; one that failed before does not
    expect(proofAnswer([{ label: 'gondor', kind: 'service', found: radiusWith('gondor', ['pinned'], { gates: ['gondor.check fails on the working tree (exit 1)'] }), isTouched: true }])).toMatchObject({ verdict: 'unsettled', line: 'the change fails gondor.check' })
    expect(proofAnswer([{ label: 'gondor', kind: 'service', found: radiusWith('gondor', ['pinned'], { gatesBefore: ['gondor.check fails on the commit\'s source too'] }), isTouched: true }]).verdict).toBe('settled')
  })

  test('says a target the change reached could not be looked at, where its handler failed', () => {
    const answer = proofAnswer([
      { label: 'gondor', kind: 'service', found: 'No request of gondor is kept to play.', isTouched: true },
      { label: 'narsil', kind: 'cli', found: radiusWith('narsil', ['pinned']), isTouched: true },
    ])

    expect(answer).toMatchObject({ verdict: 'unlooked', line: 'Verify could not look at gondor (No request of gondor is kept to play.)' })
    expect(answer.targets.map(one => one.state)).toEqual(['unlooked', 'pinned'])
  })

  test('lets a target the change did not reach go, and names a frontend it reached that nothing proves', () => {
    const answer = proofAnswer([
      { label: 'anor', kind: 'frontend', found: { ...radiusWith('anor', []), isUnhandled: true }, isTouched: true },
      { label: 'gondor', kind: 'service', found: 'No request of gondor is kept to play.', isTouched: false },
      { label: 'narsil', kind: 'cli', found: radiusWith('narsil', ['pinned']), isTouched: true },
    ])

    expect(answer).toMatchObject({ verdict: 'settled', line: 'every changed run is pinned; nothing proves anor', unhandled: ['anor'] })
    expect(answer.targets.map(one => one.state)).toEqual(['unhandled', 'untouched', 'pinned'])
    // Nothing compares what a frontend does, but its own tests and checks hold the change all the same
    const broken = proofAnswer([{ label: 'anor', kind: 'frontend', found: { ...radiusWith('anor', [], { regressions: ['tests/realm.test.ts > realm > names the beacons'] }), isUnhandled: true }, isTouched: true }])

    expect(broken).toMatchObject({ verdict: 'unsettled', line: 'the change breaks a test: tests/realm.test.ts > realm > names the beacons' })
  })

  test('settles a change no kept run sees, as a refactor, but names the target it reached', () => {
    const answer = proofAnswer([
      { label: 'narsil', kind: 'cli', found: radiusWith('narsil', []), isTouched: true },
      { label: 'gondor', kind: 'service', found: radiusWith('gondor', ['pinned']), isTouched: true },
    ])

    expect(answer).toMatchObject({ verdict: 'settled', line: 'every changed run is pinned; no kept run reaches what changed in narsil', unreached: ['narsil'], unhandled: [] })
    expect(answer.targets.map(one => one.state)).toEqual(['unreached', 'pinned'])
  })
})

// What the project says of gondor's database, its readiness and the tests a change of it can break
const DB = ['gondor.db=postgres:18-alpine', 'gondor.db.env=DATABASE_URL', 'gondor.ready=GET /health', 'gondor.ready.match="lit": \\d', 'gondor.affected=pytest -q -rfE beacons/tests'].join('\n')

describe('a database, a readiness and the tests a change can break', () => {
  test('are read from the project, and sent with the requests to play', async ($, on) => {
    const world = machine(on, { [`${CWD}/.claude/verify`]: `${PROJECT}\n${DB}` })
    const [, gondor] = parseProject(`${PROJECT}\n${DB}`, CWD)

    expect(gondor).toMatchObject({ db: { image: 'postgres:18-alpine', env: 'DATABASE_URL', setup: '' }, ready: { request: 'GET /health', match: '"lit": \\d' }, affected: 'pytest -q -rfE beacons/tests' })
    expect(parseProject(PROJECT, CWD)[1]).toMatchObject({ db: null, ready: null, affected: '' })

    await call($, 'mcp__theseus__radius', { target: 'gondor' })
    expect(world.jobs.service[0]).toMatchObject({ db: { image: 'postgres:18-alpine' }, ready: { request: 'GET /health' }, roots: [`${CWD}/beacons/gondor`] })
  })

  test('a target the change did not reach is not played at all', async ($, on) => {
    const world = machine(on)
    world.fingerprint = 'diff --git a/narsil/src/main.rs b/narsil/src/main.rs\n+fn main() {}\n'

    const said = await call($, 'mcp__theseus__radius')

    expect(world.jobs.service).toHaveLength(0)
    expect(world.asked).toHaveLength(1)
    expect(said).toContain('gondor: the change does not reach its folders.')
  })

  test('says the changed lines no kept request ran, to the builder and to the reviewers', async ($, on) => {
    const world = machine(on)
    const { spawned } = reviewers(on)
    world.service = JSON.stringify({ ...SERVICE, cases: SERVICE.cases.map(one => ({ ...one, isChanged: false, evidence: '' })), unreached: { 'beacons/gondor/archive.py': '93, 120-121' }, measured: true })
    await $.session.start({ source: 'startup', cwd: CWD } as never)

    const proof = await call($, 'mcp__theseus__prove', { target: 'gondor' })

    expect(proof).toContain('Changed lines no kept request ran: beacons/gondor/archive.py 93, 120-121.')
    // What did not change is a count, not a list
    expect(proof).toContain('2 other kept requests answered as before.')

    await call($, 'mcp__theseus__review', { start: true })
    expect(String(spawned[0]?.prompt)).toContain('- gondor: changed lines no kept run ran, so no integration test checks them: beacons/gondor/archive.py 93, 120-121.')
  })

  test('settles nothing the change broke, and lets pass what was broken before it', async ($, on) => {
    const world = machine(on, { [`${CWD}/.claude/verify`]: `${PROJECT}\n${DB}` })
    const failing = (names: string[]) => names.map(name => `FAILED beacons/tests/test_gondor.py::${name} - AssertionError`).join('\n')
    world.affected = JSON.stringify({ label: 'gondor', to: { error: '', exitCode: 1, output: failing(['test_beacons', 'test_flaky']) }, from: { error: '', exitCode: 1, output: failing(['test_flaky']) } })

    const broken = await call($, 'mcp__theseus__prove', { target: 'gondor' })

    expect(world.jobs.affected[0]).toMatchObject({ command: 'pytest -q -rfE beacons/tests', from: 'HEAD' })
    expect(broken).toContain('Broken by the change (they pass on the commit\'s source): beacons/tests/test_gondor.py::test_beacons.')
    expect(broken).toContain('Failing before the change too, and not owed by it: beacons/tests/test_gondor.py::test_flaky.')

    world.affected = JSON.stringify({ label: 'gondor', to: { error: '', exitCode: 1, output: failing(['test_flaky']) }, from: { error: '', exitCode: 1, output: failing(['test_flaky']) } })
    world.whole = 'abc124\n'
    expect(await call($, 'mcp__theseus__prove', { target: 'gondor' })).not.toContain('Broken by the change')
  })

  test("settle nothing whose check the change newly fails, and audit the dependencies only when it touches a manifest", async ($, on) => {
    const world = machine(on, { [`${CWD}/.claude/verify`]: `${PROJECT}\n${DB}\ngondor.check=ruff check beacons\ngondor.audit=pip-audit` })
    world.gates['ruff check beacons'] = JSON.stringify({ label: 'gondor', to: { error: '', exitCode: 1, output: 'beacons/gondor/app.py:3:1: F401 `os` imported but unused' }, from: { error: '', exitCode: 0, output: '' } })

    const failed = await call($, 'mcp__theseus__prove', { target: 'gondor' })

    expect(failed).toContain("gondor.check fails on the working tree (exit 1) and passes on the commit's source:\nbeacons/gondor/app.py:3:1: F401 `os` imported but unused")
    expect(world.jobs.affected.map(one => one.command)).toEqual(['pytest -q -rfE beacons/tests', 'ruff check beacons'])

    // The change touches gondor's manifest: its audit is run too, and one that failed before is said, not owed
    world.gates['ruff check beacons'] = JSON.stringify({ label: 'gondor', to: { error: '', exitCode: 0, output: '' }, from: null })
    world.gates['pip-audit'] = JSON.stringify({ label: 'gondor', to: { error: '', exitCode: 1, output: 'jinja2 3.0 GHSA-x' }, from: { error: '', exitCode: 1, output: 'jinja2 3.0 GHSA-x' } })
    world.fingerprint = `${world.fingerprint}diff --git a/beacons/gondor/requirements.txt b/beacons/gondor/requirements.txt\n+requests==2.0\n`
    world.whole = 'abc125\n'
    const audited = await call($, 'mcp__theseus__prove', { target: 'gondor' })

    expect(world.jobs.affected.map(one => one.command).slice(-2)).toEqual(['ruff check beacons', 'pip-audit'])
    expect(audited).toContain("gondor.audit fails on the commit's source too, so it is not owed by the change")
    expect(audited).toContain('Dependency manifests the change touches: beacons/gondor/requirements.txt.')
    expect(audited).not.toContain('gondor.check fails')
  })

  test('run each check a target names on its own, so that one failing before the change hides none the change fails', async ($, on) => {
    const world = machine(on, { [`${CWD}/.claude/verify`]: `${PROJECT}\n${DB}\ngondor.check=ruff check beacons\ngondor.check=deslop check --since {against}` })
    world.gates['ruff check beacons'] = JSON.stringify({ label: 'gondor', to: { error: '', exitCode: 1, output: 'beacons/gondor/app.py:3:1: F401' }, from: { error: '', exitCode: 1, output: 'beacons/gondor/app.py:3:1: F401' } })
    world.gates["deslop check --since 'HEAD'"] = JSON.stringify({ label: 'gondor', to: { error: '', exitCode: 1, output: 'app.py:9 vague-name: data says nothing of what it is' }, from: { error: '', exitCode: 0, output: '' } })

    const said = await call($, 'mcp__theseus__prove', { target: 'gondor' })

    expect(world.jobs.affected.map(one => one.command)).toEqual(['pytest -q -rfE beacons/tests', 'ruff check beacons', "deslop check --since 'HEAD'"])
    expect(said).toContain("gondor.check #1 fails on the commit's source too, so it is not owed by the change")
    expect(said).toContain("gondor.check #2 fails on the working tree (exit 1) and passes on the commit's source:\napp.py:9 vague-name: data says nothing of what it is")
    expect(said).toContain('vague-name: data says nothing of what it is\nFix what it finds in the change.')
  })

  test('name the commit the change is compared with where a check asks for it, quoted for the shell', async ($, on) => {
    const world = machine(on, { [`${CWD}/.claude/verify`]: `${PROJECT}\n${DB}\ngondor.check=ruff check beacons && deslop check --since {against}` })

    await call($, 'mcp__theseus__prove', { target: 'gondor' })
    expect(world.jobs.affected.map(one => one.command)).toContain(`ruff check beacons && deslop check --since 'HEAD'`)

    world.whole = 'abc126\n'
    await call($, 'mcp__theseus__prove', { target: 'gondor', against: `main'; touch pwned; '` })
    expect(world.jobs.affected.map(one => one.command)).toContain(`ruff check beacons && deslop check --since 'main'\\''; touch pwned; '\\'''`)
  })

  test("are run for a frontend the change reached, which no kept run proves, and hold it", async ($, on) => {
    const world = machine(on, { [`${CWD}/.claude/verify`]: `${PROJECT}\nanor.tests=beacons/anor/tests\nanor.affected=npm --prefix beacons/anor test --silent -- --reporter=verbose` })
    world.gates['npm --prefix beacons/anor test --silent -- --reporter=verbose'] = JSON.stringify({ label: 'anor', to: { error: '', exitCode: 1, output: ' × realm > names the beacons 3ms' }, from: { error: '', exitCode: 0, output: ' ✓ realm > names the beacons 3ms' } })

    const said = await call($, 'mcp__theseus__prove', { target: 'anor' })

    expect(world.jobs.affected[0]).toMatchObject({ label: 'anor', command: 'npm --prefix beacons/anor test --silent -- --reporter=verbose', from: 'HEAD' })
    expect(said).toContain("Broken by the change (they pass on the commit's source): realm > names the beacons.")
  })

  test('does not run them for a target the change did not reach', async ($, on) => {
    const world = machine(on, { [`${CWD}/.claude/verify`]: `${PROJECT}\n${DB}` })
    world.fingerprint = 'diff --git a/narsil/src/main.rs b/narsil/src/main.rs\n+fn main() {}\n'

    await call($, 'mcp__theseus__prove', { target: 'gondor' })

    expect(world.jobs.affected).toHaveLength(0)
  })
})

describe('tests written before the change', () => {
  test('are run with the proof and must pass on the working tree for it to settle', () => {
    const [, gondor] = parseProject(PROJECT, CWD)
    const radius = { ...radiusWith('gondor', ['marked']), seams: [{ line: 'gondor GET /health', evidence: '', tests: [{ name: 'test_health_counts_what_burns', from: 'none' as const, to: 'none' as const }], state: 'marked' as const }] }
    // As the build hands them over, each by its file and name, and as the runner names them
    const written = requiredOf(gondor!, CWD, [{ file: 'beacons/tests/test_gondor.py', name: 'beacons/tests/test_gondor.py::test_burned_for' }])
    const proofWith = (isPassing: boolean) => parseProof(JSON.stringify({ ...PROOF, to: { ...PROOF.to, output: `${PROOF.to.output}\n${pytest({ test_burned_for: isPassing })}` } }))!
    const verdictOf = (isPassing: boolean) => proofAnswer([{ label: 'gondor', kind: 'service', found: proved(radius, proofWith(isPassing), written), isTouched: true }])

    // Only the tests marked on what changed, and those written first, are run
    expect(narrowed(gondor!.test, [...markedTests(radius), ...written])).toContain('-k "test_health_counts_what_burns or test_burned_for"')
    expect(verdictOf(false)).toMatchObject({ verdict: 'unsettled', line: 'a test written before the change does not pass yet: test_burned_for' })
    expect(verdictOf(true).verdict).toBe('settled')
  })

  test('must pass even where no kept run of their target changed', () => {
    const proof = parseProof(JSON.stringify({ ...PROOF, to: { ...PROOF.to, output: pytest({ test_burned_for: false }) } }))!

    expect(proofAnswer([{ label: 'gondor', kind: 'service', found: proved(radiusWith('gondor', []), proof, ['test_burned_for']), isTouched: true }]).verdict).toBe('unsettled')
  })

  test('skipped by their runner stand as skipped, not passing', () => {
    const output = ['test owner_check ... ignored, needs root', 'test mtime_untouched ... ok'].join('\n')
    const proof = parseProof(JSON.stringify({ ...PROOF, to: { ...PROOF.to, output } }))!
    const found = proved(radiusWith('deslop', []), proof, ['owner_check', 'mtime_untouched'])

    expect(found.required).toMatchObject([{ name: 'owner_check', to: 'skip' }, { name: 'mtime_untouched', to: 'pass' }])
    expect(proofAnswer([{ label: 'deslop', kind: 'cli', found, isTouched: true }])).toMatchObject({ verdict: 'unsettled', line: 'a test written before the change does not pass yet: owner_check' })
  })

  test('of another target than theirs are not asked of this one', () => {
    const [narsil] = parseProject(PROJECT, CWD)

    expect(requiredOf(narsil!, CWD, [{ file: 'beacons/tests/test_gondor.py', name: 'test_x' }, { file: 'narsil/tests/cli.rs', name: 'cli::show_unknown' }])).toEqual(['show_unknown'])
  })
})

describe('where the targets\' folders stand', () => {
  test('is read by file from git status and each file\'s size and time, by target', () => {
    const output = [' M beacons/gondor/app.py', '?? narsil/src/new.rs', 'R  beacons/gondor/old.py -> beacons/gondor/new.py', 'beacons/gondor/app.py\t812 1800000000.1', 'narsil/src/new.rs\t40 1800000000.2'].join('\n')
    const held = standingByTarget(output, [{ label: 'gondor', roots: [`${CWD}/beacons/gondor`] }, { label: 'narsil', roots: [`${CWD}/narsil`] }, { label: 'anor', roots: [`${CWD}/beacons/anor`] }], CWD)

    expect(held.get('gondor')).toBe([' M beacons/gondor/app.py', 'R  beacons/gondor/old.py -> beacons/gondor/new.py', 'beacons/gondor/app.py\t812 1800000000.1'].join('\n'))
    expect(held.get('narsil')).toBe(['?? narsil/src/new.rs', 'narsil/src/new.rs\t40 1800000000.2'].join('\n'))
    expect(held.get('anor')).toBe('')
  })
})

describe('what the change holds of each target', () => {
  test('is split by folder from one diff and one list of new files', () => {
    const output = [
      'diff --git a/beacons/gondor/app.py b/beacons/gondor/app.py',
      '+lit_at = None',
      'diff --git a/narsil/src/main.rs b/narsil/src/main.rs',
      '+fn main() {}',
      '',
      UNTRACKED,
      'beacons/gondor/tests/test_lit.py',
      '',
    ].join('\n')
    const held = changesByTarget(output, [{ label: 'gondor', roots: [`${CWD}/beacons/gondor`] }, { label: 'narsil', roots: [`${CWD}/narsil`] }, { label: 'anor', roots: [`${CWD}/beacons/anor`] }], CWD)

    expect(held.get('gondor')).toMatch(/app\.py[\s\S]*lit_at[\s\S]*tests\/test_lit\.py/)
    expect(held.get('gondor')).not.toMatch(/main\.rs/)
    expect(held.get('narsil')).toMatch(/main\.rs/)
    expect(held.get('anor')).toBe('')
  })
})

describe('a proof asked again', () => {
  test('of the same change is answered from the last, and made afresh once a target is edited', async ($, on) => {
    const world = machine(on)
    on('tool.call', { tool: 'Edit' }, () => ({ result: 'edited' }) as never)

    await call($, 'mcp__theseus__prove', { target: 'gondor' })
    await call($, 'mcp__theseus__prove', { target: 'gondor' })
    expect(world.jobs.prove).toHaveLength(1)

    await $.tool.call({ tool: 'Edit', file_path: `${CWD}/beacons/gondor/app.py`, old_string: 'a', new_string: 'b' } as never)
    await call($, 'mcp__theseus__prove', { target: 'gondor' })
    expect(world.jobs.prove).toHaveLength(2)
  })

  test('of a change that moved is made afresh', async ($, on) => {
    const world = machine(on)

    await call($, 'mcp__theseus__prove', { target: 'gondor' })
    world.whole = 'abc123\n+ another line\n'
    await call($, 'mcp__theseus__prove', { target: 'gondor' })

    expect(world.jobs.prove).toHaveLength(2)
  })

})

describe('the reviewers, on a change', () => {
  test('are not sent on one that holds nothing', async ($, on) => {
    const world = machine(on)
    const { spawned } = reviewers(on)
    world.change = '\nNew files:\n'

    expect(await call($, 'mcp__theseus__review', { start: true })).toBe('There was no change to judge.')
    expect(spawned).toEqual([])
  })

  test('pass nothing git could not show them: a branch whose base git does not know is judged by none, each saying why', async ($, on) => {
    const world = machine(on)
    const { spawned } = reviewers(on)
    world.missing = ['main']

    const said = await call($, 'mcp__theseus__review', { start: true, against: 'main' })

    expect(spawned).toEqual([])
    expect(said).toMatch(/has judged the change: silent[\s\S]*Correctness reviewer .*: silent, git could not show the change since main: fatal: Not a valid object name main/)
    // Asked again, it is judged afresh, never taken from the judgement no reviewer gave
    world.missing = []
    await call($, 'mcp__theseus__review', { start: true, against: 'main' })
    expect(spawned.length).toBeGreaterThan(0)
  })

  test('judge a whole branch since where it left its base, whatever the proof of the change at hand', async ($, on) => {
    const world = machine(on)
    const { spawned } = reviewers(on)

    // narsil's run is bare: the change at hand is not settled, but the branch is judged as it was committed
    await call($, 'mcp__theseus__prove')
    await call($, 'mcp__theseus__review', { start: true, reviewers: ['reviewer-security'], against: 'main' })

    expect(spawned.map(one => one.subagent_type)).toEqual(['theseus:reviewer-security'])
    expect(world.ran.some(line => line.includes('git merge-base "$1" HEAD') && line.endsWith(' main'))).toBe(true)
    // A whole branch has no radius of its own: the proof of the change at hand is not handed over with it
    expect(String(spawned[0]?.prompt)).not.toContain('<proof>')
  })

  test('know a change, its size, and what they are shown of it, without the folders the mods keep, as a commit takes it', async ($, on) => {
    const world = machine(on)
    reviewers(on)

    await call($, 'mcp__theseus__review', { start: true, reviewers: ['reviewer-correctness'] })

    const scripts = world.ran.filter(line => line.includes('git merge-base "$1" HEAD'))

    // The fingerprint, the size and the change shown: each git listing in them leaves out the mods' folders
    expect(scripts.some(line => line.includes('git rev-parse HEAD'))).toBe(true)
    expect(scripts.some(line => line.includes('--numstat'))).toBe(true)
    expect(scripts.some(line => line.includes('New files:'))).toBe(true)
    for (const script of scripts) {
      for (const listing of script.match(/git (diff "\$b"|ls-files -o)[^;|]*/g) ?? []) expect(listing).toContain("'--' '.' ':(exclude).theseus' ':(exclude).pipeline' ':(exclude).recorder'")
    }
  })

  test('are handed what the proof found: each altered run with its test and how it answers now, on the model named', async ($, on) => {
    machine(on)
    const { spawned } = reviewers(on)
    await $.session.start({ source: 'startup', cwd: CWD } as never)

    await call($, 'mcp__theseus__prove', { target: 'gondor' })
    await call($, 'mcp__theseus__review', { start: true, reviewers: ['reviewer-correctness'], model: 'sonnet' })

    const prompt = String(spawned[0]?.prompt)
    expect(prompt).toContain('<proof>\n- gondor: gondor GET /health (pinned, by test_health_counts_what_burns)')
    expect(prompt).toContain('+  "lit": 0,')
    expect(spawned[0]?.model).toBe('sonnet')
  })

  test('are told of a target the change reached that no kept run sees, so they can tell new behaviour from a refactor', async ($, on) => {
    const world = machine(on)
    const { spawned } = reviewers(on)
    world.service = JSON.stringify({ ...SERVICE, cases: SERVICE.cases.map(one => ({ ...one, isChanged: false, evidence: '' })) })
    world.fingerprint = 'diff --git a/beacons/gondor/app.py b/beacons/gondor/app.py\n+    def helper(): pass\n'
    await $.session.start({ source: 'startup', cwd: CWD } as never)

    expect(await call($, 'mcp__theseus__prove', { target: 'gondor' })).toMatch(/gondor/)
    await call($, 'mcp__theseus__review', { start: true })

    expect(String(spawned[0]?.prompt)).toContain('- gondor: the change reached its source, but no kept run of it answers otherwise.')
    // No model named: each reviewer judges with its own
    expect(spawned[0]?.model).toBeUndefined()
  })

  test('may read but never reach the network', () => {
    expect(isChanging('curl -s https://example.com')).toBe(true)
    expect(isChanging('wget example.com')).toBe(true)
    expect(isChanging('git log -1')).toBe(false)
  })
})

describe('a shell command', () => {
  test('of an agent that only reads is not looked at for edits', async ($, on) => {
    const world = machine(on)
    reviewers(on)
    on('tool.call', { tool: 'Bash' }, () => ({ result: 'ran' }) as never)
    await call($, 'mcp__theseus__radius', { target: 'gondor' })

    await $.tool.call({ tool: 'Bash', command: 'git log -1', agentId: 'reviewer-correctness-1' } as never)
    expect(world.fingerprints).toBe(0)

    await $.tool.call({ tool: 'Bash', command: 'make', agentId: 'helper-1' } as never)
    expect(world.fingerprints).toBe(2)
  })
})

describe('the gates of a change', () => {
  const side = (exitCode: number, output = '', error = '') => ({ ref: 'x', sha: '', error, exitCode, output })

  test("hold a check the change newly fails, let one that failed before pass and say so, and never take an unknown for a pass", () => {
    expect(gateOf(JSON.stringify({ to: side(0), from: null }), 'narsil.check')).toEqual({ broken: '', before: '', unproved: '' })
    expect(gateOf(JSON.stringify({ to: side(1, 'warning: unused variable `x`'), from: side(0) }), 'narsil.check').broken).toMatch(/^narsil\.check fails on the working tree \(exit 1\) and passes on the commit's source:\nwarning: unused variable `x`/)
    expect(gateOf(JSON.stringify({ to: side(1, 'old warning'), from: side(1) }), 'narsil.check')).toMatchObject({ broken: '', before: expect.stringMatching(/fails on the commit's source too/) })
    // The commit's source could not be tried: the failure is the change's to answer
    expect(gateOf(JSON.stringify({ to: side(1, 'x'), from: side(-1, '', 'it could not be checked out') }), 'narsil.check').broken).toMatch(/whether it failed before could not be told \(it could not be checked out\)/)
    expect(gateOf(JSON.stringify({ to: side(-1, '', 'the tests were ended after 600 seconds'), from: null }), 'gondor.audit').unproved).toMatch(/gondor\.audit was not run/)
    expect(gateOf('', 'gondor.audit').unproved).toMatch(/answered nothing that reads/)
  })

  test("know the dependency manifests a change touches, by its diff and the files it adds", () => {
    const change = ['diff --git a/narsil/Cargo.toml b/narsil/Cargo.toml', 'index 1..2 100644', '+serde = "1"', 'diff --git a/narsil/src/main.rs b/narsil/src/main.rs', '+// Cargo.toml', 'beacons/requirements-dev.txt', 'beacons/gondor/app.py'].join('\n')

    expect(manifestsOf(change)).toEqual(['narsil/Cargo.toml', 'beacons/requirements-dev.txt'])
    expect(manifestsOf('diff --git a/narsil/src/main.rs b/narsil/src/main.rs\n+x')).toEqual([])
  })

  test('find the tests a change takes out, deletes or skips, and leave one moved or added be', () => {
    const diff = [
      'diff --git a/beacons/tests/test_gondor.py b/beacons/tests/test_gondor.py',
      '--- a/beacons/tests/test_gondor.py',
      '+++ b/beacons/tests/test_gondor.py',
      '-def test_quench_unknown():',
      '-    assert quench("x").status_code == 404',
      '+@pytest.mark.skip(reason="flaky")',
      ' def test_light():',
      'diff --git a/narsil/tests/cli.rs b/narsil/tests/cli.rs',
      'deleted file mode 100644',
      '--- a/narsil/tests/cli.rs',
      '+++ /dev/null',
      '-#[test]',
      '-fn shows_a_lighting() {}',
      'diff --git a/beacons/anor/app.spec.ts b/beacons/anor/app.spec.ts',
      '-  test("draws the beacons", () => {})',
      '+  test("draws the beacons, lit first", () => {})',
      "+  it.only('lights one', () => {})",
    ].join('\n')

    expect(weakenedOf(diff)).toEqual([
      'beacons/tests/test_gondor.py: 1 test taken out',
      'beacons/tests/test_gondor.py: skipped or run alone, `@pytest.mark.skip(reason="flaky")`',
      'narsil/tests/cli.rs: the test file is deleted, with its 1 test',
      "beacons/anor/app.spec.ts: skipped or run alone, `it.only('lights one', () => {})`",
    ])
    expect(weakenedOf('diff --git a/t/test_a.py b/t/test_a.py\n+def test_new():\n+    assert True')).toEqual([])
  })

  test("say how big a change is: its lines, its files and the new ones, where it adds most, its lock files left out", () => {
    // As git's --numstat -z spells them: a rename names where it came from and where it went
    const numstat = ['12\t3\tbeacons/gondor/app.py', '274\t1\tbeacons/uv.lock', '-\t-\tbeacons/anor/public/flame.png', '0\t7\tnarsil/src/show.rs', '5\t1\t', 'narsil/src/old.rs', 'narsil/src/new name.rs']
    // Each new file against nothing, a binary of no line, a link of the one line where it points
    const fresh = ['120\t0\t', '/dev/null', 'beacons/gondor/archive/store.py', '-\t-\t', '/dev/null', 'beacons/anor/public/map.bin', '1\t0\t', '/dev/null', 'beacons/gondor/latest']
    const nul = (tokens: string[]) => tokens.map(one => `${one}\0`).join('')

    expect(sizeText(`${nul(numstat)}${UNTRACKED}\0${nul(fresh)}`)).toBe(
      'The change adds 138 lines and takes out 11, across 7 files, 3 of them new. Where it adds most: beacons/gondor/archive/store.py +120 (new), beacons/gondor/app.py +12, narsil/src/new name.rs +5, beacons/gondor/latest +1 (new). Lock files are not counted.',
    )
    expect(sizeText(`${nul(['0\t4\tnarsil/src/show.rs'])}${UNTRACKED}\0`)).toBe('The change adds 0 lines and takes out 4, across 1 file.')
    expect(sizeText(`${nul(['1\t0\tbeacons/uv.lock'])}${UNTRACKED}\0`)).toBe('')
  })
})

describe('a secret', () => {
  test('is found on a line a diff adds, by file, and never on one it takes out or in a local fixture', () => {
    const key = `AKIA${'Q'.repeat(16)}`
    const diff = [
      '+++ b/beacons/gondor/settings.py',
      `+AWS_KEY = "${key}"`,
      `-OLD = "${key}"`,
      '+DATABASE_URL = "postgres://postgres:postgres@localhost:5432/beacons"',
      '+ROHAN = "https://rohan:hunter2hunter2@rohan.example.com/api"',
      '+++ b/narsil/deploy.pem',
      '+-----BEGIN OPENSSH PRIVATE KEY-----',
      '+++ b/README.md',
      '+Set GITHUB_TOKEN to a token of yours.',
    ].join('\n')

    expect(secretsIn(diff)).toEqual(['beacons/gondor/settings.py: an AWS access key', 'beacons/gondor/settings.py: a password in a URL', 'narsil/deploy.pem: a private key'])
  })
})
