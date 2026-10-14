import { describe, expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { isProd, narrowed, owed, parseProject, parseReviews, parseServiceAnswer, targetsOf, withLive } from '../hooks/proof'
import { dealt, isChanging, parseFindings } from '../hooks/statues'

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

// What anduril's diff says of narsil: one kept run changed
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

const TESTS = ['# sting: gondor GET /health', 'def test_health_counts_what_burns(client):', '    assert client.get("/health").json()["lit"] == 0'].join('\n')

const pytest = (ended: Record<string, boolean>) => Object.entries(ended).map(([name, isOk]) => `beacons/tests/test_gondor.py::${name} ${isOk ? 'PASSED' : 'FAILED'}`).join('\n')

const PROOF = {
  label: 'gondor',
  from: { ref: 'HEAD', sha: '209dec6ccef9', error: '', exitCode: 1, output: pytest({ test_health_counts_what_burns: false, test_health: true }) },
  to: { ref: 'work', sha: '', error: '', exitCode: 1, output: pytest({ test_health_counts_what_burns: true, test_health: false }) },
}

/** Stands for the machine beneath the mod and for anduril beside it. */
const machine = (on: On, given: Record<string, string> = {}) => {
  const files: Record<string, string> = { [`${CWD}/.claude/argonath`]: PROJECT, [`${CWD}/beacons/tests/test_gondor.py`]: TESTS, ...given }
  const world = { files, ran: [] as string[], fingerprint: '', fingerprints: 0, whole: 'abc123\n', change: 'diff --git a/beacons/gondor/app.py\n+    lit = 0\n', cli: CLI_DIFF, service: JSON.stringify(SERVICE), proof: JSON.stringify(PROOF), asked: [] as Record<string, unknown>[], jobs: { service: [] as Record<string, unknown>[], prove: [] as Record<string, unknown>[], live: [] as Record<string, unknown>[] } }
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

    if (e.argv[0] === 'sh' && (e.argv[2] ?? '').includes('git rev-parse HEAD')) stdout = world.whole
    else if (e.argv[0] === 'sh' && (e.argv[2] ?? '').includes('New files:')) stdout = world.change
    else if (script.endsWith('service.py')) {
      world.jobs.service.push(job())
      stdout = world.service
    } else if (e.argv[0] === 'sh' && e.argv.includes(`${CWD}/beacons/gondor`)) {
      // What git says of gondor's folder against HEAD
      world.fingerprints += 1
      stdout = world.fingerprint
    } else if (script.endsWith('live.py')) {
      world.jobs.live.push(job())
      stdout = JSON.stringify({ label: 'gondor', where: 'k3d-beacons/beacons/deployment/gondor', skipped: '', error: '', cases: [] })
    } else if (script.endsWith('prove.py')) {
      world.jobs.prove.push(job())
      stdout = world.proof
    } else {
      // git listing a target's test files
      const folders = e.argv.slice(e.argv.indexOf('--') + 1).map(whole)
      stdout = Object.keys(files).filter(path => folders.some(folder => path.startsWith(`${folder}/`))).map(path => path.slice(CWD.length + 1)).join('\n')
    }

    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
  on('tool.call', { tool: 'mcp__anduril__diff' }, (_, e) => {
    world.asked.push(e as unknown as Record<string, unknown>)

    return { result: world.cli } as never
  })

  // The world itself, not a copy: a test that changes what it answers changes what the mocks above read
  return Object.assign(world, { clock })
}

const call = async ($: Engine, tool: string, input: Record<string, unknown> = {}) => String((await $.tool.call({ tool, ...input } as never)).result)

const ends = ($: Engine, agentId: string, answer: string) => $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId: 's', reason: 'answer', agentId } as never)

/** A statue's answer: its account, then its findings as the json block it ends with. */
const FOUND = (findings: Record<string, string>[]) => ['I ran the review on the change.', '', '```json', JSON.stringify({ findings }), '```'].join('\n')

/** Stands for the engine that sends the statues, and for the Claude they report to. */
const statues = (on: On) => {
  const spawned: Record<string, unknown>[] = []
  const submitted: string[] = []

  on('agent.spawn', (_, e) => {
    spawned.push(e as unknown as Record<string, unknown>)

    return { model: 'opus' } as never
  })
  // Core alone mints an agent's id: a statue is known by the type it runs as
  on('agent.list', () => ({
    value: [
      { id: 'isildur-1', description: 'x', type: 'argonath:isildur', status: 'running' },
      { id: 'anarion-1', description: 'x', type: 'argonath:anarion', status: 'running' },
      { id: 'someone', description: 'x', type: 'Explore', status: 'running' },
      // A member another mod sent, and a helper the person spawned
      { id: 'gimli-1', description: 'x', type: 'fellowship:gimli', status: 'running' },
      { id: 'helper-1', description: 'x', type: 'general-purpose', status: 'running' },
    ],
  }) as never)
  on('agent.register', () => ({ value: { agent: 'argonath:isildur' } }) as never)
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
    expect(owed(fast)).toContain('If the change is meant, write one that makes this run')
    expect(owed(fast)).toContain('if not, it is a regression: fix the code.')
  })

  test('is never started for a context that names prod', async ($, on) => {
    const world = machine(on, { [`${CWD}/.claude/argonath`]: `${PROJECT}\n${LIVE.replace('k3d-beacons', 'gke-prod')}` })

    const said = await call($, 'mcp__argonath__radius', { target: 'gondor' })

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
    const world = machine(on, { [`${CWD}/.claude/argonath`]: PROJECT.replace(' -k "{tests: or }"', '') })

    const said = await call($, 'mcp__argonath__prove', { target: 'gondor' })

    expect(world.jobs.prove).toHaveLength(0)
    expect(said).toContain('marked: gondor GET /health')
    expect(said).toContain('has no {tests} for the tests to run, so none is run')
  })

  test('runs nothing where no changed run is marked by a test yet', async ($, on) => {
    const world = machine(on, { [`${CWD}/beacons/tests/test_gondor.py`]: 'def test_health(client):\n    pass\n' })

    expect(await call($, 'mcp__argonath__prove', { target: 'gondor' })).toContain('bare: gondor GET /health')
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

describe('the statues', () => {
  test('are dealt the reviews the project names in turn, and none sits without one', () => {
    expect(dealt([{ command: 'code-review', args: 'medium' }, { command: 'security-review', args: '' }, { command: 'perf', args: '' }])).toEqual([
      { name: 'isildur', title: 'Isildur', reviews: ['/code-review medium', '/perf'] },
      { name: 'anarion', title: 'Anárion', reviews: ['/security-review'] },
    ])
    expect(dealt([{ command: 'code-review', args: '' }]).map(seat => seat.name)).toEqual(['isildur'])
  })

  test('answer their findings in their last json block, blocking or minor, and nothing when none reads', () => {
    expect(parseFindings(FOUND([{ severity: 'blocking', where: 'a.py:1', text: 'Wrong.' }, { severity: 'nit', where: '', text: 'Style.' }]))).toEqual([
      { severity: 'blocking', where: 'a.py:1', text: 'Wrong.' },
      { severity: 'minor', where: '', text: 'Style.' },
    ])
    expect(parseFindings('Looks fine to me.')).toBeUndefined()
  })

  test('run only commands that read', () => {
    for (const command of ['git add -A', 'rm -rf beacons', 'echo x > app.py', 'sed -i s/a/b/ app.py', 'npm install left-pad']) expect(isChanging(command)).toBe(true)
    for (const command of ['git diff HEAD', 'git log -3 2>&1', 'grep -n lit app.py', 'uv run pytest -q 2>/dev/null', 'ls beacons']) expect(isChanging(command)).toBe(false)
  })
})

describe('argonath', () => {
  test('says how to name targets to a Claude that asks where none are', async ($, on) => {
    machine(on, { [`${CWD}/.claude/argonath`]: '' })

    expect(await call($, 'mcp__argonath__radius')).toMatch(/Argonath knows no target here.*gondor=service:gondor\.app:app/s)
  })

  test('sends each target to the handler of its kind: a CLI to anduril, a service to its requests, a frontend to none yet', async ($, on) => {
    const world = machine(on)

    const said = await call($, 'mcp__argonath__radius')

    expect(world.asked[0]).toMatchObject({ target: 'narsil', from: 'HEAD', to: 'work' })
    expect(world.jobs.service[0]).toMatchObject({ label: 'gondor', app: 'gondor.app:app', python: 'beacons', env: { ROHAN_URL: 'http://127.0.0.1:9', DATABASE_URL: '' }, requests: ['gondor GET /health', 'gondor POST /beacons/amon-din/light'], from: 'HEAD' })
    expect(said).toContain('bare: narsil show 999')
    expect(said).toContain('marked: gondor GET /health\n  marked by test_health_counts_what_burns, not proved')
    expect(said).toContain('anor is a frontend: Argonath has no handler for a frontend yet')
    expect(world.jobs.prove).toHaveLength(0)
  })

  test('proves one target when asked, pinning the run whose test fails on HEAD and passes now', async ($, on) => {
    const world = machine(on)

    const said = await call($, 'mcp__argonath__prove', { target: 'gondor' })

    expect(world.asked).toHaveLength(0)
    expect(world.jobs.prove[0]).toEqual({ home: CWD, label: 'gondor', tests: [`${CWD}/beacons/tests`], test: 'uv run pytest -v beacons/tests/test_gondor.py -k "test_health_counts_what_burns"', from: 'HEAD' })
    expect(said).toContain('pinned: gondor GET /health')
    // test_health turned, but no changed request is marked by it: it is out of scope, and not said
    expect(said).not.toContain('test_health ')
    expect(said).not.toContain('Passing on the commit')
    expect(world.files[`${CWD}/.argonath/.gitignore`]).toBe('*\n')
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
    statues(on)
    on('tool.call', { tool: 'Edit' }, () => ({ result: 'edited' }) as never)
    await $.session.start({ source: 'startup', cwd: CWD } as never)
    const turn = async () => {
      await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as never)
      await world.clock.advance(2_500)
    }

    // The Fellowship proves and judges what its member built: the session's turn ending owes it nothing
    await $.tool.call({ tool: 'Edit', file_path: `${CWD}/beacons/gondor/app.py`, old_string: 'a', new_string: 'b', agentId: 'gimli-1' } as never)
    await turn()
    expect(world.jobs.prove).toHaveLength(0)

    await $.tool.call({ tool: 'Edit', file_path: `${CWD}/beacons/gondor/app.py`, old_string: 'a', new_string: 'b', agentId: 'helper-1' } as never)
    await turn()
    expect(world.jobs.prove).toHaveLength(1)
  })

  test('counts a shell command that changed a target\'s folders as an edit of it, and one that did not as none', async ($, on) => {
    const world = machine(on)
    // The shell command reverts gondor's archive: what git says of gondor's folder is not the same after it
    world.fingerprint = 'diff --git a/beacons/gondor/archive.py'
    on('tool.call', { tool: 'Bash' }, () => {
      world.fingerprint = ''

      return { result: 'done' } as never
    })
    await call($, 'mcp__argonath__radius', { target: 'gondor' })

    await $.tool.call({ tool: 'Bash', command: 'git checkout -- beacons/gondor/archive.py' } as never)
    await $.ui.mount({ plugin: 'argonath', surface: 'terminal', component: 'Pane', props: { bodyColumns: 100 } as never, requestId: 'argonath' })
    const drawn = await call($, 'mcp__argonath__pane')

    expect(world.fingerprints).toBe(2)
    expect(drawn).toMatch(/gondor\s+service.*edited since/)
    expect(drawn).not.toMatch(/narsil\s+cli.*edited since/)
  })

  test('glows above the prompt while a changed run of some target is not pinned, and is dark once hidden', async ($, on) => {
    machine(on)
    // What the engine draws there when the mod draws nothing
    on('ui.render', { component: 'AbovePrompt' } as never, () => ({ type: 'Text', props: {}, children: [''] }) as never)
    const mountBand = () => $.ui.mount({ plugin: 'argonath', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10 } as never })

    const dark = await mountBand()
    expect(await dark.find({ text: /sting/ })).toBeUndefined()
    await dark.unmount()

    await call($, 'mcp__argonath__radius')
    const band = await mountBand()
    expect(await band.find({ text: /narsil 1 bare {2}│ {2}gondor 1 marked/ })).toBeDefined()

    await band.press({ key: 'argonath-hide' })
    expect(await band.find({ text: /sting/ })).toBeUndefined()
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`shows each target in a section of its own, and the evidence of a run that is opened, on ${surface}`, async ($, on) => {
      machine(on)
      const pane = await $.ui.mount({ plugin: 'argonath', surface, component: 'Pane', props: { bodyColumns: 100 } as never, requestId: 'argonath' })
      await pane.press({ key: 'refresh' })
      await pane.press({ key: 'radius' })

      const drawn = await call($, 'mcp__argonath__pane')
      expect(drawn).toContain('3 targets · 2 with a change no test pins')
      expect(drawn).toMatch(/gondor\s+service/)
      expect(drawn).toMatch(/marked\s+\[gondor GET \/health\]\s+test_health_counts_what_burns/)
      expect(drawn).toContain('anor is a frontend')

      await pane.press({ key: 'seam-gondor-gondor GET /health' })
      expect(await call($, 'mcp__argonath__pane')).toContain('+  "lit": 0,')
    })
  }

  test('sends the statues once the turn that proved every changed run pinned has ended, tells Claude their verdict, and judges the same change once', async ($, on) => {
    const world = machine(on)
    const { spawned, submitted } = statues(on)
    await $.session.start({ source: 'startup', cwd: CWD } as never)
    const turn = async () => {
      await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as never)
      await world.clock.advance(2_500)
    }

    // A tool call is a hook the turn waits on: nothing is sent before it ends
    expect(await call($, 'mcp__argonath__prove', { target: 'gondor' })).toContain('pinned: gondor GET /health')
    expect(spawned).toEqual([])

    await turn()
    expect(spawned.map(one => one.subagent_type)).toEqual(['argonath:isildur', 'argonath:anarion'])
    expect(String(spawned[0]?.prompt)).toMatch(/Your review: \/code-review medium\.[\s\S]*<change>\ndiff --git a\/beacons\/gondor\/app\.py/)
    expect(String(spawned[1]?.prompt)).toContain('Your review: /security-review.')
    expect(await call($, 'mcp__argonath__judgement')).toMatch(/is judging the change: sitting/)

    await ends($, 'isildur-1', FOUND([{ severity: 'minor', where: 'app.py:70', text: 'lit could be named burning.' }]))
    expect(submitted).toEqual([])
    await ends($, 'anarion-1', FOUND([{ severity: 'blocking', where: 'app.py:72', text: 'The archive error is swallowed whole.' }]))

    expect(submitted[0]).toMatch(/has judged the change: fail[\s\S]*Isildur \(\/code-review medium\): pass\n- \[minor\] app\.py:70: lit could[\s\S]*Anárion \(\/security-review\): fail\n- \[blocking\] app\.py:72/)
    expect(JSON.parse(await call($, 'mcp__argonath__judgement', { json: true }))).toMatchObject({ verdict: 'fail', seats: [{ statue: 'isildur', state: 'pass' }, { statue: 'anarion', state: 'fail' }] })

    await call($, 'mcp__argonath__prove', { target: 'gondor' })
    await turn()
    expect(spawned).toHaveLength(2)

    // The change moved on: the judgement is stale, and the statues judge it again
    world.whole = 'abc123\nmore\n'
    expect(JSON.parse(await call($, 'mcp__argonath__judgement', { json: true })).verdict).toBe('stale')
    await call($, 'mcp__argonath__prove', { target: 'gondor' })
    await turn()
    expect(spawned).toHaveLength(4)
  })

  test('sends no statue on a change that moved on, or was committed, before the turn that proved it ended', async ($, on) => {
    const world = machine(on)
    const { spawned } = statues(on)
    await $.session.start({ source: 'startup', cwd: CWD } as never)

    expect(await call($, 'mcp__argonath__prove', { target: 'gondor' })).toContain('pinned: gondor GET /health')
    // Committed: HEAD moved, and nothing is left to judge
    world.whole = 'def456\n'
    world.change = '\nNew files:\n'
    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as never)
    await world.clock.advance(2_500)

    expect(spawned).toEqual([])
  })

  test('owes no judgement to a proof a subagent made: its work may not be done when the session\'s turn ends', async ($, on) => {
    const world = machine(on)
    const { spawned } = statues(on)
    await $.session.start({ source: 'startup', cwd: CWD } as never)

    expect(await call($, 'mcp__argonath__prove', { target: 'gondor', agentId: 'merry-1' })).toContain('pinned: gondor GET /health')
    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as never)
    await world.clock.advance(2_500)

    expect(spawned).toEqual([])
  })

  test('owes no judgement to a proof a mod asked for while saying it convenes the statues itself', async ($, on) => {
    const world = machine(on)
    const { spawned } = statues(on)
    await $.session.start({ source: 'startup', cwd: CWD } as never)

    expect(await call($, 'mcp__argonath__prove', { target: 'gondor', owe: false })).toContain('pinned: gondor GET /health')
    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as never)
    await world.clock.advance(2_500)

    expect(spawned).toEqual([])
  })

  test('sends no statue on a change a changed run of which is not pinned', async ($, on) => {
    machine(on)
    const { spawned } = statues(on)
    await $.session.start({ source: 'startup', cwd: CWD } as never)

    // narsil's run is bare
    await call($, 'mcp__argonath__prove')
    expect(JSON.parse(await call($, 'mcp__argonath__judgement', { convene: true, json: true }))).toEqual({ verdict: 'unsettled', targets: ['narsil'] })
    expect(spawned).toEqual([])
  })

  test('sends the statues on a change a mod asks them to judge, and keeps their hands off the tree', async ($, on) => {
    machine(on)
    const { spawned, submitted } = statues(on)
    on('tool.call', { tool: 'Bash' }, () => ({ result: 'ran' }) as never)
    await $.session.start({ source: 'startup', cwd: CWD } as never)

    await call($, 'mcp__argonath__prove', { target: 'gondor' })
    expect(JSON.parse(await call($, 'mcp__argonath__judgement', { convene: true, json: true, about: 'Task 2: answer 409 when the beacon does not burn.' })).verdict).toBe('sitting')
    expect(spawned).toHaveLength(2)
    expect(String(spawned[0]?.prompt)).toMatch(/<purpose>\nTask 2: answer 409 when the beacon does not burn\.\n<\/purpose>/)

    const by = (agentId: string, command: string) => $.tool.call({ tool: 'Bash', command, agentId } as never)
    expect(await by('isildur-1', 'git commit -am fixed')).toMatchObject({ deny: expect.stringMatching(/changes nothing/) })
    expect(await by('anarion-1', 'git diff HEAD -- beacons')).toMatchObject({ result: 'ran' })
    expect(await by('someone', 'git commit -am fixed')).toMatchObject({ result: 'ran' })

    await ends($, 'isildur-1', FOUND([]))
    await ends($, 'anarion-1', 'I could not decide.')
    expect(JSON.parse(await call($, 'mcp__argonath__judgement', { json: true }))).toMatchObject({ verdict: 'silent', seats: [{ state: 'pass' }, { state: 'silent', why: 'it gave no findings that read' }] })
    // A mod asked: it reads the verdict itself, and no Claude is woken with it
    expect(submitted).toEqual([])
  })

  test('sends only the statues a mod names, each with its share of the reviews', async ($, on) => {
    machine(on)
    const { spawned } = statues(on)
    await $.session.start({ source: 'startup', cwd: CWD } as never)

    await call($, 'mcp__argonath__prove', { target: 'gondor' })
    await call($, 'mcp__argonath__judgement', { convene: true, statues: ['isildur'] })

    expect(spawned.map(one => one.subagent_type)).toEqual(['argonath:isildur'])
    expect(String(spawned[0]?.prompt)).toContain('Your review: /code-review medium.')
  })

  test('answers what the project builds to a mod, its folders from the project', async ($, on) => {
    machine(on)

    expect(JSON.parse(await call($, 'mcp__argonath__targets'))).toEqual([
      { label: 'narsil', kind: 'cli', roots: ['narsil'] },
      { label: 'gondor', kind: 'service', roots: ['beacons/gondor'] },
      { label: 'anor', kind: 'frontend', roots: ['beacons/anor'] },
    ])
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
    await call($, 'mcp__argonath__prove')
    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as never)
    await world.clock.advance(2_500)

    expect(reviewed).toEqual([])
  })
})
