import { describe, expect, test } from 'claude-code/testing'

import { eventsOf, logLines, logPathOf, parseLog, standingText } from '../core/events'
import type { Run } from '../types'

const AT = Date.UTC(2026, 9, 18, 13, 12)
const run = (given: Partial<Run> = {}): Run =>
  ({ kind: 'plan', ref: 'github:o/r#54', url: '', title: 'Beacons burn out', branch: 'build/54-beacons', base: 'main', tree: '/p/.theseus/trees/build-54', isAuto: false, phase: 'ready', current: null, proof: '', proofLine: '', verdictLine: '', commits: [], pr: '', at: AT, ...given }) as Run
const sent = { taskId: 2, title: 'Quench beacons past their watch', builder: 'builder-service', agentId: 'a', attempt: 1, at: AT, answer: '' } as Run['current']

describe("a run's events", () => {
  test('start a run, with where and how it goes', () => {
    expect(eventsOf(undefined, run({ isAuto: true }), AT, 'command')).toEqual([{ at: AT, ref: 'github:o/r#54', cause: 'command', kind: 'started', to: 'ready', text: 'Started a plan on build/54-beacons, from main, going on by itself' }])
  })

  test('are what changed: a task sent, a commit, a proof, a verdict, a wait, a pull request, a move', () => {
    const was = run({ phase: 'reviewing', current: sent, proofLine: 'settled' })
    const now = run({ phase: 'ready', current: null, proofLine: 'settled', verdictLine: 'passed', commits: [{ taskId: 2, title: 'Quench', sha: 'c7d2f10aa', by: 'Service builder', minor: [] }], heldUntil: AT + 60_000, heldWhy: 'the 5-hour quota window is at 91%', pr: 'https://github.com/o/r/pull/9' })

    expect(eventsOf(was, now, AT, 'turn').map(event => [event.kind, event.text])).toEqual([
      ['committed', 'Committed task 2 as c7d2f10: Quench'],
      ['judged', 'Reviewers: passed'],
      ['waiting', `Waiting until ${new Date(AT + 60_000).getHours().toString().padStart(2, '0')}:${new Date(AT + 60_000).getMinutes().toString().padStart(2, '0')}: the 5-hour quota window is at 91%`],
      ['opened', 'Opened https://github.com/o/r/pull/9'],
      ['moved', 'Reviewing → ready for its next task'],
    ])
    expect(eventsOf(run(), run({ phase: 'building', current: sent }), AT, 'tool').map(event => event.text)).toEqual(['Sent Service builder on task 2: Quench beacons past their watch', 'Ready for its next task → building'])
    expect(eventsOf(run({ heldUntil: AT }), run(), AT, 'clock').map(event => event.kind)).toEqual(['resumed'])
    expect(eventsOf(run(), run(), AT, 'clock')).toEqual([])
  })

  test('are kept a line each, read back past a line that does not read, and counted', () => {
    const events = eventsOf(undefined, run(), AT, 'command')

    expect(parseLog(`${logLines(events)}not json\n{"at":1}\n`)).toEqual({ events, unread: 2 })
    expect(logPathOf('/p/', 'github:o/r#54')).toBe('/p/.theseus/runs/github-o-r-54.jsonl')
  })

  test("say where a run stands, what moved it there, and its last events", () => {
    const events = [...eventsOf(undefined, run(), AT, 'command'), ...eventsOf(run(), run({ phase: 'building', current: sent }), AT + 60_000, 'press')]
    const text = standingText('github:o/r#54', 'building', events)

    expect(text.split('\n')[0]).toMatch(/^github:o\/r#54: building since \d\d:\d\d, moved there by a press on a pane\.$/)
    expect(text).toContain('Sent Service builder on task 2')
  })
})
