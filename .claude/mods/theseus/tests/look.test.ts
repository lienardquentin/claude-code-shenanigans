import { describe, expect, test } from 'claude-code/testing'

import type { Ran } from '../core/forge'
import { lookAt } from '../core/look'
import type { Handler, Look, Machine } from '../core/look'
import { marksOf, parseProject } from '../core/proof'
import type { Radius, Target } from '../core/proof'

const TREE = '/proj'

const TARGETS = parseProject(
  [
    'narsil=cli@narsil',
    'narsil.tests=narsil/tests',
    'narsil.test=cargo test --test cli -- --exact {tests}',
    'narsil.check=cargo clippy -- -D warnings',
    'narsil.check=sh scripts/deslop.sh narsil {against}',
    'gondor=service:gondor.app:app@beacons/gondor',
    'gondor.tests=beacons/tests',
    'gondor.test=uv run pytest -k "{tests: or }"',
    'gondor.affected=uv run pytest beacons/tests',
    '$ gondor GET /health',
    'quill=service@quill',
    'anor=frontend@beacons/anor',
  ].join('\n'),
  TREE,
)

const target = (label: string): Target => TARGETS.find(one => one.label === label) as Target

// What the recorder's diff says of narsil: one kept run changed
const CLI_DIFF = [
  'narsil, the working tree against HEAD (209dec6): 1 of 2 kept runs changed.',
  '',
  'changed: narsil show 999',
  '  -narsil: no lighting 999 in the chronicle',
  '  +narsil: lighting 999 is not in the chronicle',
  '',
  'unchanged: narsil ls',
].join('\n')

const ok = (stdout: unknown): Ran => ({ exitCode: 0, stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout), stderr: '' })

const side = (ref: string, output: string) => ({ ref, sha: ref === 'work' ? '' : '209dec6ccef9', error: '', exitCode: 1, output })

/** A machine that answers from memory, and keeps what the look ran, said and kept. */
const machine = (answers: Partial<Record<Handler, Ran>> = {}, kept = CLI_DIFF) => {
  const world = { jobs: [] as { handler: Handler; job: Record<string, unknown> }[], said: [] as string[], kept: [] as Radius[], ran: [] as string[] }
  const files: Record<string, string> = {
    [`${TREE}/narsil/tests/cli.rs`]: ['// pins: narsil show 999', 'fn show_says_what_is_missing() {}'].join('\n'),
  }
  const fake: Machine = {
    shell: {
      run: async argv => {
        world.ran.push(argv.join(' '))

        if (argv.join(' ') === 'git ls-files -co --exclude-standard -- /proj/narsil/tests') return ok('narsil/tests/cli.rs\n')

        return ok('')
      },
    },
    read: async path => files[path],
    handle: async (handler, job) => {
      world.jobs.push({ handler, job: job as Record<string, unknown> })

      return answers[handler] ?? { exitCode: 1, stdout: '', stderr: `${handler}: not set up` }
    },
    keptRuns: async () => ({ said: kept }),
    now: async () => 1_800_000_000_000,
    say: async doing => void world.said.push(doing),
    keep: async radius => void world.kept.push(radius),
  }

  return { fake, world }
}

const look = (over: Partial<Look> = {}): Look => ({ chosen: [target('narsil')], against: 'HEAD', isProving: false, required: [], tree: TREE, changes: new Map(), ...over })

describe('a look', () => {
  test("reads a CLI's radius from the run recorder, with the tests marked on what changed, and keeps it as it is made", async () => {
    const { fake, world } = machine()
    const [one] = await lookAt(fake, look())

    expect(one?.found).toMatchObject({ label: 'narsil', seams: [{ line: 'narsil show 999', state: 'marked', tests: [{ name: 'show_says_what_is_missing' }] }], unchanged: ['narsil ls'] })
    expect(world.kept.map(radius => radius.label)).toEqual(['narsil'])
    expect(world.said.at(-1)).toBe('')
    expect(world.jobs).toEqual([])
  })

  test('plays nothing of a target whose folders the change did not reach', async () => {
    const { fake, world } = machine()
    const [one] = await lookAt(fake, look({ changes: new Map([['narsil', '']]) }))

    expect(one?.found).toMatchObject({ summary: 'narsil: the change does not reach its folders', seams: [] })
    expect(world.said.filter(said => said !== '')).toEqual([])
  })

  test('says why a target has no radius: what the recorder said, a service with no app, a frontend no kept run sees', async () => {
    const lost = await lookAt({ ...machine().fake, keptRuns: async () => ({ why: 'The recorder is not loaded in this session' }) }, look())
    const [quill, anor] = await lookAt(machine().fake, look({ chosen: [target('quill'), target('anor')] }))

    expect(lost[0]?.found).toBe('The recorder is not loaded in this session')
    expect(quill?.found).toMatch(/^quill names no app/)
    expect(anor?.found).toMatchObject({ isUnhandled: true, seams: [] })
  })
})

describe('a proof', () => {
  const proof = (from: string, to: string) => ok({ label: 'narsil', from: side('HEAD', from), to: side('work', to) })

  test('runs only the tests marked on what changed, and pins a run whose test fails before and passes after', async () => {
    const { fake, world } = machine({ prove: proof('test show_says_what_is_missing ... FAILED', 'test show_says_what_is_missing ... ok'), affected: ok('') })
    const [one] = await lookAt(fake, look({ isProving: true }))

    expect(world.jobs.find(one => one.handler === 'prove')?.job).toMatchObject({ home: TREE, test: 'cargo test --test cli -- --exact show_says_what_is_missing', from: 'HEAD' })
    expect(one?.found).toMatchObject({ isProved: true, seams: [{ state: 'pinned' }] })
  })

  test('says why the proof could not be made when its handler fails, and keeps the radius', async () => {
    const { fake } = machine({ affected: ok('') })
    const [one] = await lookAt(fake, look({ isProving: true }))

    expect(one?.found).toMatchObject({ isProved: false })
    expect(typeof one?.found === 'object' && one.found.unproved.split('\n')[0]).toBe('The proof of narsil could not be made: prove: not set up')
  })

  test('runs each check as its own gate, the commit compared with set in it', async () => {
    const { fake, world } = machine({ prove: proof('', ''), affected: ok('') })

    await lookAt(fake, look({ isProving: true, against: 'main' }))

    expect(world.jobs.filter(one => one.handler === 'affected').map(one => one.job.command)).toEqual(['cargo clippy -- -D warnings', "sh scripts/deslop.sh narsil 'main'"])
  })

  test("runs what a change of a target can break, and the tests written before the change though no run is marked", async () => {
    const { fake, world } = machine({ service: ok({ label: 'gondor', from: side('HEAD', ''), to: side('work', ''), error: '', cases: [{ line: 'gondor GET /health', isChanged: false, evidence: '' }] }), affected: ok(''), prove: proof('', '') })

    await lookAt(fake, look({ chosen: [target('gondor')], isProving: true, required: [{ file: 'beacons/tests/test_gondor.py', name: 'test_burned_for' }] }))

    expect(world.jobs.map(one => one.handler)).toEqual(['service', 'prove', 'affected'])
    expect(world.jobs[1]?.job.test).toBe('uv run pytest -k "test_burned_for"')
    expect(world.jobs[2]?.job).toMatchObject({ command: 'uv run pytest beacons/tests', tests: ['/proj/beacons/tests'] })
  })

  test('hands a service played in a run worktree the project folder, whose database it plays against', async () => {
    const { fake, world } = machine({ service: ok({ label: 'gondor', from: side('HEAD', ''), to: side('work', ''), error: '', cases: [] }) })

    await lookAt(fake, look({ chosen: [target('gondor')], tree: '/proj/.theseus/trees/x', project: TREE }))

    expect(world.jobs[0]?.job).toMatchObject({ home: '/proj/.theseus/trees/x', project: TREE, app: 'gondor.app:app' })
  })
})

describe('the marks on a kept run', () => {
  test('are written pins:, and a mark written sting: before the rename still reads', () => {
    expect(marksOf(['// pins: narsil show 999', 'fn show_says_what_is_missing() {}', '# sting: gondor GET /health', 'def test_health(client):'].join('\n'))).toEqual([
      { line: 'narsil show 999', test: 'show_says_what_is_missing' },
      { line: 'gondor GET /health', test: 'test_health' },
    ])
  })
})
