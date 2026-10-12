import { describe, expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { findingsOf } from '../hooks/finisher'
import { answerRepo, spec, ticket } from './repo'

type Engine = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]
type Repo = ReturnType<typeof answerRepo>

const CART = '.scratch/checkout/issues/01-cart.md'
const PAY = '.scratch/checkout/issues/02-pay.md'
const RECORD = '.scratch/checkout/run.json'
const URL = 'https://github.com/dev/repo/pull/7'

const CLEAN = 'I read the diff against the spec and the repo\'s rules. Nothing is wrong.\n\nFINDINGS: 0'
const FOUND = [
  '1. Spec — src/cart.ts:14: an empty cart is paid without an error. The spec says paying an empty cart is refused.',
  '2. Standards — src/cart.ts:30: "basket" where CONTEXT.md says Cart.',
  '',
  'FINDINGS: 2',
].join('\n')
const FIXED = '1. Fixed: paying an empty cart now throws.\n2. Fixed: renamed to cart.'

const files = () => ({
  '.scratch/checkout/spec.md': spec(['npm test']),
  [CART]: ticket('01', 'A cart holds items', ['**Blocked by:** None', '**Status:** ready']),
  [PAY]: ticket('02', 'A cart is paid', ['**Blocked by:** 01', '**Status:** ready']),
})

const ship = async ($: Engine, args: string) => (await $.command.run({ command: 'ship', args } as never)).text ?? ''

// An agent's turn ends with what it said, having left `changes` in the working tree
const ends = async ($: Engine, repo: Repo, agentId: string, { answer = 'Built.', reason = 'answer', changes = ' M src/cart.ts\n' } = {}) => {
  repo.change(changes)
  repo.ran.length = 0
  await $.turn.complete({ answer, durationMs: 1, isAborted: reason === 'aborted', turnId: 't1', agentId, reason } as never)
}

const checks = async ($: Engine, agentId: string, tool: string, input: unknown) =>
  (await $.tool.check({ tool, input, agentId, tool_use_id: 'call-1' } as never)).decision

// Both tickets are built: the reviewer, agent-3, is at work
const built = async ($: Engine, on: On, given: Partial<Parameters<typeof answerRepo>[1]> = {}) => {
  const repo = answerRepo(on, { files: files(), quota: { short: 20, weekly: 30 }, ...given })

  await ship($, 'resume')
  await ends($, repo, 'agent-1')
  repo.quota.short = 35
  await ends($, repo, 'agent-2')
  repo.logged.length = 0
  repo.notified.length = 0

  return repo
}

describe('when no ticket is left to take', () => {
  test('the branch is reviewed once, by a fresh agent on the strong model, given the spec and where it will be merged', async ($, on) => {
    const repo = await built($, on)

    expect(repo.spawned[2]).toEqual({
      subagentType: 'ship-flow:reviewer',
      description: 'Review checkout',
      model: 'opus',
      prompt:
        'Review this branch against the spec .scratch/checkout/spec.md, whose tickets are in the folder beside it. It will be merged into main.',
    })
    expect(repo.record('checkout')).toMatchObject({ phase: 'finishing', stage: 'review', base: 'main', agentId: 'agent-3' })
    expect((await ship($, 'status')).split('\n')[0]).toBe('checkout: 2 of 2 tickets done, 0 takeable now · reviewing the branch')
  })

  test('the reviewer reads and changes nothing: no edit, no verification command, no git that stages', async ($, on) => {
    await built($, on)

    expect(await checks($, 'agent-3', 'Read', { file_path: 'src/cart.ts' })).toBe('allow')
    expect(await checks($, 'agent-3', 'Bash', { command: 'git diff main...HEAD' })).toBe('allow')
    expect(await checks($, 'agent-3', 'SubagentHandback', {})).toBe('allow')
    expect(await checks($, 'agent-3', 'Edit', { file_path: 'src/cart.ts' })).toBe('deny')
    expect(await checks($, 'agent-3', 'Bash', { command: 'npm test' })).toBe('deny')
    expect(await checks($, 'agent-3', 'Bash', { command: 'git add -A' })).toBe('deny')
  })

  test('nothing is reviewed on the branch a pull request would be merged into', async ($, on) => {
    const repo = answerRepo(on, { files: files(), branch: 'main' })

    await ship($, 'resume')
    await ends($, repo, 'agent-1')
    await ends($, repo, 'agent-2')

    expect(repo.spawned).toHaveLength(2)
    expect(repo.record('checkout')).toMatchObject({
      phase: 'paused',
      pause: 'the run is on main, the branch a pull request would be merged into: none is opened',
    })
  })
})

describe('a review that finds nothing', () => {
  test('is followed by no fix pass: the branch is pushed and the pull request opened, ready for review', async ($, on) => {
    const repo = await built($, on)

    await ends($, repo, 'agent-3', { answer: CLEAN, changes: '' })

    expect(repo.spawned).toHaveLength(3)
    expect(repo.ran).toContain('git push -u origin checkout-feature')
    expect(repo.github).toMatchObject({ pr: { url: URL, isDraft: false }, title: 'checkout', base: 'main' })
    expect(repo.logged).toEqual([`checkout: the review found nothing to fix; the pull request is open: ${URL}.`])
    expect(repo.notified).toEqual([`checkout: the pull request is open: ${URL}.`])
    expect(repo.record('checkout')).toMatchObject({ phase: 'ended', pr: { url: URL, head: 'abc1235' } })
    expect((await ship($, 'status')).split('\n')[0]).toBe(
      `checkout: 2 of 2 tickets done, 0 takeable now · ended: the pull request is open: ${URL}`,
    )
  })

  test('the pull request body is the brief: each ticket and its commit, the review, the fix pass, the quota', async ($, on) => {
    const repo = await built($, on)

    await ends($, repo, 'agent-3', { answer: CLEAN, changes: '' })

    expect(repo.github.body.split('\n')).toEqual([
      '## Tickets',
      '',
      '- [x] **01 A cart holds items** (abc1234)',
      '- [x] **02 A cart is paid** (abc1235)',
      '',
      '## Review',
      '',
      'I read the diff against the spec and the repo\'s rules. Nothing is wrong.',
      '',
      'FINDINGS: 0',
      '',
      '## Fix pass',
      '',
      'The review found nothing to fix.',
      '',
      '## Quota',
      '',
      '- 5-hour window: 20% when the run started, 35% now',
      '- Weekly window: 30% when the run started, 30% now',
      '',
      'Built by ship-flow.',
    ])
  })

  test('closes the run\'s issue when every ticket is done', async ($, on) => {
    const repo = await built($, on, {
      files: { ...files(), [RECORD]: JSON.stringify({ feature: 'checkout', branch: 'checkout-feature', phase: 'paused', attempts: {}, issue: 12 }) },
    })

    await ends($, repo, 'agent-3', { answer: CLEAN, changes: '' })

    expect(repo.github.body.split('\n').slice(0, 2)).toEqual(['Closes #12', ''])
  })
})

describe('a review with findings', () => {
  test('is kept beside the spec, and one fix pass is given to a fresh implementer, with pointers to it', async ($, on) => {
    const repo = await built($, on)

    await ends($, repo, 'agent-3', { answer: FOUND, changes: '' })

    expect(repo.files['.scratch/checkout/review.md']).toBe(FOUND)
    expect(repo.spawned[3]).toMatchObject({ subagentType: 'ship-flow:implementer', description: 'Fix the review of checkout', model: 'sonnet' })
    expect(repo.spawned[3]?.prompt.split('\n')[0]).toBe(
      'Fix what the review of this branch found. The review is .scratch/checkout/review.md; the spec is .scratch/checkout/spec.md.',
    )
    expect(repo.github.pr).toBeUndefined()
    expect(repo.logged).toEqual(['checkout: the review has 2 findings; fixing them on sonnet.'])
    expect((await ship($, 'status')).split('\n')[0]).toMatch(/· fixing what the review found$/)
  })

  test('the fix pass is verified by the run and committed, then the pull request is opened with what it reported', async ($, on) => {
    const repo = await built($, on)

    await ends($, repo, 'agent-3', { answer: FOUND, changes: '' })
    await ends($, repo, 'agent-4', { answer: FIXED })

    expect(repo.ran.slice(0, 4)).toEqual(['sh -c npm test', 'git status --porcelain', 'git add -A', 'git commit -m checkout: fixes from the review'])
    expect(repo.github.pr).toEqual({ url: URL, isDraft: false })
    expect(repo.github.body).toContain(['## Fix pass', '', 'The fix pass was committed as abc1236.', '', FIXED].join('\n'))
    expect(repo.logged[1]).toBe(`checkout: the fix pass was committed as abc1236; the pull request is open: ${URL}.`)
    expect(repo.record('checkout')).toMatchObject({ phase: 'ended', pr: { head: 'abc1236' } })
  })

  test('a fix pass that breaks verification is discarded, not tried again, and the pull request says the findings stand', async ($, on) => {
    const repo = await built($, on)

    await ends($, repo, 'agent-3', { answer: FOUND, changes: '' })
    repo.exits['npm test'] = 1
    await ends($, repo, 'agent-4', { answer: FIXED })

    expect(repo.ran.slice(0, 3)).toEqual(['sh -c npm test', 'git reset --hard HEAD', 'git clean -fd'])
    expect(repo.spawned).toHaveLength(4)
    expect(repo.github.body).toContain('The fix pass was discarded: `npm test` failed. The findings above stand.')
    expect(repo.github.pr).toEqual({ url: URL, isDraft: false })
  })

  test('the fixer has the implementer\'s tools and limits', async ($, on) => {
    const repo = await built($, on)

    await ends($, repo, 'agent-3', { answer: FOUND, changes: '' })

    expect(await checks($, 'agent-4', 'Edit', { file_path: 'src/cart.ts' })).toBe('allow')
    expect(await checks($, 'agent-4', 'Bash', { command: 'npm test' })).toBe('allow')
    expect(await checks($, 'agent-4', 'Bash', { command: 'git push' })).toBe('deny')
  })
})

describe('a review that does not say how many findings it has, or does not finish', () => {
  test('gets a fix pass when it reported something without counting', async ($, on) => {
    const repo = await built($, on)

    await ends($, repo, 'agent-3', { answer: 'src/cart.ts:14 is wrong.', changes: '' })

    expect(repo.spawned).toHaveLength(4)
    expect(repo.logged).toEqual(['checkout: the review has some findings; fixing them on sonnet.'])
  })

  test('opens the pull request without a fix pass when the reviewer\'s turn was cut short, and says so', async ($, on) => {
    const repo = await built($, on)

    await ends($, repo, 'agent-3', { answer: '', reason: 'error', changes: '' })

    expect(repo.spawned).toHaveLength(3)
    expect(repo.github.body).toContain("The review did not finish: the reviewer's turn ended with error.")
    expect(repo.github.body).toContain('No fix pass was run: there was no review to act on.')
  })
})

describe('a run that could not build every ticket', () => {
  const partly = async ($: Engine, on: On) => {
    const repo = answerRepo(on, {
      files: { ...files(), '.scratch/checkout/issues/03-tax.md': ticket('03', 'Tax is added', ['**Blocked by:** None', '**Status:** ready']) },
      exits: { 'npm test': 1 },
    })

    // 01 fails twice and is blocked, with 02 that hangs off it; 03 is built
    await ship($, 'resume')
    await ends($, repo, 'agent-1')
    await ends($, repo, 'agent-2')
    repo.exits['npm test'] = 0
    await ends($, repo, 'agent-3')
    await ends($, repo, 'agent-4', { answer: CLEAN, changes: '' })

    return repo
  }

  test('opens a draft pull request that says what is missing and why, and closes no issue', async ($, on) => {
    const repo = await partly($, on)

    expect(repo.github.pr).toEqual({ url: URL, isDraft: true })
    expect(repo.github.body.split('\n').slice(0, 7)).toEqual([
      '**This run is not complete.** Some tickets could not be built; fix or split them, then `/ship resume`.',
      '',
      '## Tickets',
      '',
      '- [ ] **01 A cart holds items** — blocked: `npm test` failed',
      '- [ ] **02 A cart is paid** — blocked: hangs off a ticket that was not built',
      '- [x] **03 Tax is added** (abc1234)',
    ])
    expect(repo.github.body).not.toContain('Closes')
    expect(repo.notified.at(-1)).toBe(`checkout: a draft pull request is open: ${URL}.`)
  })

  test('goes on, on the same branch, once the person fixed the tickets: the same pull request is brought up to date and made ready', async ($, on) => {
    const repo = await partly($, on)

    repo.files[CART] = ticket('01', 'A cart holds items', ['**Blocked by:** None', '**Status:** ready'])
    repo.files[PAY] = ticket('02', 'A cart is paid', ['**Blocked by:** 01', '**Status:** ready'])
    repo.change('')
    await ship($, 'resume')
    await ends($, repo, 'agent-5')
    await ends($, repo, 'agent-6')
    await ends($, repo, 'agent-7', { answer: CLEAN, changes: '' })

    expect(repo.ran).toContain('gh pr edit checkout-feature --body-file -')
    expect(repo.ran).toContain('gh pr ready checkout-feature')
    expect(repo.ran.some(line => line.startsWith('gh pr create'))).toBe(false)
    expect(repo.github.pr).toEqual({ url: URL, isDraft: false })
    expect(repo.github.body.split('\n').slice(0, 5)).toEqual([
      '## Tickets',
      '',
      '- [x] **01 A cart holds items** (abc1235)',
      '- [x] **02 A cart is paid** (abc1236)',
      '- [x] **03 Tax is added** (abc1234)',
    ])
    expect(repo.logged.at(-1)).toBe(`checkout: the review found nothing to fix; the pull request is up to date: ${URL}.`)
  })
})

describe('at the end of a run', () => {
  test('/ship resume does not review again a branch whose pull request already holds everything', async ($, on) => {
    const repo = await built($, on)

    await ends($, repo, 'agent-3', { answer: CLEAN, changes: '' })

    expect(await ship($, 'resume')).toBe(
      `checkout: no ticket left to take: 2 of 2 done; nothing new since the pull request: ${URL}.`,
    )
    expect(repo.spawned).toHaveLength(3)
  })

  test('a push that fails stops the run with what git said, and no pull request is opened', async ($, on) => {
    const repo = await built($, on)

    repo.github.failsToPush = true
    await ends($, repo, 'agent-3', { answer: CLEAN, changes: '' })

    expect(repo.github.pr).toBeUndefined()
    expect(repo.record('checkout')).toMatchObject({ phase: 'paused', pause: 'the push failed: remote: Permission denied' })
    expect(repo.notified).toEqual(['checkout: the push failed: remote: Permission denied.'])
  })

  test('a pull request that cannot be opened stops the run with what GitHub said', async ($, on) => {
    const repo = await built($, on)

    repo.github.failsToOpen = true
    await ends($, repo, 'agent-3', { answer: CLEAN, changes: '' })

    expect(repo.record('checkout')).toMatchObject({
      phase: 'paused',
      pause: 'the pull request could not be opened: GraphQL: not authorized',
    })
  })

  test('a run cut off during the review reviews again when resumed', async ($, on) => {
    const repo = await built($, on)

    repo.files[RECORD] = JSON.stringify({ ...repo.record('checkout'), agentId: 'gone' })
    expect(await ship($, 'resume')).toBe('checkout: no ticket left to take: 2 of 2 done; reviewing the branch on opus.')
    expect(repo.spawned).toHaveLength(4)
  })
})

test('the number of findings is read from the review\'s last line, however it is dressed', () => {
  expect(findingsOf('Nothing.\n\nFINDINGS: 0')).toBe(0)
  expect(findingsOf('1. Wrong.\n\n**FINDINGS: 3**\n')).toBe(3)
  expect(findingsOf('findings: 12')).toBe(12)
  expect(findingsOf('There are two findings.')).toBeUndefined()
})
