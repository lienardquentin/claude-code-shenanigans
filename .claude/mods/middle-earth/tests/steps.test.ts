import { describe, expect, test } from 'claude-code/testing'

import { afterFailedTry, afterGaze, afterProof, afterVerdict, afterWard, briefFor, isTidyAsked, parsePlan, whyNotSail } from '../core/quest'
import type { Judged, Plan, ProofVerdict, Quest } from '../core/quest'

const proof = (over: Partial<ProofVerdict> = {}): ProofVerdict => ({ isSettled: true, isUnlooked: false, line: 'every changed run is pinned', unhandled: [], unreached: [], text: 'the proof', ...over })

const judged = (verdict: string, over: Partial<Judged> = {}): Judged => ({ verdict, blocking: [], minor: [], minorAt: [], line: verdict, ...over })

describe('a proof of a task', () => {
  test('is judged once it settles', () => {
    expect(afterProof(proof(), { taskId: 2 }, [])).toEqual({ kind: 'judge' })
  })

  test("stops the quest where the Argonath could not look, as no builder can mend that", () => {
    expect(afterProof(proof({ isSettled: false, isUnlooked: true, line: 'Argonath could not look at gondor (no app)' }), { taskId: 2 }, [])).toEqual({
      kind: 'stop',
      why: 'Argonath could not look at gondor (no app). No member can mend that: set the target right in .claude/argonath, then put task 2 before the Argonath again.',
    })
  })

  test('sends the task again with the proof where it does not settle', () => {
    expect(afterProof(proof({ isSettled: false, line: 'not pinned yet: 1 bare', text: 'narsil show 999 is bare' }), { taskId: 2 }, [])).toEqual({ kind: 'again', why: { proof: 'narsil show 999 is bare' }, line: 'not pinned yet: 1 bare' })
  })

  test('takes what was cut from the tests written first with no reason as a blocking finding', () => {
    const step = afterProof(proof(), { taskId: 2 }, [{ file: 'tests/test_gondor.py', lines: ['    assert burned == 3', '    assert lit'] }])

    expect(step).toMatchObject({ kind: 'again', line: "1 of Galadriel's test file changed with no reason" })
    expect(step.kind === 'again' && step.why.findings?.[0]).toMatch(/^- Lothlórien, tests\/test_gondor\.py: locked lines .*`assert burned == 3`, `assert lit`/)
  })

  test("commits a lane's change rebased since it passed, with the minor findings it passed with", () => {
    expect(afterProof(proof(), { taskId: 2, isRebased: true, minor: ['- Isildur: a name'] }, [])).toEqual({ kind: 'commit', minor: ['- Isildur: a name'] })
  })
})

describe("the reviewers' judgement of a task", () => {
  test('is waited on while they sit, and commits a pass', () => {
    expect(afterVerdict(judged('sitting'), { taskId: 2 }, [])).toEqual({ kind: 'wait' })
    expect(afterVerdict(judged('pass'), { taskId: 2 }, [])).toEqual({ kind: 'commit', minor: [] })
  })

  test("has the builder tidy a pass's minor findings about what it wrote, once, and commits them as they are otherwise", () => {
    const pass = judged('pass', { minor: ['- Isildur, a.py:3: a name', '- Isildur, b.py:9: elsewhere'] })

    expect(isTidyAsked(pass, {})).toBe(true)
    expect(afterVerdict(pass, { taskId: 2 }, ['- Isildur, a.py:3: a name'])).toEqual({ kind: 'tidy', minor: ['- Isildur, a.py:3: a name'], otherwise: { kind: 'commit', minor: pass.minor } })
    expect(isTidyAsked(pass, { isTidied: true })).toBe(false)
    expect(afterVerdict(pass, { taskId: 2, isTidied: true }, [])).toEqual({ kind: 'commit', minor: pass.minor })
    // None of them is about what the change wrote
    expect(afterVerdict(pass, { taskId: 2 }, [])).toEqual({ kind: 'commit', minor: pass.minor })
  })

  test('sends the task again on blocking findings, and proves it afresh where the change moved', () => {
    expect(afterVerdict(judged('fail', { blocking: ['- Anárion: it leaks'], line: '1 blocking finding' }), { taskId: 2 }, [])).toEqual({ kind: 'again', why: { findings: ['- Anárion: it leaks'] }, line: '1 blocking finding' })

    for (const verdict of ['stale', 'unsettled', 'none']) expect(afterVerdict(judged(verdict), { taskId: 2 }, [])).toEqual({ kind: 'prove' })
  })

  test('stops the quest where the reviewers could not judge', () => {
    expect(afterVerdict(judged('silent', { line: 'not judged: Isildur gave no findings that read' }), { taskId: 2 }, [])).toEqual({ kind: 'stop', why: 'The statues could not judge task 2: not judged: Isildur gave no findings that read. Commit it once they can, or send it again.' })
  })
})

describe('a try that did not pass', () => {
  const out = { taskId: 2, attempt: 1, by: 'Frodo' }

  test('sends its builder back once, a fresh one a rung up after', () => {
    expect(afterFailedTry(out, 3, 'not pinned yet', '/proj/.fellowship/trees/x')).toEqual({ isSentBack: true, otherwise: { kind: 'climb', attempt: 2 } })
    expect(afterFailedTry({ ...out, isResumed: true }, 3, 'not pinned yet', '/t').isSentBack).toBe(false)
  })

  test('stops the quest once the last rung tried, or the task is no longer in the work', () => {
    const last = afterFailedTry({ ...out, attempt: 3, by: 'Gandalf' }, 3, '1 blocking finding', '/proj/.fellowship/trees/x')

    expect(last.otherwise).toEqual({ kind: 'stop', why: "Task 2 did not pass after 3 tries, the last Gandalf's: 1 blocking finding. Finish it by hand in /proj/.fellowship/trees/x and commit it from the pane, or send it again." })
    expect(afterFailedTry(out, undefined, 'x', '/t').otherwise).toMatchObject({ kind: 'stop', why: expect.stringMatching(/^Task 2 did not pass after 1 try,/) })
  })
})

describe('a quest that sails', () => {
  const quest = (over: Partial<Quest> = {}) => ({ ref: 'github:o/r#12', kind: 'plan' as const, phase: 'arrived' as const, pr: '', commits: [], ...over })

  test('sails once every task is committed, and a review with the answers it has', () => {
    expect(whyNotSail(quest())).toBeUndefined()
    expect(whyNotSail(quest({ kind: 'review', phase: 'stuck', commits: [{ taskId: 1, title: 'T', sha: 'a', by: 'Frodo', minor: [] }] }))).toBeUndefined()
  })

  test("says why it does not: a lane lands by itself, it sailed already, the reviewers judge it, or it has not arrived", () => {
    expect(whyNotSail(quest({ lane: { of: 'github:o/r#12', taskId: 2 } }))).toBe("A lane lands on its quest's branch by itself: it is github:o/r#12 that sails.")
    expect(whyNotSail(quest({ phase: 'sailed', pr: 'https://github.com/o/r/pull/7' }))).toBe('The pull request is open: https://github.com/o/r/pull/7')
    expect(whyNotSail(quest({ phase: 'warding' }))).toBe('The statues judge the whole branch of github:o/r#12: the pull request opens once they pass it.')
    expect(whyNotSail(quest({ phase: 'marching' }))).toBe('The quest on github:o/r#12 has not arrived: it is marching. Every task is committed first.')
  })

  test("waits on the reviewers' judgement of its whole branch, sails once they pass it, and stops on what blocks it", () => {
    const at = { ref: 'github:o/r#12', tree: '/proj/.fellowship/trees/x' }

    expect(afterWard(judged('sitting'), at)).toMatchObject({ kind: 'wait' })
    expect(afterWard(judged('pass', { line: 'passed' }), at)).toEqual({ kind: 'sail', line: 'the whole branch passed' })
    expect(afterWard(judged('fail', { blocking: ['- Anárion: it leaks'], line: '1 blocking finding' }), at)).toEqual({
      kind: 'stop',
      why: 'The statues found what blocks the whole branch of github:o/r#12:\n- Anárion: it leaks\nFix it in /proj/.fellowship/trees/x and commit, then sail again: they judge the branch as it then stands.',
      line: 'the whole branch: 1 blocking finding',
    })
    expect(afterWard(judged('silent', { line: 'not judged' }), at)).toMatchObject({ kind: 'stop', why: expect.stringMatching(/could not judge the whole branch .*\(not judged\): sail again/) })
  })
})

describe("a builder's brief", () => {
  const plan = parsePlan(JSON.stringify({ ref: 'github:o/r#12', url: 'https://github.com/o/r/issues/12', title: 'Beacons burn', summary: '', approach: '', questions: [], decided: [], risks: [], accepted: [], at: 1, tasks: [{ id: 1, title: 'Keep when a beacon is lit', why: 'Nothing records it.', steps: ['Add lit_at'], files: ['beacons/gondor/app.py'], dependsOn: [], acceptance: 'lit_at is set', weight: 'light', state: 'todo' }] })) as Plan
  const quest = { kind: 'plan' as const, ref: plan.ref, url: plan.url, title: plan.title, branch: 'fellowship/12-beacons-burn' }

  test('names the builder its try and the task call for, a rung up on each try', () => {
    const first = briefFor({ quest, plan, task: plan.tasks[0]!, attempt: 1, targets: [], standards: '' })
    const second = briefFor({ quest, plan, task: plan.tasks[0]!, attempt: 2, targets: [], standards: '' })

    expect(first.description).toMatch(/: task 1, Keep when a beacon is lit$/)
    expect(first.builder).not.toBe(second.builder)
    expect(first.prompt).toContain('Keep when a beacon is lit')
  })
})

describe('a task whose tests were written first', () => {
  const plan = parsePlan(JSON.stringify({ ref: 'github:o/r#12', url: '', title: 'T', summary: '', approach: '', questions: [], decided: [], risks: [], accepted: [], at: 1, tasks: [{ id: 2, title: 'Answer the seconds burned', why: '', steps: [], files: [], dependsOn: [], acceptance: '', weight: 'standard', state: 'todo' }] })) as Plan

  test('waits while she gazes, and is built with her tests once she has shown them', () => {
    expect(afterGaze({ state: 'gazing' }, plan, 2, plan.ref)).toEqual({ kind: 'wait' })

    const shown = afterGaze({ state: 'shown', tests: [{ file: 'beacons/tests/test_gondor.py', name: 'test_burned_for' }], unrun: [], red: '1 failed' }, plan, 2, plan.ref)

    expect(shown).toMatchObject({ kind: 'build', task: { id: 2 }, said: '', vision: { taskId: 2, tests: [{ name: 'test_burned_for' }], red: '1 failed' } })
  })

  test('is built with no tests to pass, saying why, where there is nothing to test first', () => {
    expect(afterGaze({ state: 'empty', why: 'it only renames a field' }, plan, 2, plan.ref)).toMatchObject({ kind: 'build', vision: null, said: 'Nothing to test first in task 2: it only renames a field' })
  })

  test('is sent again where her tests could not be read, and is lost where it left the plan', () => {
    expect(afterGaze({ state: 'unreadable', why: 'the Mirror did not answer' }, plan, 2, plan.ref)).toMatchObject({ kind: 'clouded', why: 'The Mirror is clouded on task 2: the Mirror did not answer. Send it again, and Galadriel gazes anew.' })
    expect(afterGaze({ state: 'shown' }, plan, 9, plan.ref)).toEqual({ kind: 'lost', why: 'The task the Mirror showed is not in the plan of github:o/r#12 any more.' })
    expect(afterGaze({ state: 'shown' }, 'No plan is kept.', 2, plan.ref)).toMatchObject({ kind: 'lost' })
  })
})
