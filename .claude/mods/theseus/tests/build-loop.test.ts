import { describe, expect, test } from 'claude-code/testing'

import type { IssuePlan, Run, RunTask } from '../types'
import { settledAlone } from '../core/plan'
import { prBody, parsePlan } from '../core/run'
import { builderEnded, measure, prove, sendNext, wakeHeld } from '../core/build'
import { holdOf } from '../core/budget'
import { refusalOf } from '../hooks/agents'
import type { Ports } from '../core/build'
import { HAND_BACK } from '../core/run'
import { canMove } from '../core/phases'
import type { Ran } from '../core/forge'
import type { Quota } from '../core/budget'
import type { TargetFolders } from '../core/run'
import { errand, setOut } from '../core/build'
import { verificationOf, setupOf } from '../core/verification'

// The build's loop on plain fakes of its ports: no engine, no `$`, only what each port was asked and answered

const TREE = '/proj/.theseus/trees/errand-7-quench'

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
function world(run: Run, answers: { proof?: unknown; judgement?: unknown; quota?: Quota; targets?: TargetFolders[]; issue?: unknown; failing?: string; plan?: IssuePlan } = {}) {
  let plan = answers.plan ?? null
  const runs = new Map<string, Run>([[run.ref, run]])
  const said: string[] = []
  const wanted: string[] = []
  const sent: { builder: string; cwd: string }[] = []
  const ran: string[] = []
  let head = 'aaa1111'
  let quota: Quota | undefined = answers.quota
  let now = 1_800_000_000_000
  const stopped: string[] = []

  const answer = (stdout: string, exitCode = 0): Ran => ({ exitCode, stdout, stderr: '' })
  const shell = {
    run: async (argv: readonly string[]): Promise<Ran> => {
      const line = argv.join(' ')

      ran.push(line)
      if (answers.failing !== undefined && line === `sh -c ${answers.failing}`) return { exitCode: 1, stdout: '', stderr: 'E   assert 3 == 2\n1 failed' }
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
      stop: async (agentId, why) => void stopped.push(`${agentId}: ${why}`),
    },
    parts: {
      planFor: async () => plan,
      markTask: async () => '',
      readIssue: async () => (answers.issue ?? { error: 'none here' }) as never,
      writeTestsFor: async () => '',
      testsFirstIn: async () => ({ state: 'none' }) as never,
      proveFor: async () => answers.proof ?? { verdict: 'settled', line: 'every changed run is pinned' },
      judgementFor: async () => answers.judgement ?? { verdict: 'pass', seats: [] },
      targetsKnown: async () => answers.targets ?? [{ label: 'gondor', kind: 'service', roots: ['beacons/gondor'] }],
      standardsText: async () => '',
      isMergedFrom: async () => false,
      spentOn: async () => 'Spent: 4 turns, 3 min, 120k tokens in (90k cached), 8k out.',
      settleAlone: async () => {
        plan = plan === null ? null : settledAlone(plan)

        return plan
      },
    },
    machine: {
      root: async () => '/proj',
      shell: () => shell,
      forge: () => ({}) as never,
      removeTree: async () => ({ ok: true, out: '' }),
      write: async () => undefined,
      treePath: (root, branch) => `${root}/.theseus/trees/${branch}`,
    },
    clock: { now: () => now, quota: async () => quota },
  }

  return { ports, runs, said, wanted, sent, ran, stopped, setQuota: (next: Quota | undefined) => void (quota = next), setNow: (at: number) => void (now = at) }
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

  test("waits while the 5-hour quota window is past its threshold, and goes on by itself once it has reset", async () => {
    const at = 1_800_000_000_000
    const resetsAt = new Date(at + 3_600_000).toISOString()
    const { ports, runs, said, wanted, sent, setQuota, setNow } = world(errandRun(), { quota: { at, windows: [{ kind: 'five_hour', percentUsed: 95, resetsAt }] } })
    const ref = 'github:o/r#7'

    await sendNext(ports, ref)

    expect(sent).toEqual([])
    expect(runs.get(ref)).toMatchObject({ phase: 'ready', heldUntil: at + 3_600_000 + 60_000 })
    expect(said[0]).toMatch(/^Task 1 waits: the 5-hour quota window is at 95% \(the run waits from 90%\)\. The run goes on by itself at \d\d:\d\d\.$/)

    // not yet
    await wakeHeld(ports)
    expect(wanted).toEqual([])

    // the window reset: the run is asked for its next task, and sends it
    setNow(at + 3_600_000 + 60_000)
    setQuota({ at: at + 3_600_000 + 60_000, windows: [{ kind: 'five_hour', percentUsed: 3 }] })
    await wakeHeld(ports)
    expect(wanted).toEqual([`next ${ref}`])
    expect(runs.get(ref)?.heldUntil).toBeUndefined()

    await sendNext(ports, ref)
    expect(sent).toHaveLength(1)
  })

  test('stops for the person where the weekly window is past its threshold, as waiting hours does not help it', async () => {
    const { ports, runs, said, sent } = world(errandRun(), { quota: { at: 0, windows: [{ kind: 'seven_day', percentUsed: 92 }, { kind: 'five_hour', percentUsed: 10 }] } })

    await sendNext(ports, 'github:o/r#7')

    expect(sent).toEqual([])
    expect(runs.get('github:o/r#7')?.phase).toBe('stuck')
    expect(said[0]).toMatch(/^Task 1 does not start: the weekly quota window is at 92%/)
  })

  test('stops a builder past its context budget, and says its task is too large once its turn ends', async () => {
    const { ports, runs, said, stopped } = world(errandRun())
    const ref = 'github:o/r#7'

    await sendNext(ports, ref)
    // 60% of the window: under the default 70%
    await measure(ports, runs.get(ref) as Run, 'agent-1', 120_000)
    expect(stopped).toEqual([])

    await measure(ports, runs.get(ref) as Run, 'agent-1', 150_000)
    expect(stopped).toEqual(['agent-1: This task has outgrown its context budget (75% of a context window) and is stopped.'])
    expect(runs.get(ref)?.current?.tooLarge).toBe(150_000)

    await builderEnded(ports, runs.get(ref) as Run, { answer: 'Stopped.', isAborted: false, reason: 'answer' })

    expect(runs.get(ref)?.phase).toBe('stuck')
    expect(said.at(-1)).toMatch(/^github:o\/r#7 is stuck: Task 1 was stopped at 75% of a context window: it is too large for one builder\. Split it into smaller issues/)
  })
})

describe('the quota', () => {
  test('holds no task where no window was read or every window is under its threshold', () => {
    expect(holdOf(undefined, { fiveHourPercent: 90, weeklyPercent: 90, contextPercent: 70 })).toBeUndefined()
    expect(holdOf({ at: 0, windows: [{ kind: 'five_hour', percentUsed: 89 }, { kind: 'seven_day', percentUsed: 50 }] }, { fiveHourPercent: 90, weeklyPercent: 90, contextPercent: 70 })).toBeUndefined()
  })

  test('looks again in half an hour where the 5-hour window does not say when it resets', () => {
    expect(holdOf({ at: 1000, windows: [{ kind: 'five_hour', percentUsed: 91 }] }, { fiveHourPercent: 90, weeklyPercent: 90, contextPercent: 70 })?.until).toBe(1000 + 30 * 60 * 1000)
  })
})

describe('a builder stopped past its budget', () => {
  test('is refused whatever it calls, and told to end its turn', () => {
    const why = refusalOf({ role: 'builder', root: '/proj', tree: TREE, stopped: 'This task has outgrown its context budget.' }, { tool: 'Read', file_path: `${TREE}/a.py` })

    expect(why).toBe('This task has outgrown its context budget. Call no more tools: end your turn now, saying what you built so far.')
  })
})

describe('a project that names no target', () => {
  const ISSUE = (body: string) => ({ ref: 'github:o/r#7', title: 'Quench', body, url: 'https://github.com/o/r/issues/7', state: 'OPEN', labels: [], author: 'quent', comments: [], isOutside: false })

  test("reads the commands of an issue's Verification and Setup sections, a line each", () => {
    const body = ['Quench a beacon.', '', '## Setup', '', '```sh', 'uv sync', '```', '', '## Verification', '', '- `uv run pytest -q`', '- uv run ruff check', '', '## Notes', 'later'].join('\n')

    expect(verificationOf(body)).toEqual(['uv run pytest -q', 'uv run ruff check'])
    expect(setupOf(body)).toEqual(['uv sync'])
    expect(verificationOf('no sections')).toEqual([])
  })

  test('does not start an errand whose issue states no verification command, saying how to give it one', async () => {
    const { ports, runs } = world(errandRun(), { targets: [], issue: ISSUE('Quench a beacon.') })

    runs.clear()
    expect(await errand(ports, '#7', false, true)).toMatch(/^github:o\/r#7 is not started: the project names no target in \.claude\/theseus\.toml, and the issue states no verification command.*Add a `## Verification` section/)
    expect(runs.size).toBe(0)
  })

  test('proves a task by the verification commands, sets up a fresh worktree, and sends a failing one back', async () => {
    const body = ['## Setup', 'uv sync', '## Verification', 'uv run pytest -q'].join('\n')
    const passing = world(errandRun(), { targets: [], issue: ISSUE(body) })

    passing.runs.clear()
    expect(await errand(passing.ports, '#7', false, true)).toMatch(/^The build starts on github:o\/r#7/)
    expect(passing.ran).toContain('sh -c uv sync')

    const ref = 'github:o/r#7'

    expect(passing.runs.get(ref)).toMatchObject({ checks: ['uv run pytest -q'], setup: ['uv sync'] })
    await sendNext(passing.ports, ref)
    await builderEnded(passing.ports, passing.runs.get(ref) as Run, { answer: 'Quenched.', isAborted: false, reason: 'answer' })
    await prove(passing.ports, ref)

    expect(passing.ran).toContain('sh -c uv run pytest -q')
    expect(passing.runs.get(ref)).toMatchObject({ commits: [{ taskId: 1, sha: 'bbb2222', proof: 'the 1 verification command passes' }] })

    // the same command failing sends the task up a rung, with what it wrote
    const failing = world(errandRun({ checks: ['uv run pytest -q'] }), { targets: [], failing: 'uv run pytest -q' })

    await sendNext(failing.ports, ref)
    await builderEnded(failing.ports, failing.runs.get(ref) as Run, { answer: 'Quenched.', isAborted: false, reason: 'answer' })
    await prove(failing.ports, ref)

    expect(failing.runs.get(ref)?.proofLine).toBe('`uv run pytest -q` fails (exit 1)')
    expect(failing.runs.get(ref)?.proof).toMatch(/assert 3 == 2/)
    expect(failing.sent).toHaveLength(2)
  })
})

describe('an auto run on a plan left open', () => {
  const PLAN: IssuePlan = {
    ref: 'github:o/r#7',
    url: 'https://github.com/o/r/issues/7',
    title: 'Quench',
    summary: 'Quench a beacon.',
    approach: 'One route.',
    tasks: [{ ...TASK, dependsOn: [], weight: 'standard', state: 'todo' as const }],
    questions: [{ text: 'Is an unlit beacon 0 or null?', options: ['null', '0'], answer: '' }],
    decided: [],
    risks: [{ text: 'A beacon quenched twice', severity: 'low', mitigation: '', tasks: [1], wantsTask: false }],
    accepted: [],
    at: 0,
  }

  test("answers the planner's questions and accepts its risks alone, and lists each", () => {
    const settled = settledAlone(PLAN)

    expect(settled.questions[0]?.answer).toBe('null')
    expect(settled.risks).toEqual([])
    expect(settled.accepted).toEqual(['A beacon quenched twice'])
    expect(settled.alone).toEqual(["Is an unlit beacon 0 or null? → null (the planner's recommended answer)", 'Accepted as it is (low): A beacon quenched twice'])
  })

  test('is not started unless auto, and lists what it decided in the pull request', async () => {
    const stepwise = world(errandRun(), { plan: PLAN })

    stepwise.runs.clear()
    expect(await setOut(stepwise.ports, false, PLAN.ref)).toMatch(/is not settled: 1 unanswered question; 1 undecided risk .*, or start it auto to have it settle them alone\.$/)

    const auto = world(errandRun(), { plan: PLAN })

    auto.runs.clear()
    expect(await setOut(auto.ports, true, PLAN.ref)).toMatch(/^The build starts on github:o\/r#7.* It settled alone what the plan left open \(1 unanswered question; 1 undecided risk/)

    const made = parsePlan(settledAlone(PLAN))

    expect(typeof made === 'object' && made !== null && prBody({ kind: 'plan', ref: PLAN.ref, commits: [] }, made)).toMatch(/## Decided without the person\n\nThis run went on by itself: what it decided that the person was not asked, for them to check\.\n\n- Is an unlit beacon 0 or null\? → null/)
  })
})

describe('the pull request a plan opens', () => {
  test('says of each task how long it took, what it changed beyond its files and left unticked, what was not built, and what the run spent', () => {
    const plan = parsePlan({ ref: 'github:o/r#7', url: 'u', title: 'Quench', summary: 'S.', approach: 'A.', tasks: [{ ...TASK, state: 'done' }, { ...TASK, id: 2, title: 'A question', state: 'asked', note: 'which unit?' }] })
    const body = typeof plan === 'object' && plan !== null ? prBody({ kind: 'plan', ref: 'github:o/r#7', commits: [{ taskId: 1, title: 'Quench a beacon', sha: 'abcdef1234', by: 'CLI builder', minor: [], took: 240_000, outside: ['README.md'], unticked: ['the docs'] }] }, plan, 'Spent: 4 turns.') : ''

    expect(body).toMatch(/- abcdef1 1\. Quench a beacon \(CLI builder, 4 min\)\n  - changed beyond its files: README\.md\n  - left unticked: the docs/)
    expect(body).toMatch(/## Not built\n\n- 2\. A question: handed back, which unit\?/)
    expect(body).toMatch(/## Spent\n\nSpent: 4 turns\./)
  })
})

