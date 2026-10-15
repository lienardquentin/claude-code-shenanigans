import { describe, expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { blocksOf, isChanging, isTestPath, missingFrom, parseGaze, takenBy, tamperedWith } from '../hooks/mirror'

type Engine = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

const CWD = '/proj'

const TEST_LINES = ['def test_quenching_one_beacon(client):', '    client.post("/beacons/amon-din/light")', '    assert client.post("/beacons/amon-din/quench").status_code == 200']

// What git shows of the test file she added to: three lines after the last test
const DIFF = ['diff --git a/beacons/tests/test_gondor.py b/beacons/tests/test_gondor.py', '--- a/beacons/tests/test_gondor.py', '+++ b/beacons/tests/test_gondor.py', '@@ -120,0 +121,4 @@', '+', ...TEST_LINES.map(line => `+${line}`)].join('\n')

const SHOWN = ['I wrote one test.', '', '```json', JSON.stringify({ tests: [{ file: 'beacons/tests/test_gondor.py', name: 'test_quenching_one_beacon' }], red: 'FAILED test_quenching_one_beacon - assert 404 == 200', untestable: '' }), '```'].join('\n')

const FILE = `${CWD}/beacons/tests/test_gondor.py`

describe('the Mirror', () => {
  test('knows a test file by its folder or its name', () => {
    for (const path of ['beacons/tests/test_gondor.py', 'narsil/tests/cli.rs', 'web/src/App.test.tsx', 'pkg/quench_test.go', 'spec/models/beacon_spec.rb']) expect(isTestPath(path)).toBe(true)
    for (const path of ['beacons/gondor/app.py', 'narsil/src/main.rs', 'web/src/App.tsx', 'contest/main.py']) expect(isTestPath(path)).toBe(false)
  })

  test('reads what she showed from her last json block', () => {
    expect(parseGaze(SHOWN)).toEqual({ tests: [{ file: 'beacons/tests/test_gondor.py', name: 'test_quenching_one_beacon' }], red: 'FAILED test_quenching_one_beacon - assert 404 == 200', untestable: '' })
    expect(parseGaze('```json\n{ "tests": [], "red": "", "untestable": "Only the README changes." }\n```')).toMatchObject({ untestable: 'Only the README changes.' })
    expect(parseGaze('I wrote some tests.')).toBeUndefined()
  })

  test('locks the lines she added, and the new files whole', () => {
    expect(blocksOf(DIFF, [{ file: 'beacons/tests/test_new.py', text: 'def test_x():\n\n    assert False\n' }])).toEqual([
      { file: 'beacons/tests/test_gondor.py', lines: TEST_LINES },
      { file: 'beacons/tests/test_new.py', lines: ['def test_x():', '    assert False'] },
    ])
  })

  test('lets an edit add around her lines, and finds one that takes one out', () => {
    const before = TEST_LINES.join('\n')

    expect(takenBy(TEST_LINES, before, `# sting: gondor POST /beacons/amon-din/quench\n${before}`)).toEqual([])
    expect(takenBy(TEST_LINES, before, before.replace('== 200', 'in (200, 404)'))).toEqual([TEST_LINES[2]])
    expect(missingFrom(TEST_LINES, `import x\n${before}\n`)).toEqual([])
    expect(missingFrom(TEST_LINES, 'import x\n')).toHaveLength(3)
  })

  test('finds what a shell command took out of her tests, in a file no reason was given for', () => {
    const blocks = [{ file: 'beacons/tests/test_gondor.py', lines: TEST_LINES }]
    const loosened = TEST_LINES.join('\n').replace('== 200', 'in (200, 404)')

    expect(tamperedWith(blocks, [], [{ file: 'beacons/tests/test_gondor.py', text: `# sting: x\n${TEST_LINES.join('\n')}` }])).toEqual([])
    expect(tamperedWith(blocks, [], [{ file: 'beacons/tests/test_gondor.py', text: loosened }])).toEqual([{ file: 'beacons/tests/test_gondor.py', lines: [TEST_LINES[2]!] }])
    expect(tamperedWith(blocks, [{ file: 'beacons/tests/test_gondor.py' }], [{ file: 'beacons/tests/test_gondor.py', text: loosened }])).toEqual([])
  })

  test('lets her run tests and read, and nothing that changes the tree', () => {
    expect(isChanging('uv run --project beacons pytest -q beacons/tests 2>&1')).toBe(false)
    expect(isChanging('git stash')).toBe(true)
  })
})

/** Stands for the machine and the engine beneath the mod. */
const machine = (on: On) => {
  // `tops`: the folders git runs at the top of, the project's and any quest's worktree
  const world = { spawned: [] as Record<string, unknown>[], submitted: [] as string[], head: 'aaa111', status: ' M beacons/tests/test_gondor.py\n', diff: DIFF, cwd: CWD, tops: [CWD], files: {} as Record<string, string>, clock: mock.clock(on, { now: 1_800_000_000_000 }) }

  // The session's directory may wander into a subfolder; git's top stays the project's
  on('session.cwd', () => ({ value: world.cwd }) as never)
  on('process.run', (_, e) => {
    const line = e.argv.join(' ')
    const isAtTop = world.tops.includes(e.init?.cwd ?? '')
    // A diff is of the paths named, from where it runs, as git answers it: a path misread from the status, or one
    // named from a subfolder, has none
    const stdout =
      line === 'git rev-parse --show-toplevel' ? `${CWD}\n` : line === 'git rev-parse HEAD' ? `${world.head}\n` : line.startsWith('git status') ? world.status : line.startsWith('git diff') ? (isAtTop && e.argv.includes('beacons/tests/test_gondor.py') ? world.diff : '') : ''

    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
  on('fs.read', (_, e) => ({ value: world.files[e.path] ?? '' }) as never)
  on('agent.spawn', (_, e) => {
    const given = e as unknown as Record<string, unknown> & { subagent_type?: string; subagentType?: string }

    world.spawned.push(given)

    // A member another mod sends is answered its id; Galadriel is known by her type
    return { model: 'opus', ...(/^fellowship:/.test(String(given.subagent_type ?? given.subagentType ?? '')) ? { agentId: 'gimli-1' } : {}) } as never
  })
  // Core alone mints an agent's id: she is known by the type she runs as
  on('agent.list', () => ({ value: [{ id: 'galadriel-1', description: 'x', type: 'lothlorien:galadriel', status: 'running' }, { id: 'gimli-1', description: 'x', type: 'fellowship:gimli', status: 'running' }] }) as never)
  on('prompt.submit', (_, e) => {
    world.submitted.push(e.text)

    return { text: e.text } as never
  })
  on('agent.register', () => ({ value: { agent: 'lothlorien:galadriel' } }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('tool.register', () => ({ value: undefined }) as never)
  on('session.start', () => ({ cwd: CWD }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('turn.complete', () => ({ text: '' }) as never)
  for (const tool of ['Edit', 'Write', 'Bash']) on('tool.call', { tool } as never, () => ({ result: 'done' }) as never)

  return world
}

const call = async ($: Engine, tool: string, input: Record<string, unknown> = {}) => String((await $.tool.call({ tool, ...input } as never)).result)

const ends = ($: Engine, agentId: string, answer: string) => $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId: 't', reason: 'answer', agentId } as never)

const edit = ($: Engine, agentId: string | undefined, file_path: string, old_string: string, new_string: string) => $.tool.call({ tool: 'Edit', file_path, old_string, new_string, agentId } as never)

describe('lothlorien', () => {
  test('sends Galadriel with the purpose, and shows her tests red and locked once she is done', async ($, on) => {
    const world = machine(on)
    await $.session.start({} as never)

    expect(await call($, 'mcp__lothlorien__gaze', { purpose: 'Task 2: POST /beacons/{name}/quench answers 200, 409, 404.' })).toMatch(/Galadriel gazes/)
    expect(world.spawned[0]).toMatchObject({ subagent_type: 'lothlorien:galadriel' })
    expect(String(world.spawned[0]?.prompt)).toContain('<purpose>\nTask 2: POST /beacons/{name}/quench answers 200, 409, 404.\n</purpose>')
    expect(JSON.parse(await call($, 'mcp__lothlorien__mirror', { json: true }))).toMatchObject({ state: 'gazing' })

    await ends($, 'galadriel-1', SHOWN)
    world.files[FILE] = TEST_LINES.join('\n')

    expect(JSON.parse(await call($, 'mcp__lothlorien__mirror', { json: true }))).toEqual({
      state: 'shown',
      ref: '',
      isLocked: true,
      tests: [{ file: 'beacons/tests/test_gondor.py', name: 'test_quenching_one_beacon' }],
      red: 'FAILED test_quenching_one_beacon - assert 404 == 200',
      why: '',
      amendments: [],
      tampered: [],
    })
    // A mod asked: it reads what she showed itself
    expect(world.submitted).toEqual([])
  })

  test('reads what she wrote from the project\'s top while the session\'s directory is in a subfolder', async ($, on) => {
    const world = machine(on)
    await $.session.start({} as never)

    world.cwd = `${CWD}/narsil/tests`
    await call($, 'mcp__lothlorien__gaze', { purpose: 'Task 2: quench one beacon.' })
    await ends($, 'galadriel-1', SHOWN)

    expect(JSON.parse(await call($, 'mcp__lothlorien__mirror', { json: true }))).toMatchObject({ state: 'shown', isLocked: true })
  })

  test('holds her to test files and to commands that test or read', async ($, on) => {
    machine(on)
    await $.session.start({} as never)
    await call($, 'mcp__lothlorien__gaze', { purpose: 'x' })

    expect(await edit($, 'galadriel-1', `${CWD}/beacons/gondor/app.py`, 'a', 'b')).toMatchObject({ deny: expect.stringMatching(/write only in test files/) })
    expect(await edit($, 'galadriel-1', FILE, 'a', 'b')).toMatchObject({ result: 'done' })
    expect(await $.tool.call({ tool: 'Bash', command: 'git add -A', agentId: 'galadriel-1' } as never)).toMatchObject({ deny: expect.stringMatching(/runs only what tests or reads/) })
  })

  test('keeps her tests from being changed without a reason, lets a builder add around them, and lifts the lock once they are committed', async ($, on) => {
    const world = machine(on)
    await $.session.start({} as never)
    await call($, 'mcp__lothlorien__gaze', { purpose: 'x' })
    await ends($, 'galadriel-1', SHOWN)

    const before = TEST_LINES.join('\n')
    const weakened = before.replace('== 200', 'in (200, 404)')

    expect(await edit($, 'gimli-1', FILE, before, weakened)).toMatchObject({ deny: expect.stringMatching(/Galadriel's tests are locked|Her tests are locked/) })
    expect(await edit($, 'gimli-1', FILE, before, `# sting: gondor POST /beacons/amon-din/quench\n${before}`)).toMatchObject({ result: 'done' })
    expect(await $.tool.call({ tool: 'Write', file_path: FILE, content: 'import x\n', agentId: 'gimli-1' } as never)).toMatchObject({ deny: expect.any(String) })

    // A reason unlocks the file, and is kept
    expect(await call($, 'mcp__lothlorien__amend', { file: FILE, why: 'too short' })).toMatch(/Say why/)
    expect(await call($, 'mcp__lothlorien__amend', { file: FILE, why: 'The issue asks for 409 here, not 404.', agentId: 'gimli-1' })).toMatch(/unlocked/)
    expect(await edit($, 'gimli-1', FILE, before, weakened)).toMatchObject({ result: 'done' })
    expect(JSON.parse(await call($, 'mcp__lothlorien__mirror', { json: true })).amendments).toEqual([{ file: 'beacons/tests/test_gondor.py', why: 'The issue asks for 409 here, not 404.', by: 'fellowship:gimli' }])

    // Committed: HEAD has moved past them, and they are anyone's to change
    world.head = 'bbb222'
    expect(JSON.parse(await call($, 'mcp__lothlorien__mirror', { json: true })).isLocked).toBe(false)
  })

  test('shows nothing for a purpose with no behaviour, and is clouded when she shows no red', async ($, on) => {
    machine(on)
    await $.session.start({} as never)

    await call($, 'mcp__lothlorien__gaze', { purpose: 'Name the route in the README.' })
    await ends($, 'galadriel-1', '```json\n{ "tests": [], "red": "", "untestable": "Only the README changes." }\n```')
    expect(JSON.parse(await call($, 'mcp__lothlorien__mirror', { json: true }))).toMatchObject({ state: 'empty', why: 'Only the README changes.' })

    await call($, 'mcp__lothlorien__gaze', { purpose: 'x' })
    await ends($, 'galadriel-1', SHOWN.replace('FAILED test_quenching_one_beacon - assert 404 == 200', ''))
    expect(JSON.parse(await call($, 'mcp__lothlorien__mirror', { json: true }))).toMatchObject({ state: 'clouded', why: 'she did not show her tests red' })
  })

  test('tells the Claude of a person who asked through /mirror what she showed', async ($, on) => {
    const world = machine(on)
    await $.session.start({} as never)

    expect((await $.command.run({ command: 'mirror', args: 'quenching one beacon answers 200' } as never)).text).toMatch(/Galadriel gazes/)
    await ends($, 'galadriel-1', SHOWN)

    expect(world.submitted[0]).toMatch(/^The Mirror shows what is to come: 1 test, red, locked until they are committed\.\n- beacons\/tests\/test_gondor\.py: test_quenching_one_beacon[\s\S]*mcp__lothlorien__amend/)
  })
})

describe('the Mirror, for a mod', () => {
  test('gazes on the lighter model for a task that is not heavy', async ($, on) => {
    const world = machine(on)
    await $.session.start({} as never)

    await call($, 'mcp__lothlorien__gaze', { purpose: 'Task 1: keep when a beacon is lit.', weight: 'standard' })

    expect(world.spawned[0]).toMatchObject({ subagent_type: 'lothlorien:galadriel-swift' })
  })

  test('tells a mod what was taken out of her locked tests with no reason, while they are locked', async ($, on) => {
    const world = machine(on)
    await $.session.start({} as never)
    await call($, 'mcp__lothlorien__gaze', { purpose: 'Task 2: quench.' })
    await ends($, 'galadriel-1', SHOWN)

    world.files[FILE] = TEST_LINES.join('\n')
    expect(JSON.parse(await call($, 'mcp__lothlorien__mirror', { json: true }))).toMatchObject({ isLocked: true, tampered: [] })

    world.files[FILE] = TEST_LINES.join('\n').replace('== 200', 'in (200, 404)')
    expect(JSON.parse(await call($, 'mcp__lothlorien__mirror', { json: true })).tampered).toEqual([{ file: 'beacons/tests/test_gondor.py', lines: [TEST_LINES[2]] }])
  })

  test("gazes in a quest's worktree, and holds a builder sent there to her tests in it, leaving the project's own folder be", async ($, on) => {
    const tree = `${CWD}/.fellowship/trees/12-quench`
    const world = machine(on)
    world.tops.push(tree)
    await $.session.start({} as never)

    await call($, 'mcp__lothlorien__gaze', { purpose: 'Task 2: quench.', ref: 'github:beacons/gondor#12', weight: 'standard', tree })
    expect(world.spawned[0]).toMatchObject({ cwd: tree })
    await ends($, 'galadriel-1', SHOWN)
    expect(JSON.parse(await call($, 'mcp__lothlorien__mirror', { json: true, tree }))).toMatchObject({ state: 'shown', isLocked: true })
    expect(await call($, 'mcp__lothlorien__mirror')).toMatch(/shows nothing yet/)

    // The Fellowship sends its member into the worktree: her tests there are locked to it, the project's own file is not
    await $.agent.spawn({ prompt: 'Build task 2', subagentType: 'fellowship:gimli', cwd: tree })
    const before = TEST_LINES.join('\n')
    const weakened = before.replace('== 200', 'in (200, 404)')

    expect(await edit($, 'gimli-1', `${tree}/beacons/tests/test_gondor.py`, before, weakened)).toMatchObject({ deny: expect.stringMatching(/Her tests are locked/) })
    expect(await edit($, 'gimli-1', FILE, before, weakened)).toMatchObject({ result: 'done' })

    // Its reason is kept with her tests in the worktree, however it names the file
    expect(await call($, 'mcp__lothlorien__amend', { file: 'beacons/tests/test_gondor.py', why: 'The issue asks for 409 here, not 404.', agentId: 'gimli-1' })).toMatch(/unlocked/)
    expect(JSON.parse(await call($, 'mcp__lothlorien__mirror', { json: true, tree })).amendments).toEqual([{ file: 'beacons/tests/test_gondor.py', why: 'The issue asks for 409 here, not 404.', by: 'fellowship:gimli' }])

    // Committed there, and forgotten by its issue once merged
    world.head = 'bbb222'
    expect(JSON.parse(await call($, 'mcp__lothlorien__forget', { ref: 'github:beacons/gondor#12', json: true }))).toMatchObject({ forgotten: true })
    expect(await call($, 'mcp__lothlorien__mirror', { tree })).toMatch(/shows nothing yet/)
  })

  test('forgets only the vision of the issue it is asked about, and says so as JSON', async ($, on) => {
    const world = machine(on)
    await $.session.start({} as never)
    await call($, 'mcp__lothlorien__gaze', { purpose: 'Task 2: quench.', ref: 'github:beacons/gondor#12' })
    await ends($, 'galadriel-1', SHOWN)
    // Her tests are committed: HEAD moved past them
    world.head = 'bbb222'

    expect(JSON.parse(await call($, 'mcp__lothlorien__forget', { ref: 'github:beacons/gondor#13', json: true }))).toMatchObject({ forgotten: false })
    expect(JSON.parse(await call($, 'mcp__lothlorien__forget', { ref: 'github:beacons/gondor#12', json: true }))).toEqual({ forgotten: true, text: 'The Mirror is still.' })
    expect(JSON.parse(await call($, 'mcp__lothlorien__forget', { json: true }))).toMatchObject({ forgotten: false })
  })
})
