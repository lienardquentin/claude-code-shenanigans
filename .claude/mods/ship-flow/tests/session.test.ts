import { describe, expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { answerRepo, spec, ticket } from './repo'

type Engine = Parameters<TestBody>[0]
type Repo = ReturnType<typeof answerRepo>

const FEATURE = 'pay-a-cart-by-card'
const FOLDER = `.scratch/${FEATURE}`
const RECORD = '.scratch/checkout/run.json'

const ship = async ($: Engine, repo: Repo, args: string) => {
  const { text = '' } = await $.command.run({ command: 'ship', args } as never)

  await repo.clock.settle()

  return text
}

// The model reads a file, as it does one of the mod's step texts on passing from a step to the next
const reads = async ($: Engine, path: string) => {
  await $.tool.call({ tool: 'Read', file_path: path, tool_use_id: 'call-1' } as never)
}

// A turn of the main conversation ends, with its window `percent` full
const turnEnds = async ($: Engine, repo: Repo, percent: number) => {
  repo.context.percent = percent
  await $.turn.complete({ answer: 'Over to you.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never)
  await repo.clock.settle()
}

// The mod's own folder as the prompt it handed the model names it
const rootOf = (repo: Repo) => /Read `(.*)\/prompts\/spec\.md`/.exec(repo.prompts[0] ?? '')?.[1] ?? ''

const started = async ($: Engine, on: Parameters<TestBody>[1]) => {
  const repo = answerRepo(on, { files: {}, branch: 'main' })

  await ship($, repo, 'Pay a cart by card')

  return repo
}

describe('the attended phase and its context budget', () => {
  test('the conversation is never compacted during the grilling, however full it gets', async ($, on) => {
    const repo = await started($, on)

    await turnEnds($, repo, 85)
    await turnEnds($, repo, 95)

    expect(repo.compacted).toEqual([])
    expect(repo.record(FEATURE)).toMatchObject({ step: 'grilling' })
  })

  test('the model reading the spec step is the end of the grilling: past the budget, the conversation is compacted at the next pause', async ($, on) => {
    const repo = await started($, on)

    await turnEnds($, repo, 85)
    await reads($, `${rootOf(repo)}/prompts/spec.md`)

    expect(repo.record(FEATURE)).toMatchObject({ step: 'spec' })
    expect(repo.compacted).toEqual([])

    await turnEnds($, repo, 86)

    expect(repo.compacted).toHaveLength(1)
    expect(repo.logged).toEqual([`${FEATURE}: the conversation is past its context budget and is being compacted, now that the grilling is over.`])
  })

  test('the compaction keeps the decisions and the pointers, and drops what was read to reach them', async ($, on) => {
    const repo = await started($, on)

    await reads($, `${rootOf(repo)}/prompts/spec.md`)
    await turnEnds($, repo, 86)

    const [instructions = ''] = repo.compacted

    expect(instructions).toContain('every decision the person made in the grilling and the reason for it')
    expect(instructions).toContain('every question still open')
    expect(instructions).toContain(`${rootOf(repo)}/prompts/spec.md`)
    expect(instructions).toContain(`the spec is ${FOLDER}/spec.md`)
    expect(instructions).toContain('Drop what was read to get there')
  })

  test('a boundary compacts the conversation once, and a conversation under its budget not at all', async ($, on) => {
    const repo = await started($, on)

    await reads($, `${rootOf(repo)}/prompts/spec.md`)
    await turnEnds($, repo, 40)
    await turnEnds($, repo, 86)
    await turnEnds($, repo, 90)

    expect(repo.compacted).toHaveLength(1)
  })

  test('the spec being written is the next boundary: the conversation may be compacted again there', async ($, on) => {
    const repo = await started($, on)

    await reads($, `${rootOf(repo)}/prompts/spec.md`)
    await turnEnds($, repo, 86)
    await reads($, `${rootOf(repo)}/prompts/tickets.md`)
    await turnEnds($, repo, 75)

    expect(repo.compacted).toHaveLength(2)
    expect(repo.compacted[1]).toContain('now writing its tickets')
    expect(repo.logged[1]).toMatch(/now that the spec is written\.$/)
  })

  test('has the budget the person set', { options: { contextPercent: 30 } }, async ($, on) => {
    const repo = await started($, on)

    await reads($, `${rootOf(repo)}/prompts/spec.md`)
    await turnEnds($, repo, 35)

    expect(repo.compacted).toHaveLength(1)
  })

  test('any other file the model reads is no boundary, and no run means nothing is done', async ($, on) => {
    const repo = answerRepo(on, { files: {}, branch: 'main' })

    await reads($, '/home/dev/repo/prompts/spec.md')
    await turnEnds($, repo, 95)

    expect(repo.compacted).toEqual([])
    expect(Object.keys(repo.files)).toEqual([])
  })
})

describe('a session that starts in a repo with a run that is not building', () => {
  const checkout = (record: Record<string, unknown>) => ({
    '.scratch/checkout/spec.md': spec(['npm test']),
    '.scratch/checkout/issues/01-cart.md': ticket('01', 'A cart holds items', ['**Blocked by:** None', '**Status:** ready']),
    [RECORD]: JSON.stringify({ feature: 'checkout', branch: 'ship/checkout', attempts: {}, ...record }),
  })
  const starts = async ($: Engine) => {
    await $.session.start({ cwd: '/home/dev/repo' } as never)
  }

  test('is told once of a paused run, with why and the command that takes it up', async ($, on) => {
    const repo = answerRepo(on, {
      files: checkout({ phase: 'paused', pause: 'the 5-hour quota window is at 92%: the run goes on by itself at 22:11 UTC', resumeAt: 5000 }),
    })

    await starts($)

    expect(repo.logged).toEqual([
      'checkout is paused (the 5-hour quota window is at 92%: the run goes on by itself at 22:11 UTC). /ship status shows it; /ship resume takes it up.',
    ])
  })

  test('never takes the run up itself, however long the session then stays open', async ($, on) => {
    const repo = answerRepo(on, { files: checkout({ phase: 'paused', pause: 'waiting', resumeAt: 5000 }) })

    await starts($)
    await repo.clock.advance(24 * 60 * 60 * 1000)

    expect(repo.spawned).toEqual([])
    expect(repo.record('checkout')).toMatchObject({ phase: 'paused' })
  })

  test('is told of a run that was cut off mid-ticket, and of one still before its checkpoint', async ($, on) => {
    const cut = answerRepo(on, { files: checkout({ phase: 'unattended', ticket: 3, agentId: 'gone' }) })

    await starts($)

    expect(cut.logged).toEqual(['checkout was cut off while building ticket 03. /ship status shows it; /ship resume takes it up.'])
  })

  test('is told of a run still before its checkpoint', async ($, on) => {
    const repo = answerRepo(on, { files: { [RECORD]: JSON.stringify({ feature: 'checkout', branch: 'main', attempts: {}, phase: 'attended' }) } })

    await starts($)

    expect(repo.logged).toEqual(['checkout is before its checkpoint. /ship status shows it; /ship resume takes it up.'])
  })

  test('is told nothing of a run that has ended, of ticket folders with no run, or in a repo with none', async ($, on) => {
    const repo = answerRepo(on, {
      files: {
        ...checkout({ phase: 'ended', pr: { url: 'https://github.com/dev/repo/pull/7', head: 'abc1234' } }),
        '.scratch/search/issues/01-index.md': ticket('01', 'Pages are indexed', ['**Blocked by:** None', '**Status:** ready']),
      },
    })

    await starts($)

    expect(repo.logged).toEqual([])
  })
})
