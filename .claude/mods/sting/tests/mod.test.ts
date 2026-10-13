import { describe, expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { isSameTest, marksOf, outcomesOf, parseDiffText, parseProject, parseProof, proved, radiusLine, radiusOf, radiusText } from '../hooks/radius'

type Engine = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

const CWD = '/proj'
const NAMED = '# the tests of the tool being written\nnarsil.tests=narsil/tests\nnarsil.test=cargo test --manifest-path narsil/Cargo.toml --test cli\n'

// A path as the tests write it, however the host spells it
const whole = (path: string) => path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')

// What anduril's diff says: two kept runs that changed between HEAD and the working tree, two that did not
const DIFF = [
  "narsil, the working tree against HEAD (93f4e0c): 2 of 4 kept runs changed. Each was played on both builds in a copy of the tool's source folder, with no terminal; a line with - is HEAD (93f4e0c)'s, one with + the working tree's.",
  '',
  'changed: narsil show 999',
  '  --- from/stderr',
  '  +++ to/stderr',
  '  @@ -1 +1 @@',
  '  -narsil: no lighting 999 in the chronicle',
  '  +narsil: lighting 999 is not in the chronicle',
  '',
  'changed: narsil tally --by keeper',
  '  --- from/stdout',
  '  +++ to/stdout',
  '  @@ -3,0 +4 @@',
  '  +ALL            11        74',
  '',
  'unchanged: narsil ls · narsil ls --format json',
].join('\n')

const SAME = "narsil, the working tree against HEAD (93f4e0c): 0 of 2 kept runs changed. Each was played on both builds in a copy of the tool's source folder, with no terminal; a line with - is HEAD (93f4e0c)'s, one with + the working tree's.\n\nunchanged: narsil ls · narsil ls --format json"

// A test file with one test marked on a run that changed, and one that is marked on nothing
const TESTS = [
  '#[test]',
  'fn a_lighting_that_is_not_there_is_said_on_stderr() {',
  '    assert_eq!(stderr(&output), "narsil: no lighting 999 in the chronicle\\n");',
  '}',
  '',
  '// sting: narsil tally --by keeper',
  '#[test]',
  'fn a_tally_ends_with_the_sum_of_all() {',
  '    assert!(stdout(&output).lines().last().unwrap().starts_with("ALL"));',
  '}',
].join('\n')

const cargo = (ended: Record<string, boolean>) => `running ${Object.keys(ended).length} tests\n${Object.entries(ended).map(([name, isOk]) => `test ${name} ... ${isOk ? 'ok' : 'FAILED'}`).join('\n')}\n\ntest result: ok. 1 passed; 0 failed\n`

// What the prove script answers: the new test fails on HEAD's source, the old one on the working tree
const PROOF = {
  label: 'narsil',
  from: { ref: 'HEAD', sha: '93f4e0cabc', error: '', exitCode: 101, output: cargo({ a_lighting_that_is_not_there_is_said_on_stderr: true, a_tally_ends_with_the_sum_of_all: false }) },
  to: { ref: 'work', sha: '', error: '', exitCode: 101, output: cargo({ a_lighting_that_is_not_there_is_said_on_stderr: false, a_tally_ends_with_the_sum_of_all: true }) },
}

/** Stands for the machine beneath the mod and for anduril beside it: files by absolute path, what anduril says, what a proof answers. */
const machine = (on: On, given: Record<string, string> = {}) => {
  const files: Record<string, string> = { ...given }
  const world = { files, diff: DIFF, proof: JSON.stringify(PROOF), asked: [] as Record<string, unknown>[], jobs: [] as Record<string, unknown>[] }

  mock.clock(on, { now: 1_800_000_000_000 })
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
    const isProof = e.argv.some(arg => arg.endsWith('sting_prove.py'))

    if (isProof) world.jobs.push(JSON.parse(given.stdin ?? given.init?.stdin ?? '{}') as Record<string, unknown>)

    // Any other command is git listing the test files
    const listed = Object.keys(files).filter(path => path.startsWith(`${CWD}/narsil/tests/`)).map(path => path.slice(CWD.length + 1)).join('\n')

    return { value: { exitCode: 0, stdout: isProof ? world.proof : listed, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
  on('tool.call', { tool: 'mcp__anduril__diff' }, (_, e) => {
    world.asked.push(e as unknown as Record<string, unknown>)

    return { result: world.diff } as never
  })

  return world
}

const named = (on: On) => machine(on, { [`${CWD}/.claude/sting`]: NAMED, [`${CWD}/narsil/tests/cli.rs`]: TESTS })

const call = async ($: Engine, tool: string, input: Record<string, unknown> = {}) => String((await $.tool.call({ tool, ...input } as never)).result)

const mountPane = ($: Engine, surface: 'terminal' | 'desktop' = 'terminal') =>
  $.ui.mount({ plugin: 'sting', surface, component: 'Pane', props: { bodyColumns: 100 } as never, requestId: 'sting' })

// The facts a system prompt is composed from, as far as a test names them
const FACTS = { model: 'claude-test', promptModel: 'claude-test', surfaces: [], tools: [], outputStyle: null, traits: [] } as never

describe('the tests a project names', () => {
  test('are read a tool each, with where they are and how they are run, and a tool with half of it is left out', () => {
    expect(parseProject(`${NAMED}quill.tests=/opt/quill/it, quill/e2e\nquill.test=make it\nhalf.tests=half/tests\n`, CWD)).toEqual([
      { label: 'narsil', tests: [`${CWD}/narsil/tests`], test: 'cargo test --manifest-path narsil/Cargo.toml --test cli' },
      { label: 'quill', tests: ['/opt/quill/it', `${CWD}/quill/e2e`], test: 'make it' },
    ])
  })
})

describe("what anduril said changed", () => {
  test('is read back as the runs that changed, each with how, and the ones that did not', () => {
    const diff = parseDiffText(DIFF)

    expect(diff?.summary).toBe('narsil, the working tree against HEAD (93f4e0c): 2 of 4 kept runs changed')
    expect(diff?.changed.map(({ line }) => line)).toEqual(['narsil show 999', 'narsil tally --by keeper'])
    expect(diff?.changed[0]?.evidence).toContain('+narsil: lighting 999 is not in the chronicle')
    expect(diff?.changed[0]?.evidence).not.toContain('ALL')
    expect(diff?.unchanged).toEqual(['narsil ls', 'narsil ls --format json'])
  })

  test('is no comparison when anduril says why it made none', () => {
    expect(parseDiffText('narsil, the working tree against HEAD (93f4e0c): not compared.\nthe working tree was not played: it does not build')).toBeUndefined()
    expect(parseDiffText('anduril watches no tool here.')).toBeUndefined()
  })
})

describe('a mark', () => {
  test('names the test declared next beneath it, in the language the test is written in', () => {
    expect(marksOf(TESTS)).toEqual([{ line: 'narsil tally --by keeper', test: 'a_tally_ends_with_the_sum_of_all' }])
    expect(marksOf('# sting: quill --version\n# sting: quill -V\ndef test_version(run):\n    pass\n')).toEqual([
      { line: 'quill --version', test: 'test_version' },
      { line: 'quill -V', test: 'test_version' },
    ])
    expect(marksOf("/* sting: quill fmt a.md */\ntest('formats a file in place', async () => {})\n")).toEqual([{ line: 'quill fmt a.md', test: 'formats a file in place' }])
    expect(marksOf('// sting: quill --help\nfunc TestHelp(t *testing.T) {}\n')).toEqual([{ line: 'quill --help', test: 'TestHelp' }])
    expect(marksOf('// sting: quill --help\n')).toEqual([])
  })
})

describe('how a test ended', () => {
  test('is read from what cargo, pytest, go and a TAP runner write', () => {
    expect(outcomesOf(cargo({ one: true, two: false }))).toEqual({ one: 'pass', two: 'fail' })
    expect(outcomesOf('tests/test_cli.py::test_version PASSED   [ 50%]\ntests/test_cli.py::test_help FAILED   [100%]\n')).toEqual({ 'tests/test_cli.py::test_version': 'pass', 'tests/test_cli.py::test_help': 'fail' })
    expect(outcomesOf('--- PASS: TestHelp (0.00s)\n--- FAIL: TestVersion (0.01s)\n')).toEqual({ TestHelp: 'pass', TestVersion: 'fail' })
    expect(outcomesOf('ok 1 - prints its version\nnot ok 2 - prints its help\n')).toEqual({ 'prints its version': 'pass', 'prints its help': 'fail' })
  })

  test('is found under the name of a mark where the runner names the test by its path', () => {
    expect(isSameTest('test_version', 'tests/test_cli.py::test_version')).toBe(true)
    expect(isSameTest('test_version', 'test_version')).toBe(true)
    expect(isSameTest('version', 'tests/test_cli.py::test_version')).toBe(false)
  })
})

describe('a radius', () => {
  const made = radiusOf({ label: 'narsil', at: 0, diff: parseDiffText(DIFF)!, marks: marksOf(TESTS) })

  test('holds the runs that changed alone, bare or marked by a test', () => {
    expect(made.seams.map(({ line, state }) => [line, state])).toEqual([
      ['narsil show 999', 'bare'],
      ['narsil tally --by keeper', 'marked'],
    ])
    expect(radiusLine(made)).toBe('narsil: 2 kept runs changed · 1 marked · 1 bare')

    const said = radiusText(made)
    expect(said).toContain('bare: narsil show 999\n  no test is marked on it. Write one that makes this run and asserts what it now does, with a comment `sting: narsil show 999` above it.')
    expect(said).toContain('  +narsil: lighting 999 is not in the chronicle')
    expect(said).toContain('Outside the radius, owed no test: narsil ls · narsil ls --format json')
  })

  test('pins a run whose test fails on the commit and passes on the working tree, and names the tests that turned', () => {
    const done = proved(made, parseProof(JSON.stringify(PROOF))!)

    expect(done.seams.map(({ state }) => state)).toEqual(['bare', 'pinned'])
    expect(done.seams[1]?.tests).toEqual([{ name: 'a_tally_ends_with_the_sum_of_all', from: 'fail', to: 'pass' }])
    expect(done.turned).toEqual(['a_lighting_that_is_not_there_is_said_on_stderr'])
    expect(radiusText(done)).toContain("Passing on the commit's source and failing on the working tree: a_lighting_that_is_not_there_is_said_on_stderr.")
  })

  test('calls a test loose that passes on both sides, and a run broken whose test fails on the working tree', () => {
    const both = (from: boolean, to: boolean) => ({
      from: { ...PROOF.from, output: cargo({ a_tally_ends_with_the_sum_of_all: from }) },
      to: { ...PROOF.to, output: cargo({ a_tally_ends_with_the_sum_of_all: to }) },
    })

    expect(proved(made, both(true, true)).seams[1]?.state).toBe('loose')
    expect(proved(made, both(true, false)).seams[1]?.state).toBe('broken')
    expect(radiusText(proved(made, both(true, true)))).toContain('a_tally_ends_with_the_sum_of_all passes on both sides, so it does not see the change')
  })

  test('says why a side proved nothing, and leaves its runs marked', () => {
    const done = proved(made, { from: { ...PROOF.from, error: 'git knows no commit by the name v9', output: '' }, to: PROOF.to })

    expect(done.seams[1]?.state).toBe('marked')
    expect(done.unproved).toContain('The tests were not run on HEAD (93f4e0c): git knows no commit by the name v9.')
  })
})

describe('sting', () => {
  test('says how to have tests known to a Claude that asks where none are, and asks anduril nothing', async ($, on) => {
    const world = machine(on)

    expect(await call($, 'mcp__sting__radius')).toMatch(/sting knows no integration tests here.*narsil\.tests=narsil\/tests/s)
    expect(world.asked).toHaveLength(0)
  })

  test('tells Claude which tests are owed, and says nothing where no tests are known', async ($, on) => {
    const world = named(on)
    on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude.', scope: 'shared' }] }) as never)

    expect((await $.prompt.compose(FACTS)).sections.map(({ id }) => id)).toEqual(['intro'])

    // The project's file is read when a radius is asked for
    world.diff = SAME
    await call($, 'mcp__sting__radius')
    const { sections } = await $.prompt.compose(FACTS)

    expect(sections.map(({ id }) => id)).toEqual(['intro', 'sting:radius'])
    expect(sections[1]?.text).toContain('narsil: narsil/tests')
    expect(sections[1]?.text).toContain('`sting: <the run as listed>`')
  })

  test('hands Claude the radius from what anduril plays, against the commit it names', async ($, on) => {
    const world = named(on)

    const said = await call($, 'mcp__sting__radius', { against: 'main' })

    expect(world.asked[0]).toMatchObject({ target: 'narsil', from: 'main', to: 'work' })
    expect(said).toContain('narsil: 2 kept runs changed · 1 marked · 1 bare.')
    expect(said).toContain('marked: narsil tally --by keeper\n  marked by a_tally_ends_with_the_sum_of_all, not proved')
    expect(world.jobs).toHaveLength(0)
  })

  test("says what anduril says where it compared nothing", async ($, on) => {
    const world = named(on)
    world.diff = 'narsil, the working tree against HEAD (93f4e0c): not compared.\nthe working tree was not played: it does not build'

    expect(await call($, 'mcp__sting__radius')).toContain('it does not build')
  })

  test('runs the tests on both sides when asked to prove, and no test where no kept run changed', async ($, on) => {
    const world = named(on)

    const said = await call($, 'mcp__sting__prove')

    expect(world.jobs[0]).toEqual({ home: CWD, label: 'narsil', tests: [`${CWD}/narsil/tests`], test: 'cargo test --manifest-path narsil/Cargo.toml --test cli', from: 'HEAD' })
    expect(world.files[`${CWD}/.sting/.gitignore`]).toBe('*\n')
    expect(said).toContain('narsil: 2 kept runs changed · 1 pinned · 1 bare · 1 test turned.')
    expect(said).toContain('pinned: narsil tally --by keeper')

    world.diff = SAME
    expect(await call($, 'mcp__sting__prove')).toContain('Nothing a kept run does changed: no integration test is owed.')
    expect(world.jobs).toHaveLength(1)
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`shows the radius and what a proof found, and the evidence of a run that is opened, on ${surface}`, async ($, on) => {
      named(on)
      const pane = await mountPane($, surface)
      await pane.press({ key: 'refresh' })

      await pane.press({ key: 'radius' })
      const drawn = await call($, 'mcp__sting__pane')
      expect(drawn).toContain('narsil: 2 kept runs changed · 1 marked · 1 bare')
      expect(drawn).toMatch(/bare\s+\[narsil show 999\]/)
      expect(drawn).toContain('outside the radius: narsil ls · narsil ls --format json')

      await pane.press({ key: 'prove' })
      const provedPane = await call($, 'mcp__sting__pane')
      expect(provedPane).toMatch(/pinned\s+\[narsil tally --by keeper\]\s+a_tally_ends_with_the_sum_of_all \(fail → pass\)/)
      expect(provedPane).toContain("Passing on the commit's source and failing on the working tree: a_lighting_that_is_not_there_is_said_on_stderr")

      await pane.press({ key: 'seam-narsil show 999' })
      expect(await call($, 'mcp__sting__pane')).toContain('+narsil: lighting 999 is not in the chronicle')
    })
  }

  test('glows above the prompt while a changed run is not pinned, and is dark before a radius and once hidden', async ($, on) => {
    named(on)
    // What the engine draws there when the mod draws nothing
    on('ui.render', { component: 'AbovePrompt' } as never, () => ({ type: 'Text', props: {}, children: [''] }) as never)
    const mountBand = () => $.ui.mount({ plugin: 'sting', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10 } as never })

    const dark = await mountBand()
    expect(await dark.find({ text: /sting/ })).toBeUndefined()
    await dark.unmount()

    await call($, 'mcp__sting__radius')
    const band = await mountBand()
    expect(await band.find({ text: /sting · narsil: 2 kept runs changed · 1 marked · 1 bare/ })).toBeDefined()

    await band.press({ key: 'sting-hide' })
    expect(await band.find({ text: /sting/ })).toBeUndefined()
  })
})
