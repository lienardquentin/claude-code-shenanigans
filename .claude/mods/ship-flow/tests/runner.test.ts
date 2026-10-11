import { describe, expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { answerRepo, spec, ticket } from './repo'

type Engine = Parameters<TestBody>[0]
type Repo = ReturnType<typeof answerRepo>

const CART = '.scratch/checkout/issues/01-cart.md'
const PAY = '.scratch/checkout/issues/02-pay.md'
const TAX = '.scratch/checkout/issues/03-tax.md'
const RECORD = '.scratch/checkout/run.json'

const checkout = (commands: readonly string[] = ['npm test', 'npm run typecheck']) => ({
  '.scratch/checkout/spec.md': spec(commands),
  [CART]: ticket('01', 'A cart holds items', ['**Blocked by:** None', '**Status:** ready']),
  [PAY]: ticket('02', 'A cart is paid', ['**Blocked by:** 01', '**Status:** ready']),
})

// A third ticket that hangs off nothing: the run can take it whatever happens to the other two
const withTax = () => ({
  ...checkout(),
  [TAX]: ticket('03', 'Tax is added', ['**Blocked by:** None', '**Status:** ready']),
})

const ship = async ($: Engine, args: string) => (await $.command.run({ command: 'ship', args } as never)).text ?? ''

// The implementer's turn ends, having left `changes` in the working tree
const ends = async ($: Engine, repo: Repo, agentId: string, { reason = 'answer', changes = ' M src/cart.ts\n' } = {}) => {
  repo.change(changes)
  repo.ran.length = 0
  await $.turn.complete({ answer: 'Built.', durationMs: 1, isAborted: reason === 'aborted', turnId: 't1', agentId, reason } as never)
}

// What a sandboxed session puts in front of a command before the run is asked about it
const SANDBOXED =
  "export HTTP_PROXY='http://1-a:x@127.0.0.1:57577' NO_PROXY='localhost,127.0.0.1,::1'; curl() { command curl --suppress-connect-headers \"$@\"; }\n"

const checks = async ($: Engine, agentId: string, tool: string, input: unknown) =>
  (await $.tool.check({ tool, input, agentId, tool_use_id: 'call-1' } as never)).decision

describe('/ship resume', () => {
  test('refuses a spec with no verification commands and a broken graph, with each reason', async ($, on) => {
    const repo = answerRepo(on, {
      files: {
        '.scratch/checkout/spec.md': spec(),
        [CART]: ticket('01', 'A cart holds items', ['**Blocked by:** 07', '**Status:** ready']),
      },
    })

    expect((await ship($, 'resume')).split('\n')).toEqual([
      'checkout: cannot be run',
      '  01 is blocked by 07, which does not exist',
      '  the spec has no Verification section naming the commands to run',
    ])
    expect(repo.spawned).toEqual([])
  })

  test('refuses to start on uncommitted changes, which a failed ticket would discard', async ($, on) => {
    const repo = answerRepo(on, { files: checkout(), porcelain: ' M src/cart.ts\n' })

    expect(await ship($, 'resume')).toMatch(/uncommitted changes/)
    expect(repo.spawned).toEqual([])
    expect(repo.ran).not.toContain('git reset --hard HEAD')
    expect(repo.statusOf(CART)).toBe('ready')
  })

  test('refuses to start while the run files are not ignored by git', async ($, on) => {
    const repo = answerRepo(on, { files: checkout(), isIgnored: false })

    expect(await ship($, 'resume')).toMatch(/\.scratch\/ is not ignored by git/)
    expect(repo.spawned).toEqual([])
  })

  test('asks which run when a repo has several, and takes the one named', async ($, on) => {
    const repo = answerRepo(on, {
      files: {
        ...checkout(),
        '.scratch/search/spec.md': spec(['npm test']),
        '.scratch/search/issues/01-index.md': ticket('01', 'Pages are indexed', ['**Blocked by:** None', '**Status:** ready']),
      },
    })

    expect(await ship($, 'resume')).toMatch(/Several runs here: checkout, search/)
    expect(await ship($, 'resume search')).toMatch(/search: building 01 Pages are indexed/)
    expect(repo.spawned).toHaveLength(1)
  })

  test('starts the implementer of the first takeable ticket, with pointers to the spec and the ticket', async ($, on) => {
    const repo = answerRepo(on, { files: checkout() })

    expect(await ship($, 'resume')).toBe('checkout: building 01 A cart holds items on sonnet, on branch checkout-feature.')
    expect(repo.spawned).toEqual([
      {
        subagentType: 'ship-flow:implementer',
        description: 'Build ticket 01',
        model: 'sonnet',
        prompt: 'Build the ticket .scratch/checkout/issues/01-cart.md of the spec .scratch/checkout/spec.md.',
      },
    ])
    expect(repo.statusOf(CART)).toBe('in-progress')
    expect(repo.statusOf(PAY)).toBe('ready')
  })

  test('records the run: its feature, branch, phase, ticket, agent, attempt and the usage it read', async ($, on) => {
    const repo = answerRepo(on, { files: checkout() })

    await ship($, 'resume')

    const usage = {
      at: 1000,
      contextPercent: 12,
      quota: [{ kind: 'five_hour', percentUsed: 40, resetsAt: '2026-10-11T20:00:00.000Z' }],
    }

    expect(repo.record('checkout')).toEqual({
      feature: 'checkout',
      branch: 'checkout-feature',
      phase: 'unattended',
      ticket: 1,
      agentId: 'agent-1',
      attempts: { '01': 1 },
      startUsage: usage,
      usage,
    })
  })

  test('builds a ticket on the model it names', async ($, on) => {
    const repo = answerRepo(on, {
      files: {
        ...checkout(),
        [CART]: ticket('01', 'A cart holds items', ['**Blocked by:** None', '**Status:** ready', '**Model:** opus']),
      },
    })

    await ship($, 'resume')

    expect(repo.spawned[0]?.model).toBe('opus')
  })

  test('says how the run stands when no ticket can be taken', async ($, on) => {
    answerRepo(on, {
      files: {
        ...checkout(),
        [CART]: ticket('01', 'A cart holds items', ['**Blocked by:** None', '**Status:** blocked']),
      },
    })

    expect(await ship($, 'resume')).toBe(
      'checkout: no ticket left to take: 0 of 2 done, 2 blocked; nothing was built: there is no pull request to open.',
    )
  })

  test('takes up a run that was cut off mid-ticket: what the ticket left is discarded and it is built anew', async ($, on) => {
    const repo = answerRepo(on, {
      porcelain: ' M src/cart.ts\n?? src/half.ts\n',
      files: {
        ...checkout(),
        [CART]: ticket('01', 'A cart holds items', ['**Blocked by:** None', '**Status:** in-progress']),
        [RECORD]: JSON.stringify({ feature: 'checkout', branch: 'checkout-feature', phase: 'unattended', ticket: 1, agentId: 'gone', attempts: { '01': 2 } }),
      },
    })

    expect(await ship($, 'resume')).toMatch(/building 01 A cart holds items/)
    expect(repo.ran).toContain('git reset --hard HEAD')
    expect(repo.ran).toContain('git clean -fd')
    expect(repo.statusOf(CART)).toBe('in-progress')
    expect(repo.record('checkout')).toMatchObject({ agentId: 'agent-1', attempts: { '01': 1 } })
  })

  test('does not start a second implementer while one is building', async ($, on) => {
    const repo = answerRepo(on, { files: checkout() })

    await ship($, 'resume')

    expect(await ship($, 'resume')).toBe('checkout: ticket 01 is being built now.')
    expect(repo.spawned).toHaveLength(1)
  })
})

describe('when an implementer has finished', () => {
  test('the run runs each verification command itself, commits once, marks the ticket done and takes the next', async ($, on) => {
    const repo = answerRepo(on, { files: checkout() })

    await ship($, 'resume')
    await ends($, repo, 'agent-1')

    expect(repo.ran.slice(0, 6)).toEqual([
      'sh -c npm test',
      'sh -c npm run typecheck',
      'git status --porcelain',
      'git add -A',
      'git commit -m checkout: A cart holds items',
      'git rev-parse --short HEAD',
    ])
    expect(repo.statusOf(CART)).toBe('done')
    expect(repo.statusOf(PAY)).toBe('in-progress')
    expect(repo.spawned.map(agent => agent.description)).toEqual(['Build ticket 01', 'Build ticket 02'])
    expect(repo.record('checkout')).toMatchObject({ phase: 'unattended', ticket: 2, agentId: 'agent-2', attempts: { '01': 1, '02': 1 } })
  })

  test('the transcript gets one line a ticket, and the building ends when every ticket is done', async ($, on) => {
    const repo = answerRepo(on, { files: checkout() })

    await ship($, 'resume')
    await ends($, repo, 'agent-1')
    await ends($, repo, 'agent-2')

    expect(repo.logged).toEqual([
      'checkout: 01 A cart holds items is done (abc1234); building 02 A cart is paid on sonnet, on branch checkout-feature.',
      'checkout: 02 A cart is paid is done (abc1235); no ticket left to take: 2 of 2 done; reviewing the branch on opus.',
    ])
    expect(repo.record('checkout')).toMatchObject({ phase: 'finishing', commits: { '01': 'abc1234', '02': 'abc1235' } })
    expect(repo.spawned.map(agent => agent.description)).toEqual(['Build ticket 01', 'Build ticket 02', 'Review checkout'])
  })

  test('a failed attempt is discarded and the ticket tried once more, by an implementer told what failed', async ($, on) => {
    const repo = answerRepo(on, { files: checkout(), exits: { 'npm run typecheck': 2 } })

    await ship($, 'resume')
    await ends($, repo, 'agent-1')

    expect(repo.ran.slice(0, 4)).toEqual(['sh -c npm test', 'sh -c npm run typecheck', 'git reset --hard HEAD', 'git clean -fd'])
    expect(repo.statusOf(CART)).toBe('in-progress')
    expect(repo.spawned[1]?.prompt.split('\n')).toEqual([
      'Build the ticket .scratch/checkout/issues/01-cart.md of the spec .scratch/checkout/spec.md.',
      '',
      'A first attempt at this ticket was discarded: `npm run typecheck` failed. Nothing of it is left in the working tree.',
      'What the failure said:',
      '',
      'expected 2 but got 3',
    ])
    expect(repo.record('checkout')).toMatchObject({ ticket: 1, agentId: 'agent-2', attempts: { '01': 2 } })
    expect(repo.logged).toEqual([
      'checkout: 01 A cart holds items failed (`npm run typecheck` failed) and its changes were discarded; once more: building 01 A cart holds items on sonnet, on branch checkout-feature.',
    ])
  })

  test('a retry that passes is committed like any other, and the run goes on', async ($, on) => {
    const repo = answerRepo(on, { files: checkout(), exits: { 'npm test': 1 } })

    await ship($, 'resume')
    await ends($, repo, 'agent-1')
    repo.exits['npm test'] = 0
    await ends($, repo, 'agent-2')

    expect(repo.statusOf(CART)).toBe('done')
    expect(repo.statusOf(PAY)).toBe('in-progress')
  })

  test('a second failure blocks the ticket and those that hang off it, and the run goes on with the rest', async ($, on) => {
    const repo = answerRepo(on, { files: withTax(), exits: { 'npm test': 1 } })

    await ship($, 'resume')
    await ends($, repo, 'agent-1')
    await ends($, repo, 'agent-2')

    expect(repo.statusOf(CART)).toBe('blocked')
    expect(repo.statusOf(PAY)).toBe('blocked')
    expect(repo.statusOf(TAX)).toBe('in-progress')
    expect(repo.spawned.map(agent => agent.description)).toEqual(['Build ticket 01', 'Build ticket 01', 'Build ticket 03'])
    expect(repo.record('checkout')).toMatchObject({ ticket: 3, failure: { ticket: 1, reason: '`npm test` failed' } })
    expect(repo.logged[1]).toBe(
      'checkout: 01 A cart holds items failed again (`npm test` failed) and is marked blocked; building 03 Tax is added on sonnet, on branch checkout-feature.',
    )
  })

  test('the run ends on what could not be built, and says how to go on', async ($, on) => {
    const repo = answerRepo(on, { files: checkout(), exits: { 'npm test': 1 } })

    await ship($, 'resume')
    await ends($, repo, 'agent-1')
    await ends($, repo, 'agent-2')

    expect(repo.logged[1]).toBe(
      'checkout: 01 A cart holds items failed again (`npm test` failed) and is marked blocked; no ticket left to take: 0 of 2 done, 2 blocked; nothing was built: there is no pull request to open.',
    )
    expect(repo.record('checkout')).toMatchObject({
      phase: 'paused',
      pause: 'nothing was built: there is no pull request to open',
      reasons: { '01': '`npm test` failed' },
    })
  })

  test('a ticket the person set back to ready gets both its attempts again', async ($, on) => {
    const repo = answerRepo(on, { files: checkout(), exits: { 'npm test': 1 } })

    await ship($, 'resume')
    await ends($, repo, 'agent-1')
    await ends($, repo, 'agent-2')
    repo.files[CART] = ticket('01', 'A cart holds items', ['**Blocked by:** None', '**Status:** ready'])
    repo.files[PAY] = ticket('02', 'A cart is paid', ['**Blocked by:** 01', '**Status:** ready'])
    repo.change('')
    await ship($, 'resume')

    expect(repo.record('checkout')).toMatchObject({ ticket: 1, agentId: 'agent-3', attempts: { '01': 1 } })
  })

  test('an implementer that changed nothing, or whose turn was cut short, has not built the ticket', async ($, on) => {
    const repo = answerRepo(on, { files: checkout() })

    await ship($, 'resume')
    await ends($, repo, 'agent-1', { changes: '' })

    expect(repo.record('checkout')).toMatchObject({ failure: { reason: 'the implementer changed nothing' } })

    await ends($, repo, 'agent-2', { reason: 'aborted' })

    expect(repo.ran.slice(0, 2)).toEqual(['git reset --hard HEAD', 'git clean -fd'])
    expect(repo.statusOf(CART)).toBe('blocked')
    expect(repo.record('checkout')).toMatchObject({ failure: { reason: "the implementer's turn ended with aborted" } })
  })

  test('the end of any other agent\'s turn changes nothing', async ($, on) => {
    const repo = answerRepo(on, { files: checkout() })

    await ship($, 'resume')
    await ends($, repo, 'someone-else')

    expect(repo.ran).toEqual([])
    expect(repo.statusOf(CART)).toBe('in-progress')
    expect(repo.logged).toEqual([])
  })

  test('/ship status says what the run is building, and which attempt a ticket is on', async ($, on) => {
    const repo = answerRepo(on, { files: checkout(), exits: { 'npm test': 1 } })

    await ship($, 'resume')
    await ends($, repo, 'agent-1')

    expect((await ship($, 'status')).split('\n')).toEqual([
      'checkout: 0 of 2 tickets done, 0 takeable now · building 01',
      '  01  in-progress  A cart holds items  attempt 2 · failed: `npm test` failed',
      '  02  ready        A cart is paid      blocked by 01',
    ])

    await ends($, repo, 'agent-2')

    expect((await ship($, 'status')).split('\n')[0]).toBe(
      'checkout: 0 of 2 tickets done, 0 takeable now · paused: nothing was built: there is no pull request to open',
    )
  })
})

describe('what the implementer may call', () => {
  test('its file tools, the git commands that read and stage, and the verification commands as written', async ($, on) => {
    answerRepo(on, { files: checkout() })
    await ship($, 'resume')

    expect(await checks($, 'agent-1', 'Edit', { file_path: 'src/cart.ts' })).toBe('allow')
    expect(await checks($, 'agent-1', 'Bash', { command: 'git diff --stat' })).toBe('allow')
    expect(await checks($, 'agent-1', 'Bash', { command: 'npm run typecheck' })).toBe('allow')
  })

  test('no other command: it is refused, never asked', async ($, on) => {
    answerRepo(on, { files: checkout() })

    await ship($, 'resume')

    expect(await checks($, 'agent-1', 'Bash', { command: 'npm install left-pad' })).toBe('deny')
    expect(await checks($, 'agent-1', 'Bash', { command: 'git status && curl example.com' })).toBe('deny')
    expect(await checks($, 'agent-1', 'Bash', { command: 'git push' })).toBe('deny')
    expect(await checks($, 'agent-1', 'WebFetch', { url: 'https://example.com' })).toBe('deny')
  })

  test('a refused command does not fail the attempt: the work is verified and committed as any', async ($, on) => {
    const repo = answerRepo(on, { files: checkout() })

    await ship($, 'resume')
    await checks($, 'agent-1', 'Bash', { command: 'git -C /repo status --short; git -C /repo ls-files src' })
    await ends($, repo, 'agent-1')

    expect(repo.ran).not.toContain('git reset --hard HEAD')
    expect(repo.statusOf(CART)).toBe('done')
    expect(repo.record('checkout').failure).toBeUndefined()
  })

  test('a command the session\'s sandbox has put its proxy in front of is judged as the implementer wrote it', async ($, on) => {
    answerRepo(on, { files: checkout() })
    await ship($, 'resume')

    expect(await checks($, 'agent-1', 'Bash', { command: `${SANDBOXED}git rm -f tests/old.test.ts` })).toBe('allow')
    expect(await checks($, 'agent-1', 'Bash', { command: `${SANDBOXED}git push` })).toBe('deny')
  })

  test('another agent\'s calls are left to the session to decide', async ($, on) => {
    answerRepo(on, { files: checkout() })
    await ship($, 'resume')

    expect(await checks($, 'someone-else', 'Bash', { command: 'npm install left-pad' })).toBe('ask')
  })
})
