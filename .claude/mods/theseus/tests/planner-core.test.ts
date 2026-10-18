import { describe, expect, test } from 'claude-code/testing'

import type { IssuePlan, Planning } from '../types'
import { adjourn, makePlan, markTask } from '../core/planner'
import type { PlannerPorts } from '../core/planner'
import type { Ran } from '../core/forge'

// The planner's course on plain fakes of its ports: no engine, no `$`

const ISSUE = { title: 'Beacons answer how long they have burned', body: 'GET /beacons/:name should say since when.', url: 'https://github.com/o/r/issues/12', state: 'OPEN', labels: [], author: 'quent', comments: [], isOutside: false }

const LAID = {
  summary: 'A lit beacon answers how long it has burned.',
  approach: 'Keep when a beacon was lit, and answer the seconds since.',
  tasks: [
    { id: 1, title: 'Keep when a beacon is lit', why: 'Nothing records it yet.', steps: ['Add lit_at'], files: ['beacons/gondor/app.py'], dependsOn: [], acceptance: 'lit_at is set on light', weight: 'light' },
    { id: 2, title: 'Answer the seconds burned', why: 'What the issue asks.', steps: ['Add burned_for'], files: ['beacons/gondor/app.py'], dependsOn: [1], acceptance: 'A test reads burned_for', weight: 'standard' },
  ],
  questions: [],
  risks: [],
}

function world() {
  const store = new Map<string, unknown>()
  const files = new Map<string, string>()
  const handed: string[] = []
  const notes: string[] = []
  const sent: { description: string; prompt: string }[] = []
  let inForce: IssuePlan | null = null
  let sitting: Planning | null = null

  const answer = (stdout: string, exitCode = 0): Ran => ({ exitCode, stdout, stderr: '' })
  const ports: PlannerPorts = {
    plans: {
      inForce: async () => inForce,
      setInForce: async made => void (inForce = made),
      kept: async ref => store.get(ref),
      keep: async made => void store.set(made.ref, made),
      forget: async ref => void store.delete(ref),
      sitting: async () => sitting,
      sit: async planning => void (sitting = planning),
    },
    board: { note: async text => void notes.push(text), select: async () => undefined, show: async () => undefined, toast: () => undefined, notify: async () => undefined, hand: async text => void handed.push(text) },
    agents: {
      send: async asked => {
        sent.push(asked)

        return { agentId: 'planner-1' }
      },
      remember: async () => undefined,
    },
    parts: { targetsKnown: async () => [], isMergedFrom: async () => false },
    machine: {
      root: async () => '/proj',
      shell: () => ({ run: async (argv: readonly string[]) => (argv.join(' ') === 'git remote get-url origin' ? answer('git@github.com:o/r.git\n') : answer('')) }),
      forge: () => ({ readIssue: async () => ISSUE }) as never,
      read: async path => files.get(path) ?? '',
      write: async (path, text) => void files.set(path, text),
    },
    clock: { now: () => 1_800_000_000_000 },
  }

  return { ports, store, files, handed, notes, sent, at: () => ({ inForce, sitting }) }
}

describe('the planner, on plain fakes of its ports', () => {
  test('sends a planner on an issue, keeps the plan it writes to its file, and hands it to the Claude that asked', async () => {
    const { ports, store, files, handed, sent, at } = world()

    const said = await makePlan(ports, '#12', 'tool', false)

    expect(said.text).toMatch(/^The planner is on github:o\/r#12, "Beacons answer how long they have burned"/)
    expect(sent[0]?.description).toBe('Plan github:o/r#12')

    const sitting = at().sitting as Planning

    // the planner writes its plan to its file, and its turn ends
    files.set(sitting.planPath ?? '', JSON.stringify(LAID))
    await adjourn(ports, sitting, 'Done.', 'answer')

    expect(at().sitting).toBeNull()
    expect(at().inForce?.tasks.map(task => task.id)).toEqual([1, 2])
    expect(store.has('github:o/r#12')).toBe(true)
    expect(handed[0]).toMatch(/^The planner has planned github:o\/r#12\. Present the plan to the person; begin no task until they say so\./)
  })

  test('marks a task of the plan in force and says what is ready next', async () => {
    const { ports, at } = world()

    await makePlan(ports, '#12', 'command', false)
    const sitting = at().sitting as Planning
    await adjourn(ports, sitting, `\`\`\`json\n${JSON.stringify(LAID)}\n\`\`\``, 'answer')

    expect(await markTask(ports, 1, 'done')).toMatch(/Ready next: 2\. Answer the seconds burned\./)
    expect(at().inForce?.tasks.find(task => task.id === 1)?.state).toBe('done')
  })
})
