import { describe, expect, test } from 'claude-code/testing'

import type { Run, RunTask } from '../types'
import { builderEnded, prove, sendNext } from '../core/build'
import type { Ports } from '../core/build'
import { HAND_BACK } from '../core/run'
import { canMove } from '../core/phases'
import type { Ran } from '../core/forge'

// The build's loop on plain fakes of its ports: no engine, no `$`, only what each port was asked and answered

const TREE = '/proj/.pipeline/trees/errand-7-quench'

const TASK: RunTask = { id: 1, title: 'Quench a beacon', why: 'the issue', steps: ['do it'], files: ['beacons/gondor/app.py'], dependsOn: [], acceptance: 'it is quenched', weight: 'standard', state: 'todo' }

const errandRun = (over: Partial<Run> = {}): Run => ({
  kind: 'errand',
  ref: 'github:o/r#7',
  url: 'https://github.com/o/r/issues/7',
  title: 'Quench',
  branch: 'errand-7-quench',
  base: 'main',
  tree: TREE,
  tasks: [TASK],
  isAuto: false,
  phase: 'ready',
  current: null,
  proof: '',
  proofLine: '',
  verdictLine: '',
  testsToPass: null,
  commits: [],
  pr: '',
  gitRuns: '',
  at: 0,
  ...over,
})

/** A world of fakes: the runs held, what was said and asked, the agents sent, and git as a few answers. */
function world(run: Run, answers: { proof?: unknown; judgement?: unknown } = {}) {
  const runs = new Map<string, Run>([[run.ref, run]])
  const said: string[] = []
  const wanted: string[] = []
  const sent: { builder: string; cwd: string }[] = []
  const ran: string[] = []
  let head = 'aaa1111'

  const answer = (stdout: string, exitCode = 0): Ran => ({ exitCode, stdout, stderr: '' })
  const shell = {
    run: async (argv: readonly string[]): Promise<Ran> => {
      const line = argv.join(' ')

      ran.push(line)
      if (line === 'git rev-parse HEAD') return answer(`${head}\n`)
      if (line.startsWith('git status --porcelain')) return answer(' M beacons/gondor/app.py\n')
      if (line.startsWith('git config')) return answer('', 1)
      if (line.startsWith('git rev-parse --path-format=absolute')) return answer('/proj/.git/hooks\n')
      if (line.startsWith('git diff --cached')) return answer('+def quench(): ...\n')
      if (line.startsWith('git commit')) {
        head = 'bbb2222'

        return answer('')
      }

      return answer('')
    },
  }

  const ports: Ports = {
    runs: {
      at: async ref => runs.get(ref) ?? null,
      all: async () => [...runs.values()],
      keep: async (ref, change) => {
        const was = runs.get(ref)

        if (was === undefined) return null

        const next = change(was)

        if (!canMove(was.phase, next.phase)) throw new Error(`cannot go from ${was.phase} to ${next.phase}`)
        runs.set(ref, next)

        return next
      },
      put: async held => void runs.set(held.ref, held),
      setWork: async () => undefined,
      stored: async () => null,
      drop: async ref => void runs.delete(ref),
    },
    board: {
      say: async (_, text) => void (text !== '' && said.push(text)),
      working: async () => undefined,
      want: async (ref, what) => void wanted.push(`${what} ${ref}`),
      unwant: async () => undefined,
      tell: async text => void said.push(text),
      show: async () => undefined,
      forget: async () => undefined,
    },
    agents: {
      send: async asked => {
        sent.push({ builder: asked.builder, cwd: asked.cwd })

        return { agentId: `agent-${sent.length}` }
      },
      sendBack: async () => false,
      remember: async () => undefined,
    },
    parts: {
      planFor: async () => null,
      markTask: async () => '',
      readIssue: async () => ({ error: 'none here' }),
      writeTestsFor: async () => '',
      testsFirstIn: async () => ({ state: 'none' }) as never,
      proveFor: async () => answers.proof ?? { verdict: 'settled', line: 'every changed run is pinned' },
      judgementFor: async () => answers.judgement ?? { verdict: 'pass', seats: [] },
      targetsKnown: async () => [],
      standardsText: async () => '',
      isMergedFrom: async () => false,
    },
    machine: {
      root: async () => '/proj',
      shell: () => shell,
      forge: () => ({}) as never,
      removeTree: async () => ({ ok: true, out: '' }),
      write: async () => undefined,
      treePath: (root, branch) => `${root}/.pipeline/trees/${branch}`,
    },
    clock: { now: () => 1_800_000_000_000 },
  }

  return { ports, runs, said, wanted, sent, ran }
}

describe('the build loop, on plain fakes of its ports', () => {
  test('sends a builder on an errand, proves what it built, has it judged and commits it', async () => {
    const { ports, runs, said, wanted, sent, ran } = world(errandRun())
    const ref = 'github:o/r#7'

    await sendNext(ports, ref)

    expect(sent).toEqual([{ builder: expect.any(String), cwd: TREE }])
    expect(runs.get(ref)).toMatchObject({ phase: 'building', current: { taskId: 1, agentId: 'agent-1', head: 'aaa1111' } })

    await builderEnded(ports, runs.get(ref) as Run, { answer: 'Quenched.', isAborted: false, reason: 'answer' })

    expect(runs.get(ref)?.phase).toBe('proving')
    expect(wanted).toEqual([`prove ${ref}`])

    await prove(ports, ref)

    // settled, judged, passed: committed as the task's own, and the errand is built
    expect(ran.some(line => line.startsWith('git commit -m'))).toBe(true)
    expect(runs.get(ref)).toMatchObject({ phase: 'ready', current: null, commits: [{ taskId: 1, sha: 'bbb2222' }] })
    // its one task behind it, the errand asks for its next step, which finds it built and tells the person
    expect(wanted).toEqual([`prove ${ref}`, `next ${ref}`])

    await sendNext(ports, ref)

    expect(runs.get(ref)?.phase).toBe('built')
    expect(said.at(-1)).toBe('every task of github:o/r#7 is behind it: open the pull request from the pane')
  })

  test('stops the run for the person where a builder hands the errand back', async () => {
    const { ports, runs, said, wanted } = world(errandRun())
    const ref = 'github:o/r#7'

    await sendNext(ports, ref)
    await builderEnded(ports, runs.get(ref) as Run, { answer: `Looked at it.\n${HAND_BACK} this needs a decision about the schema.`, isAborted: false, reason: 'answer' })

    expect(runs.get(ref)?.phase).toBe('stuck')
    expect(wanted).toEqual([])
    expect(said.join('\n')).toMatch(/hands github:o\/r#7 back: it is no errand\. this needs a decision about the schema\./)
  })

  test('stops where HEAD moved past the proof while the task was out', async () => {
    const { ports, runs, said } = world(errandRun({ phase: 'proving', current: { taskId: 1, title: 'Quench a beacon', builder: 'builder-cli', agentId: 'a', attempt: 1, at: 0, answer: '', head: 'ccc3333' } }))
    const ref = 'github:o/r#7'

    await prove(ports, ref)

    expect(runs.get(ref)?.phase).toBe('stuck')
    expect(said[0]).toMatch(/^HEAD moved from ccc3333 to aaa1111 while task 1 was out/)
  })
})
