import { describe, expect, test } from 'claude-code/testing'

import { afterFailedTry, afterProof, afterVerdict, isTidyAsked } from '../core/quest'
import type { Judged, ProofVerdict } from '../core/quest'

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
