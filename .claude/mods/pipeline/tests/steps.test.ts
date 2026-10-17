import { describe, expect, test } from 'claude-code/testing'

import { afterFailedTry, afterGaze, afterProof, afterVerdict, afterWard, briefFor, isTidyAsked, parsePlan, runFromStore, whyNotSail } from '../core/run'
import type { Judged, Plan, ProofVerdict, Run } from '../core/run'

const proof = (over: Partial<ProofVerdict> = {}): ProofVerdict => ({ isSettled: true, isUnlooked: false, line: 'every changed run is pinned', unhandled: [], unreached: [], text: 'the proof', ...over })

const judged = (verdict: string, over: Partial<Judged> = {}): Judged => ({ verdict, blocking: [], minor: [], minorAt: [], line: verdict, ...over })

describe('a proof of a task', () => {
  test('is judged once it settles', () => {
    expect(afterProof(proof(), { taskId: 2 }, [])).toEqual({ kind: 'judge' })
  })

  test("stops the run where verify could not look, as no builder can mend that", () => {
    expect(afterProof(proof({ isSettled: false, isUnlooked: true, line: 'Verify could not look at gondor (no app)' }), { taskId: 2 }, [])).toEqual({
      kind: 'stop',
      why: 'Verify could not look at gondor (no app). No builder can mend that: set the target right in .claude/verify, then put task 2 up for verification again.',
    })
  })

  test('sends the task again with the proof where it does not settle', () => {
    expect(afterProof(proof({ isSettled: false, line: 'not pinned yet: 1 bare', text: 'narsil show 999 is bare' }), { taskId: 2 }, [])).toEqual({ kind: 'again', why: { proof: 'narsil show 999 is bare' }, line: 'not pinned yet: 1 bare' })
  })

  test('takes what was cut from the tests written first with no reason as a blocking finding', () => {
    const step = afterProof(proof(), { taskId: 2 }, [{ file: 'tests/test_gondor.py', lines: ['    assert burned == 3', '    assert lit'] }])

    expect(step).toMatchObject({ kind: 'again', line: '1 file of the tests written first changed with no reason' })
    expect(step.kind === 'again' && step.why.findings?.[0]).toMatch(/^- Tests first, tests\/test_gondor\.py: locked lines .*`assert burned == 3`, `assert lit`/)
  })

  test("commits a lane's change rebased since it passed, with the minor findings it passed with", () => {
    expect(afterProof(proof(), { taskId: 2, isRebased: true, minor: ['- Correctness reviewer: a name'] }, [])).toEqual({ kind: 'commit', minor: ['- Correctness reviewer: a name'] })
  })
})

describe("the reviewers' judgement of a task", () => {
  test('is waited on while they review, and commits a pass', () => {
    expect(afterVerdict(judged('reviewing'), { taskId: 2 }, [])).toEqual({ kind: 'wait' })
    expect(afterVerdict(judged('pass'), { taskId: 2 }, [])).toEqual({ kind: 'commit', minor: [] })
  })

  test("has the builder tidy a pass's minor findings about what it wrote, once, and commits them as they are otherwise", () => {
    const pass = judged('pass', { minor: ['- Correctness reviewer, a.py:3: a name', '- Correctness reviewer, b.py:9: elsewhere'] })

    expect(isTidyAsked(pass, {})).toBe(true)
    expect(afterVerdict(pass, { taskId: 2 }, ['- Correctness reviewer, a.py:3: a name'])).toEqual({ kind: 'tidy', minor: ['- Correctness reviewer, a.py:3: a name'], otherwise: { kind: 'commit', minor: pass.minor } })
    expect(isTidyAsked(pass, { isTidied: true })).toBe(false)
    expect(afterVerdict(pass, { taskId: 2, isTidied: true }, [])).toEqual({ kind: 'commit', minor: pass.minor })
    // None of them is about what the change wrote
    expect(afterVerdict(pass, { taskId: 2 }, [])).toEqual({ kind: 'commit', minor: pass.minor })
  })

  test('sends the task again on blocking findings, and proves it afresh where the change moved', () => {
    expect(afterVerdict(judged('fail', { blocking: ['- Security reviewer: it leaks'], line: '1 blocking finding' }), { taskId: 2 }, [])).toEqual({ kind: 'again', why: { findings: ['- Security reviewer: it leaks'] }, line: '1 blocking finding' })

    for (const verdict of ['stale', 'unsettled', 'none']) expect(afterVerdict(judged(verdict), { taskId: 2 }, [])).toEqual({ kind: 'prove' })
  })

  test('stops the run where the reviewers could not judge', () => {
    expect(afterVerdict(judged('silent', { line: 'not judged: the correctness reviewer gave no findings that read' }), { taskId: 2 }, [])).toEqual({ kind: 'stop', why: 'The reviewers could not judge task 2: not judged: the correctness reviewer gave no findings that read. Commit it once they can, or send it again.' })
  })
})

describe('a try that did not pass', () => {
  const out = { taskId: 2, attempt: 1, by: 'Light builder 1' }

  test('sends its builder back once, a fresh one a rung up after', () => {
    expect(afterFailedTry(out, 3, 'not pinned yet', '/proj/.pipeline/trees/x')).toEqual({ isSentBack: true, otherwise: { kind: 'climb', attempt: 2 } })
    expect(afterFailedTry({ ...out, isResumed: true }, 3, 'not pinned yet', '/t').isSentBack).toBe(false)
  })

  test('stops the run once the last rung tried, or the task is no longer in the work', () => {
    const last = afterFailedTry({ ...out, attempt: 3, by: 'the last builder' }, 3, '1 blocking finding', '/proj/.pipeline/trees/x')

    expect(last.otherwise).toEqual({ kind: 'stop', why: "Task 2 did not pass after 3 tries, the last the last builder's: 1 blocking finding. Finish it by hand in /proj/.pipeline/trees/x and commit it from the pane, or send it again." })
    expect(afterFailedTry(out, undefined, 'x', '/t').otherwise).toMatchObject({ kind: 'stop', why: expect.stringMatching(/^Task 2 did not pass after 1 try,/) })
  })
})

describe('a run that is submitted', () => {
  const quest = (over: Partial<Run> = {}) => ({ ref: 'github:o/r#12', kind: 'plan' as const, phase: 'built' as const, pr: '', commits: [], ...over })

  test('is submitted once every task is committed, and a review with the answers it has', () => {
    expect(whyNotSail(quest())).toBeUndefined()
    expect(whyNotSail(quest({ kind: 'review', phase: 'stuck', commits: [{ taskId: 1, title: 'T', sha: 'a', by: 'Light builder 1', minor: [] }] }))).toBeUndefined()
  })

  test("says why it does not: a lane lands by itself, it submitted already, the reviewers judge it, or it is not built", () => {
    expect(whyNotSail(quest({ lane: { of: 'github:o/r#12', taskId: 2 } }))).toBe("A lane lands on its run's branch by itself: it is github:o/r#12 that is submitted.")
    expect(whyNotSail(quest({ phase: 'submitted', pr: 'https://github.com/o/r/pull/7' }))).toBe('The pull request is open: https://github.com/o/r/pull/7')
    expect(whyNotSail(quest({ phase: 'reviewing-branch' }))).toBe('The reviewers judge the whole branch of github:o/r#12: the pull request opens once they pass it.')
    expect(whyNotSail(quest({ phase: 'building' }))).toBe('The run on github:o/r#12 is not built: it is building. Every task is committed first.')
  })

  test("waits on the reviewers' judgement of its whole branch, is submitted once they pass it, and stops on what blocks it", () => {
    const at = { ref: 'github:o/r#12', tree: '/proj/.pipeline/trees/x' }

    expect(afterWard(judged('reviewing'), at)).toMatchObject({ kind: 'wait' })
    expect(afterWard(judged('pass', { line: 'passed' }), at)).toEqual({ kind: 'submit', line: 'the whole branch passed' })
    expect(afterWard(judged('fail', { blocking: ['- Security reviewer: it leaks'], line: '1 blocking finding' }), at)).toEqual({
      kind: 'stop',
      why: 'The reviewers found what blocks the whole branch of github:o/r#12:\n- Security reviewer: it leaks\nFix it in /proj/.pipeline/trees/x and commit, then submit again: they judge the branch as it then stands.',
      line: 'the whole branch: 1 blocking finding',
    })
    expect(afterWard(judged('silent', { line: 'not judged' }), at)).toMatchObject({ kind: 'stop', why: expect.stringMatching(/could not judge the whole branch .*\(not judged\): submit again/) })
  })
})

describe("a builder's brief", () => {
  const plan = parsePlan(JSON.stringify({ ref: 'github:o/r#12', url: 'https://github.com/o/r/issues/12', title: 'Beacons burn', summary: '', approach: '', questions: [], decided: [], risks: [], accepted: [], at: 1, tasks: [{ id: 1, title: 'Keep when a beacon is lit', why: 'Nothing records it.', steps: ['Add lit_at'], files: ['beacons/gondor/app.py'], dependsOn: [], acceptance: 'lit_at is set', weight: 'light', state: 'todo' }] })) as Plan
  const quest = { kind: 'plan' as const, ref: plan.ref, url: plan.url, title: plan.title, branch: 'build/12-beacons-burn' }

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

  test('waits while the test writer writes, and is built with its tests once it has shown them', () => {
    expect(afterGaze({ state: 'gazing' }, plan, 2, plan.ref)).toEqual({ kind: 'wait' })

    const shown = afterGaze({ state: 'shown', tests: [{ file: 'beacons/tests/test_gondor.py', name: 'test_burned_for' }], unrun: [], red: '1 failed' }, plan, 2, plan.ref)

    expect(shown).toMatchObject({ kind: 'build', task: { id: 2 }, said: '', testsToPass: { taskId: 2, tests: [{ name: 'test_burned_for' }], red: '1 failed' } })
  })

  test('is built with no tests to pass, saying why, where there is nothing to test first', () => {
    expect(afterGaze({ state: 'empty', why: 'it only renames a field' }, plan, 2, plan.ref)).toMatchObject({ kind: 'build', testsToPass: null, said: 'Nothing to test first in task 2: it only renames a field' })
  })

  test('is sent again where its tests could not be read, and is lost where it left the plan', () => {
    expect(afterGaze({ state: 'unreadable', why: 'the test writer did not answer' }, plan, 2, plan.ref)).toMatchObject({ kind: 'clouded', why: 'The tests written first of task 2 could not be read: the test writer did not answer. Send it again, and the test writer writes them anew.' })
    expect(afterGaze({ state: 'shown' }, plan, 9, plan.ref)).toEqual({ kind: 'lost', why: 'The task its tests were written for is not in the plan of github:o/r#12 any more.' })
    expect(afterGaze({ state: 'shown' }, 'No plan is kept.', 2, plan.ref)).toMatchObject({ kind: 'lost' })
  })
})

describe('a run kept in the store', () => {
  const kept = { kind: 'plan', ref: 'github:o/r#12', url: '', title: 'T', branch: 'fellowship/12-t', base: 'main', tree: '/t', isAuto: false, proof: '', proofLine: '', verdictLine: '', commits: [], pr: '', at: 1 }

  test('kept before the rename, reads in its new names: phase, builder and fields', () => {
    const old = { ...kept, phase: 'marching', march: { taskId: 2, title: 'Two', member: 'gimli', agentId: 'a', attempt: 1, at: 1, answer: '' }, vision: { taskId: 2, tests: [], red: '' }, gazed: 2, isWarded: true }

    expect(runFromStore(old)).toEqual({ ...kept, phase: 'building', current: { taskId: 2, title: 'Two', builder: 'builder-service', agentId: 'a', attempt: 1, at: 1, answer: '' }, testsToPass: { taskId: 2, tests: [], red: '' }, testsFor: 2, isBranchReviewed: true })
    expect(runFromStore({ ...kept, phase: 'sailed', march: null })).toMatchObject({ phase: 'submitted', current: null })
  })

  test('kept since, reads as it was kept, and what is no run reads as none', () => {
    const run = { ...kept, phase: 'reviewing' as const, current: { taskId: 1, title: 'One', builder: 'builder-last' as const, agentId: '', attempt: 4, at: 1, answer: '' } }

    expect(runFromStore(run)).toEqual(run)
    expect(runFromStore(undefined)).toBeUndefined()
  })
})
