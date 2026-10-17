import { describe, expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { blocksOf, forgottenOf, isChanging, isTestPath, missingFrom, parseGaze, takenBy, tamperedWith } from '../hooks/lothlorien/mirror'

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
    expect(parseGaze(SHOWN)).toEqual({ tests: [{ file: 'beacons/tests/test_gondor.py', name: 'test_quenching_one_beacon' }], red: 'FAILED test_quenching_one_beacon - assert 404 == 200', unrun: [], untestable: '' })
    expect(parseGaze('```json\n{ "tests": [], "red": "", "untestable": "Only the README changes." }\n```')).toMatchObject({ untestable: 'Only the README changes.' })
    expect(parseGaze('I wrote some tests.')).toBeUndefined()
  })

  test('reads a test that cannot run here apart from the red ones, with why', () => {
    const answer = JSON.stringify({ tests: [], red: '', unrun: [{ file: 'orcrist/tests/cli.rs', name: 'a_folder_another_user_owns_keeps_nothing', why: 'needs root' }, { name: 'no file' }], untestable: '' })

    expect(parseGaze(`\`\`\`json\n${answer}\n\`\`\``)).toMatchObject({ tests: [], unrun: [{ file: 'orcrist/tests/cli.rs', name: 'a_folder_another_user_owns_keeps_nothing', why: 'needs root' }] })
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
    return { model: 'opus', ...(/^middle-earth:(?!galadriel)/.test(String(given.subagent_type ?? given.subagentType ?? '')) ? { agentId: 'gimli-1' } : {}) } as never
  })
  // Core alone mints an agent's id: she is known by the type she runs as
  on('agent.list', () => ({ value: [{ id: 'galadriel-1', description: 'x', type: 'middle-earth:galadriel', status: 'running' }, { id: 'gimli-1', description: 'x', type: 'middle-earth:gimli', status: 'running' }] }) as never)
  on('prompt.submit', (_, e) => {
    world.submitted.push(e.text)

    return { text: e.text } as never
  })
  on('agent.register', () => ({ value: { agent: 'middle-earth:galadriel' } }) as never)
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

    expect(await call($, 'mcp__middle-earth__gaze', { purpose: 'Task 2: POST /beacons/{name}/quench answers 200, 409, 404.' })).toMatch(/Galadriel gazes/)
    expect(world.spawned[0]).toMatchObject({ subagent_type: 'middle-earth:galadriel' })
    expect(String(world.spawned[0]?.prompt)).toContain('<purpose>\nTask 2: POST /beacons/{name}/quench answers 200, 409, 404.\n</purpose>')
    expect(await call($, 'mcp__middle-earth__mirror')).toBe('Galadriel gazes into the Mirror: the tests are being written.')

    await ends($, 'galadriel-1', SHOWN)
    world.files[FILE] = TEST_LINES.join('\n')

    expect(await call($, 'mcp__middle-earth__mirror')).toBe(
      [
        'The Mirror shows what is to come: 1 test, red, locked until they are committed.',
        '- beacons/tests/test_gondor.py: test_quenching_one_beacon',
        '',
        'How they failed:',
        'FAILED test_quenching_one_beacon - assert 404 == 200',
        '',
        'Make them pass without changing them. A test that is wrong is changed only after mcp__middle-earth__amend says which file and why: the reason goes to whoever judges the change.',
      ].join('\n'),
    )
    // Claude asked: it reads what she showed itself
    expect(world.submitted).toEqual([])
  })

  test('reads what she wrote from the project\'s top while the session\'s directory is in a subfolder', async ($, on) => {
    const world = machine(on)
    await $.session.start({} as never)

    world.cwd = `${CWD}/narsil/tests`
    await call($, 'mcp__middle-earth__gaze', { purpose: 'Task 2: quench one beacon.' })
    await ends($, 'galadriel-1', SHOWN)

    expect(await call($, 'mcp__middle-earth__mirror')).toMatch(/^The Mirror shows what is to come: 1 test, red, locked until they are committed\./)
  })

  test('holds her to test files and to commands that test or read', async ($, on) => {
    machine(on)
    await $.session.start({} as never)
    await call($, 'mcp__middle-earth__gaze', { purpose: 'x' })

    expect(await edit($, 'galadriel-1', `${CWD}/beacons/gondor/app.py`, 'a', 'b')).toMatchObject({ deny: expect.stringMatching(/write only in test files/) })
    expect(await edit($, 'galadriel-1', FILE, 'a', 'b')).toMatchObject({ result: 'done' })
    expect(await $.tool.call({ tool: 'Bash', command: 'git add -A', agentId: 'galadriel-1' } as never)).toMatchObject({ deny: expect.stringMatching(/runs only what tests or reads/) })
  })

  test('keeps her tests from being changed without a reason, lets a builder add around them, and lifts the lock once they are committed', async ($, on) => {
    const world = machine(on)
    await $.session.start({} as never)
    await call($, 'mcp__middle-earth__gaze', { purpose: 'x' })
    await ends($, 'galadriel-1', SHOWN)

    const before = TEST_LINES.join('\n')
    const weakened = before.replace('== 200', 'in (200, 404)')

    expect(await edit($, 'gimli-1', FILE, before, weakened)).toMatchObject({ deny: expect.stringMatching(/Galadriel's tests are locked|Her tests are locked/) })
    expect(await edit($, 'gimli-1', FILE, before, `# sting: gondor POST /beacons/amon-din/quench\n${before}`)).toMatchObject({ result: 'done' })
    expect(await $.tool.call({ tool: 'Write', file_path: FILE, content: 'import x\n', agentId: 'gimli-1' } as never)).toMatchObject({ deny: expect.any(String) })

    // A reason unlocks the file, and is kept
    expect(await call($, 'mcp__middle-earth__amend', { file: FILE, why: 'too short' })).toMatch(/Say why/)
    expect(await call($, 'mcp__middle-earth__amend', { file: FILE, why: 'The issue asks for 409 here, not 404.', agentId: 'gimli-1' })).toMatch(/unlocked/)
    expect(await edit($, 'gimli-1', FILE, before, weakened)).toMatchObject({ result: 'done' })
    expect(await call($, 'mcp__middle-earth__mirror')).toContain('Changed since, and why:\n- beacons/tests/test_gondor.py, by middle-earth:gimli: The issue asks for 409 here, not 404.')

    // A test of hers that cannot run here is owed no passing, and stays locked: the file is not unlocked for it
    expect(await call($, 'mcp__middle-earth__amend', { file: FILE, test: 'test_quenching_one_beacon', why: 'It needs a second host to quench from.', agentId: 'gimli-1' })).toMatch(/cannot run here: it stays locked/)
    expect(await call($, 'mcp__middle-earth__mirror')).toMatch(/^The Mirror shows what is to come: 0 tests, red, and 1 that cannot run here, locked[\s\S]*cannot run here, and are owed no passing:\n- beacons\/tests\/test_gondor\.py: test_quenching_one_beacon, It needs a second host to quench from\. \(said by middle-earth:gimli\)/)

    // Committed: HEAD has moved past them, and they are anyone's to change
    world.head = 'bbb222'
    expect(await call($, 'mcp__middle-earth__mirror')).toMatch(/^The Mirror shows what is to come: 0 tests, red, and 1 that cannot run here, committed since\./)
  })

  test('shows nothing for a purpose with no behaviour, and is clouded when she shows no red', async ($, on) => {
    machine(on)
    await $.session.start({} as never)

    await call($, 'mcp__middle-earth__gaze', { purpose: 'Name the route in the README.' })
    await ends($, 'galadriel-1', '```json\n{ "tests": [], "red": "", "untestable": "Only the README changes." }\n```')
    expect(await call($, 'mcp__middle-earth__mirror')).toBe('The Mirror shows nothing to test: Only the README changes.')

    await call($, 'mcp__middle-earth__gaze', { purpose: 'x' })
    await ends($, 'galadriel-1', SHOWN.replace('FAILED test_quenching_one_beacon - assert 404 == 200', ''))
    expect(await call($, 'mcp__middle-earth__mirror')).toMatch(/^The Mirror is clouded: she did not show her tests red/)
  })

  test('tells the Claude of a person who asked through /mirror what she showed', async ($, on) => {
    const world = machine(on)
    await $.session.start({} as never)

    expect((await $.command.run({ command: 'mirror', args: 'quenching one beacon answers 200' } as never)).text).toMatch(/Galadriel gazes/)
    await ends($, 'galadriel-1', SHOWN)

    expect(world.submitted[0]).toMatch(/^The Mirror shows what is to come: 1 test, red, locked until they are committed\.\n- beacons\/tests\/test_gondor\.py: test_quenching_one_beacon[\s\S]*mcp__middle-earth__amend/)
  })
})

describe('the Mirror, for a quest', () => {
  test('gazes on the lighter model for a task that is not heavy', async ($, on) => {
    const world = machine(on)
    await $.session.start({} as never)

    await call($, 'mcp__middle-earth__gaze', { purpose: 'Task 1: keep when a beacon is lit.', weight: 'standard' })

    expect(world.spawned[0]).toMatchObject({ subagent_type: 'middle-earth:galadriel-swift' })
  })

  test('says what was taken out of her locked tests with no reason, while they are locked', async ($, on) => {
    const world = machine(on)
    await $.session.start({} as never)
    await call($, 'mcp__middle-earth__gaze', { purpose: 'Task 2: quench.' })
    await ends($, 'galadriel-1', SHOWN)

    world.files[FILE] = TEST_LINES.join('\n')
    expect(await call($, 'mcp__middle-earth__mirror')).not.toMatch(/Taken out of her tests/)

    world.files[FILE] = TEST_LINES.join('\n').replace('== 200', 'in (200, 404)')
    expect(await call($, 'mcp__middle-earth__mirror')).toContain(`Taken out of her tests with no reason given (an edit the lock did not see):\n- beacons/tests/test_gondor.py: \`${TEST_LINES[2]?.trim() ?? ''}\``)
  })

  test("gazes in the quest's worktree a builder is sent to, holds her and the builder to her tests there, and leaves the project's own folder be", async ($, on) => {
    const tree = `${CWD}/.fellowship/trees/12-quench`
    const world = machine(on)
    world.tops.push(tree)
    await $.session.start({} as never)

    // A builder sent into the worktree: what it asks of the Mirror is of that worktree
    await $.agent.spawn({ prompt: 'Build task 2', subagentType: 'middle-earth:gimli', cwd: tree } as never)
    await call($, 'mcp__middle-earth__gaze', { purpose: 'Task 2: quench.', weight: 'standard', agentId: 'gimli-1' })
    expect(world.spawned.at(-1)).toMatchObject({ cwd: tree })

    // She writes her tests in the worktree alone: a test file of the person's checkout, or one climbed to, is not hers
    expect(await edit($, 'galadriel-1', FILE, 'a', 'b')).toMatchObject({ deny: expect.stringMatching(/The Mirror is in .*12-quench/) })
    expect(await edit($, 'galadriel-1', `${tree}/../../../beacons/tests/test_gondor.py`, 'a', 'b')).toMatchObject({ deny: expect.stringMatching(/The Mirror is in/) })
    expect(await edit($, 'galadriel-1', `${tree}/beacons/tests/test_gondor.py`, 'a', 'b')).toMatchObject({ result: 'done' })
    await ends($, 'galadriel-1', SHOWN)
    expect(await call($, 'mcp__middle-earth__mirror', { agentId: 'gimli-1' })).toMatch(/^The Mirror shows what is to come: 1 test, red, locked/)
    expect(await call($, 'mcp__middle-earth__mirror')).toMatch(/shows nothing yet/)

    // Her tests there are locked to the builder, the project's own file is not; and the builder, sent into the worktree,
    // is held to it from its first call
    const before = TEST_LINES.join('\n')
    const weakened = before.replace('== 200', 'in (200, 404)')

    expect(await edit($, 'gimli-1', `${tree}/beacons/tests/test_gondor.py`, before, weakened)).toMatchObject({ deny: expect.stringMatching(/Her tests are locked/) })
    expect(await edit($, undefined, FILE, before, weakened)).toMatchObject({ result: 'done' })
    expect(await edit($, 'gimli-1', FILE, before, weakened)).toMatchObject({ deny: expect.stringMatching(/You work in the quest's worktree/) })

    // Its reason is kept with her tests in the worktree, however it names the file
    expect(await call($, 'mcp__middle-earth__amend', { file: 'beacons/tests/test_gondor.py', why: 'The issue asks for 409 here, not 404.', agentId: 'gimli-1' })).toMatch(/unlocked/)
    expect(await call($, 'mcp__middle-earth__mirror', { agentId: 'gimli-1' })).toContain('- beacons/tests/test_gondor.py, by middle-earth:gimli: The issue asks for 409 here, not 404.')
  })

  test('forgets, for an issue, only the visions gazed for it, and the project\'s own for none', () => {
    const home = { place: { isHome: true }, held: {} }
    const twelve = { place: { isHome: false }, held: { ref: 'github:beacons/gondor#12' } }
    const thirteen = { place: { isHome: false }, held: { ref: 'github:beacons/gondor#13' } }

    expect(forgottenOf([home, twelve, thirteen], 'github:beacons/gondor#12')).toEqual([home, twelve])
    expect(forgottenOf([twelve, thirteen], 'github:beacons/gondor#14')).toEqual([])
    expect(forgottenOf([home, twelve], '')).toEqual([home])
  })
})
