import { describe, expect, test } from 'claude-code/testing'

import { answered, dealt, judge, nextStep, verdictOf } from '../core/review'
import type { Judgement, ReviewerName, SendReviewer, ToJudge } from '../core/review'

const SEATS = dealt([
  { command: 'code-review', args: 'medium' },
  { command: 'security-review', args: '' },
])

const CHANGE = 'diff --git a/narsil/src/main.rs b/narsil/src/main.rs\n+fn main() {}\n\nNew files:\n'

const verdict = (findings: unknown[]) => ['I read the change.', '', '```json', JSON.stringify({ findings }), '```'].join('\n')

/** A sender that answers each reviewer an agent of its own, or refuses the ones named, and keeps what it was asked. */
const sender = (refused: readonly ReviewerName[] = []) => {
  const sent: { reviewer: ReviewerName; description: string; prompt: string; model?: string }[] = []
  const send: SendReviewer = async (reviewer, task) => {
    sent.push({ reviewer, ...task })

    return refused.includes(reviewer) ? { why: 'the session refused it' } : { agentId: `${reviewer}-${sent.length}` }
  }

  return { send, sent }
}

const asked = (over: Partial<ToJudge> = {}): ToJudge => ({
  fingerprint: 'git:abc',
  against: 'HEAD',
  by: 'tool',
  change: { text: CHANGE },
  seats: SEATS,
  told: async () => ({ about: 'Say what is missing.', proof: '- narsil: narsil show 999 (pinned)', standards: '# standards', size: '1 file, +1 −0' }),
  at: 1,
  ...over,
})

describe('a judgement', () => {
  test('sends each reviewer with its share of the reviews, the change and what it is told beside it', async () => {
    const { send, sent } = sender()
    const made = await judge(send, asked({ model: 'sonnet' }))

    expect(made.seats.map(seat => [seat.statue, seat.reviews, seat.agentId, seat.state])).toEqual([
      ['isildur', ['/code-review medium'], 'isildur-1', 'sitting'],
      ['anarion', ['/security-review'], 'anarion-2', 'sitting'],
    ])
    expect(sent[0]?.prompt).toMatch(/^Your review: \/code-review medium\.[\s\S]*<purpose>\nSay what is missing\.[\s\S]*<size>[\s\S]*<proof>[\s\S]*<standards>[\s\S]*<change>\ndiff --git/)
    expect(sent.map(one => one.model)).toEqual(['sonnet', 'sonnet'])
    expect(verdictOf(made)).toBe('sitting')
  })

  test('keeps a reviewer that could not be sent as silent, saying why', async () => {
    const made = await judge(sender(['anarion']).send, asked())

    expect(made.seats[1]).toMatchObject({ state: 'silent', agentId: '', why: 'it could not be sent: the session refused it' })
  })

  test('sends no one on a change git could not show, each seat silent saying why', async () => {
    const { send, sent } = sender()
    const made = await judge(send, asked({ change: { error: 'git could not show the change since main: bad revision' } }))

    expect(sent).toEqual([])
    expect(made.seats.map(seat => [seat.state, seat.why])).toEqual([
      ['silent', 'git could not show the change since main: bad revision'],
      ['silent', 'git could not show the change since main: bad revision'],
    ])
  })

  test('is empty where the change holds nothing, and reads nothing to tell the reviewers', async () => {
    const { send, sent } = sender()
    let isTold = false
    const made = await judge(send, asked({ change: { text: '\nNew files:\n' }, told: async () => ((isTold = true), { about: '', proof: '', standards: '', size: '' }) }))

    expect(made).toMatchObject({ isEmpty: true, seats: [] })
    expect(sent).toEqual([])
    expect(isTold).toBe(false)
  })
})

describe("a reviewer's answer", () => {
  const sitting = async (): Promise<Judgement> => judge(sender().send, asked())

  test('judges its seat: a blocking finding fails it, minor ones pass it', async () => {
    const held = await sitting()
    const failed = await answered(sender().send, held, held.seats[0]!, verdict([{ severity: 'blocking', where: 'main.rs:1', text: 'It panics.' }]), 'answer')
    const passed = await answered(sender().send, failed, failed.seats[1]!, verdict([{ severity: 'nit', where: '', text: 'A name.' }]), 'answer')

    expect(passed.seats.map(seat => seat.state)).toEqual(['fail', 'pass'])
    expect(passed.seats[1]?.findings).toEqual([{ severity: 'minor', where: '', text: 'A name.' }])
    expect(verdictOf(passed)).toBe('fail')
  })

  test('with no verdict that reads sends the reviewer once more for the verdict alone, then counts it silent', async () => {
    const held = await sitting()
    const again = sender()
    const asking = await answered(again.send, held, held.seats[0]!, 'Looks fine to me.', 'answer')

    expect(again.sent).toEqual([{ reviewer: 'isildur', description: 'Isildur gives its verdict', prompt: expect.stringContaining('Looks fine to me.') }])
    expect(asking.seats[0]).toMatchObject({ state: 'sitting', agentId: 'isildur-1', isAskedAgain: true })

    const silent = await answered(again.send, asking, asking.seats[0]!, 'Still fine.', 'answer')

    expect(again.sent).toHaveLength(1)
    expect(silent.seats[0]).toMatchObject({ state: 'silent', why: 'it gave no findings that read' })
  })

  test('is silent when the reviewer was interrupted, refused, or could not be asked again', async () => {
    const held = await sitting()

    expect((await answered(sender().send, held, held.seats[0]!, '', 'aborted')).seats[0]).toMatchObject({ state: 'silent', why: 'it was interrupted' })
    expect((await answered(sender(['isildur']).send, held, held.seats[0]!, 'No block.', 'answer')).seats[0]).toMatchObject({ state: 'silent', why: 'it gave no findings that read' })
  })
})

describe('what is left to do', () => {
  test('is fixing what blocks, saying a reviewer could not judge, tidying minor findings, or nothing', async () => {
    const held = await judge(sender().send, asked())
    const seat = (state: 'pass' | 'fail' | 'silent', findings: Judgement['seats'][number]['findings'] = []) => ({ ...held, seats: held.seats.map(one => ({ ...one, state, findings })) })

    expect(nextStep(seat('fail'))).toMatch(/^Fix what blocks/)
    expect(nextStep(seat('silent'))).toMatch(/could not judge/)
    expect(nextStep(seat('pass', [{ severity: 'minor', where: '', text: 'A name.' }]))).toMatch(/^Tidy each minor finding/)
    expect(nextStep(seat('pass'))).toBe('')
  })
})
