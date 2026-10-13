import { describe, expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { answerRepo, spec, ticket } from './repo'

type Engine = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]
type Repo = ReturnType<typeof answerRepo>

const ORIGIN = 'git@gitlab.com:dev/repo.git'
const CART = '.scratch/checkout/issues/01-cart.md'
const PAY = '.scratch/checkout/issues/02-pay.md'
const URL = 'https://gitlab.com/dev/repo/-/merge_requests/7'
const FINISH = '/home/dev/repo/.scratch/checkout/trees/finish'
const IDEA = 'Let a cart be paid by card'
const FOLDER = '.scratch/let-a-cart-be-paid-by-card'
const ISSUES = { 12: { title: 'Pay a cart by card', body: 'Customers cannot pay.', labels: ['ready-for-agent'] } }
const CLEAN = 'Nothing is wrong.\n\nFINDINGS: 0'

const files = () => ({
  '.scratch/checkout/spec.md': spec(['npm test']),
  [CART]: ticket('01', 'A cart holds items', ['**Blocked by:** None', '**Status:** ready']),
  [PAY]: ticket('02', 'A cart is paid', ['**Blocked by:** 01', '**Status:** ready']),
})

let current: Repo | undefined

const repoOf = (...given: Parameters<typeof answerRepo>): Repo => {
  current = answerRepo(...given)

  return current
}

const ship = async ($: Engine, args: string) => {
  const { text = '' } = await $.command.run({ command: 'ship', args } as never)

  await current?.clock.settle()

  return text
}

// An agent's turn ends with what it said, having left `changes` in the working tree
const ends = async ($: Engine, repo: Repo, agentId: string, { answer = 'Built.', changes = ' M src/cart.ts\n' } = {}) => {
  repo.change(changes)
  repo.ran.length = 0
  await $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId: 't1', agentId, reason: 'answer' } as never)
}

// Both tickets are built and the review found nothing: the merge request is open
const opened = async ($: Engine, on: On, given: Partial<Parameters<typeof answerRepo>[1]> = {}) => {
  const repo = repoOf(on, { files: files(), quota: { short: 20, weekly: 30 }, origin: ORIGIN, ...given })

  await ship($, 'resume')
  await ends($, repo, 'agent-1')
  await ends($, repo, 'agent-2')
  await ends($, repo, 'agent-3', { answer: CLEAN, changes: '' })

  return repo
}

const glab = (repo: Repo) => repo.ran.filter(line => line.startsWith('glab '))

describe('a run in a repo on GitLab', () => {
  test('begins from an issue read through glab, and is kept as a run on GitLab', async ($, on) => {
    const repo = repoOf(on, { files: {}, branch: 'main', issues: ISSUES, origin: ORIGIN })

    expect(await ship($, '#12')).toBe('pay-a-cart-by-card: started from issue #12, which is already agreed: the spec comes next.')
    expect(glab(repo)).toEqual(['glab issue view 12 --output json'])
    expect(repo.ran.some(line => line.startsWith('gh '))).toBe(false)
    expect(repo.record('pay-a-cart-by-card')).toMatchObject({ forge: 'gitlab', source: 'issue', issue: 12, title: 'Pay a cart by card' })
    expect(repo.prompts[0]).toContain('Source: GitLab issue #12, "Pay a cart by card", below.')
    expect(repo.prompts[0]).toContain('Publish nothing to GitLab: the run opens the issue and the merge request itself.')
    expect(repo.prompts[0]?.endsWith('# Pay a cart by card\n\nCustomers cannot pay.')).toBe(true)
  })

  test('says so when the issue cannot be read, and begins nothing', async ($, on) => {
    const repo = repoOf(on, { files: {}, branch: 'main', origin: ORIGIN })

    expect(await ship($, '#99')).toBe('Issue #99 could not be read: ERROR: 404 Not Found')
    expect(repo.prompts).toEqual([])
  })

  test('approved, opens its one issue through glab, the spec handed over on stdin', async ($, on) => {
    const repo = repoOf(on, { files: {}, branch: 'main', origin: 'https://gitlab.com/dev/repo.git' })

    await ship($, IDEA)
    repo.files[`${FOLDER}/spec.md`] = spec(['npm test']).replace('# Spec', '# Spec: Pay a cart by card')
    repo.files[`${FOLDER}/issues/01-cart.md`] = ticket('01', 'A cart holds items', ['**Blocked by:** None', '**Status:** ready'])
    await ship($, 'resume')

    expect(repo.ran).toContain('glab issue create --title Pay a cart by card --description-file - --yes')
    expect(repo.gitlab.issues).toEqual([{ title: 'Pay a cart by card', body: '## Solution\n\nSomething.\n\n## Verification\n\n```\nnpm test\n```\n' }])
    expect(repo.github.issues).toEqual([])
    expect(repo.record('let-a-cart-be-paid-by-card')).toMatchObject({ forge: 'gitlab', issue: 31, title: 'Pay a cart by card', phase: 'unattended' })
  })

  test('an issue GitLab refuses stops the approval with what glab said', async ($, on) => {
    const repo = repoOf(on, { files: {}, branch: 'main', origin: ORIGIN })

    await ship($, IDEA)
    repo.files[`${FOLDER}/spec.md`] = spec(['npm test']).replace('# Spec', '# Spec: Pay a cart by card')
    repo.files[`${FOLDER}/issues/01-cart.md`] = ticket('01', 'A cart holds items', ['**Blocked by:** None', '**Status:** ready'])
    repo.gitlab.failsToOpen = true

    expect(await ship($, 'resume')).toBe('let-a-cart-be-paid-by-card: cannot start: the issue could not be opened: ERROR: 401 Unauthorized.')
  })

  test('ends in a merge request opened through glab, its body the brief, and says merge request', async ($, on) => {
    const repo = await opened($, on)

    expect(glab(repo)).toEqual([
      'glab mr view checkout-feature --output json',
      'glab mr create --source-branch checkout-feature --target-branch main --title checkout --description-file - --yes',
    ])
    expect(repo.ran.some(line => line.startsWith('gh '))).toBe(false)
    expect(repo.gitlab.mr).toMatchObject({ web_url: URL, draft: false })
    expect(repo.gitlab.base).toBe('main')
    expect(repo.gitlab.body.split('\n').slice(0, 4)).toEqual(['## Tickets', '', '- [x] **01 A cart holds items** (abc1234)', '- [x] **02 A cart is paid** (abc1235)'])
    expect(repo.record('checkout')).toMatchObject({ forge: 'gitlab', phase: 'ended', pr: { url: URL } })
    expect(repo.notified.at(-1)).toBe(`checkout: the merge request is open: ${URL}.`)
  })

  test('a merge request that cannot be opened stops the run with what glab said', async ($, on) => {
    const repo = repoOf(on, { files: files(), quota: { short: 20, weekly: 30 }, origin: ORIGIN })

    repo.gitlab.failsToOpen = true
    await ship($, 'resume')
    await ends($, repo, 'agent-1')
    await ends($, repo, 'agent-2')
    await ends($, repo, 'agent-3', { answer: CLEAN, changes: '' })

    expect(repo.record('checkout')).toMatchObject({ phase: 'paused', pause: 'the merge request could not be opened: ERROR: 401 Unauthorized' })
  })

  test('opens a draft when a ticket is unfinished, and makes it ready once the run is whole', async ($, on) => {
    const repo = repoOf(on, {
      files: { ...files(), '.scratch/checkout/issues/03-tax.md': ticket('03', 'Tax is added', ['**Blocked by:** None', '**Status:** ready']) },
      exits: { 'npm test': 1 },
      origin: ORIGIN,
    })

    // 01 fails twice and is blocked, with 02 that hangs off it; 03 is built
    await ship($, 'resume')
    await ends($, repo, 'agent-1')
    await ends($, repo, 'agent-2')
    repo.exits['npm test'] = 0
    await ends($, repo, 'agent-3')
    await ends($, repo, 'agent-4', { answer: CLEAN, changes: '' })

    expect(repo.ran).toContain('glab mr create --source-branch checkout-feature --target-branch main --title checkout --description-file - --yes --draft')
    expect(repo.gitlab.mr).toMatchObject({ draft: true })
    expect(repo.notified.at(-1)).toBe(`checkout: a draft merge request is open: ${URL}.`)

    repo.files[CART] = ticket('01', 'A cart holds items', ['**Blocked by:** None', '**Status:** ready'])
    repo.files[PAY] = ticket('02', 'A cart is paid', ['**Blocked by:** 01', '**Status:** ready'])
    repo.change('')
    await ship($, 'resume')
    await ends($, repo, 'agent-5')
    await ends($, repo, 'agent-6')
    await ends($, repo, 'agent-7', { answer: CLEAN, changes: '' })

    expect(repo.ran).toContain('glab mr update checkout-feature --description-file - --yes --ready')
    expect(repo.gitlab.mr).toMatchObject({ draft: false })
    expect(repo.logged.at(-1)).toBe(`checkout: the review found nothing to fix; the merge request is up to date: ${URL}.`)
  })

  test('is followed up at /ship resume: the failed jobs of its pipeline and its notes, less what GitLab logged itself', async ($, on) => {
    const repo = await opened($, on)

    repo.gitlab.jobs = [
      { name: 'test', status: 'failed', web_url: 'https://gitlab.com/dev/repo/-/jobs/1' },
      { name: 'lint', status: 'success' },
      { name: 'audit', status: 'failed', allow_failure: true },
    ]
    repo.gitlab.notes = [
      { author: { username: 'mona' }, body: 'This throws on an empty cart.', created_at: '2026-10-12T09:00:00Z', position: { new_path: 'src/cart.ts', new_line: 14 } },
      { author: { username: 'lee' }, body: 'Please name the cart a Cart.', created_at: '2026-10-12T09:05:00Z' },
      { author: { username: 'mona' }, body: 'added 1 commit', created_at: '2026-10-12T09:06:00Z', system: true },
    ]
    repo.ran.length = 0

    expect(await ship($, 'resume')).toBe('checkout: the merge request has 1 failing check and 2 comments; following them up on sonnet.')
    expect(glab(repo)).toEqual([
      'glab mr view checkout-feature --output json',
      'glab api projects/:fullpath/pipelines/501/jobs?per_page=100',
      'glab api projects/:fullpath/merge_requests/7/notes?per_page=100&sort=asc',
    ])
    expect(repo.files['.scratch/checkout/followup.md']?.split('\n')).toEqual([
      `# What the merge request ${URL} has met`,
      '',
      '## Failing checks',
      '',
      '- test: https://gitlab.com/dev/repo/-/jobs/1',
      '',
      '## Reviews and comments',
      '',
      '### mona, on src/cart.ts:14',
      '',
      'This throws on an empty cart.',
      '',
      '### lee, on a comment',
      '',
      'Please name the cart a Cart.',
      '',
    ])
    expect(repo.spawned[3]).toMatchObject({ subagentType: 'ship-flow:implementer', description: 'Follow up the merge request of checkout', cwd: FINISH })
    expect((await ship($, 'status')).split('\n')[0]).toMatch(/· following up its merge request$/)
  })

  test('gets what the follow-up pass built: the same merge request is brought up to date through glab', async ($, on) => {
    const repo = await opened($, on)

    repo.gitlab.notes = [{ author: { username: 'mona' }, body: 'This throws on an empty cart.', created_at: '2026-10-12T09:00:00Z' }]
    await ship($, 'resume')
    await ends($, repo, 'agent-4', { answer: '1. Fixed.' })

    expect(repo.ran).toContain('glab mr update checkout-feature --description-file - --yes')
    expect(repo.ran.some(line => line.startsWith('glab mr create'))).toBe(false)
    expect(repo.ran.some(line => line.includes('follow-up of the merge request'))).toBe(true)
    expect(repo.gitlab.body).toContain('## Follow-up')
    expect(repo.logged.at(-1)).toMatch(new RegExp(`the merge request is up to date: ${URL}\\.$`))
  })

  test('with nothing failing and nothing new said is left alone', async ($, on) => {
    const repo = await opened($, on)

    repo.gitlab.jobs = [{ name: 'test', status: 'success' }]
    repo.gitlab.notes = [{ author: { username: 'gitlab' }, body: 'approved this merge request', created_at: '2026-10-12T09:00:00Z', system: true }]

    expect(await ship($, 'resume')).not.toContain('following them up')
    expect(repo.spawned).toHaveLength(3)
  })
})

describe('the forge setting', () => {
  test('makes a repo under a host that does not say so a GitLab one', { options: { forge: 'gitlab' } }, async ($, on) => {
    const repo = repoOf(on, { files: {}, branch: 'main', issues: ISSUES, origin: 'git@code.acme.dev:dev/repo.git' })

    await ship($, '#12')

    expect(glab(repo)).toEqual(['glab issue view 12 --output json'])
    expect(repo.record('pay-a-cart-by-card')).toMatchObject({ forge: 'gitlab' })
  })

  test('left empty, such a repo is on GitHub, as every repo was', async ($, on) => {
    const repo = repoOf(on, { files: {}, branch: 'main', issues: ISSUES, origin: 'git@code.acme.dev:dev/repo.git' })

    await ship($, '#12')

    expect(repo.ran).toContain('gh issue view 12 --json number,title,body,labels')
    expect(repo.record('pay-a-cart-by-card').forge).toBeUndefined()
  })
})
