import { describe, expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { slugOf } from '../hooks/attended'
import { answerRepo, spec, ticket } from './repo'

type Engine = Parameters<TestBody>[0]
type Repo = ReturnType<typeof answerRepo>

const IDEA = 'Let a cart be paid by card'
const FOLDER = '.scratch/let-a-cart-be-paid-by-card'
const ISSUES = { 12: { title: 'Pay a cart by card', body: 'Customers cannot pay.' } }

// The repo of the test that is running: its clock lets what a command left queued (a prompt, a compaction) happen
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

// What the attended phase leaves in the run's folder: a spec, whose heading carries the feature's title, and two tickets
const attend = (repo: Repo, folder = FOLDER, { isTitled = true } = {}) => {
  repo.files[`${folder}/spec.md`] = isTitled ? spec(['npm test']).replace('# Spec', '# Spec: Pay a cart by card') : spec(['npm test'])
  repo.files[`${folder}/issues/01-cart.md`] = ticket('01', 'A cart holds items', ['**Blocked by:** None', '**Status:** ready'])
  repo.files[`${folder}/issues/02-pay.md`] = ticket('02', 'A cart is paid', ['**Blocked by:** 01', '**Status:** ready'])
}

describe('/ship <idea>', () => {
  test('begins a run: its folder, its record and its source, and nothing on GitHub', async ($, on) => {
    const repo = repoOf(on,{ files: {}, branch: 'main' })

    expect(await ship($, IDEA)).toBe('let-a-cart-be-paid-by-card: started from your idea: the grilling begins.')
    expect(repo.record('let-a-cart-be-paid-by-card')).toEqual({
      feature: 'let-a-cart-be-paid-by-card',
      branch: 'main',
      phase: 'attended',
      step: 'grilling',
      attempts: {},
      source: 'idea',
    })
    expect(repo.files[`${FOLDER}/source.md`]).toBe(`${IDEA}\n`)
    expect(repo.ran.filter(line => line.startsWith('gh'))).toEqual([])
  })

  test('hands the model the attended phase: the grilling skills, where things go, and a pointer to the later steps', async ($, on) => {
    const repo = repoOf(on,{ files: {}, branch: 'main' })

    await ship($, IDEA)

    const [prompt = ''] = repo.prompts

    expect(repo.prompts).toHaveLength(1)
    expect(prompt).toContain('A ship-flow run has started for the feature `let-a-cart-be-paid-by-card`.')
    expect(prompt).toContain('`mattpocock-skills:grilling` and `mattpocock-skills:domain-modeling`')
    expect(prompt).toContain('`/prototype`, `/wayfinder`')
    expect(prompt).toContain(`The spec goes to \`${FOLDER}/spec.md\`, the tickets to \`${FOLDER}/issues/\`.`)
    expect(prompt).toContain('an Explore agent on the `haiku` model')
    expect(prompt).toMatch(/Read `.*\/prompts\/spec\.md` and follow it\./)
    expect(prompt).toContain('Publish nothing to GitHub')
    expect(prompt.endsWith(IDEA)).toBe(true)
  })

  test('has the run\'s folder ignored by git when it is not', async ($, on) => {
    const repo = repoOf(on,{ files: { '.gitignore': 'node_modules/' }, branch: 'main', isIgnored: false })

    await ship($, IDEA)

    expect(repo.files['.gitignore']).toBe('node_modules/\n\n# Working files of a ship-flow run (spec, tickets, run record)\n.scratch/\n')
  })

  test('leaves the ignore file alone when the folder is already ignored', async ($, on) => {
    const repo = repoOf(on,{ files: { '.gitignore': '.scratch/\n' }, branch: 'main' })

    await ship($, IDEA)

    expect(repo.files['.gitignore']).toBe('.scratch/\n')
  })

  test('refuses on uncommitted changes: what the grilling changes is committed with the run', async ($, on) => {
    const repo = repoOf(on,{ files: {}, porcelain: ' M src/cart.ts\n' })

    expect(await ship($, IDEA)).toMatch(/uncommitted changes/)
    expect(repo.prompts).toEqual([])
    expect(Object.keys(repo.files)).toEqual([])
  })

  test('refuses while another run is under way in the repo, and says how to end it', async ($, on) => {
    const repo = repoOf(on,{ files: {}, branch: 'main' })

    await ship($, IDEA)

    expect(await ship($, 'Another idea')).toBe(
      `A run is already under way here: let-a-cart-be-paid-by-card. Finish it (/ship resume let-a-cart-be-paid-by-card) or delete ${FOLDER}/ first.`,
    )
    expect(repo.prompts).toHaveLength(1)
  })

  test('names a second feature of the same words apart from the first', async ($, on) => {
    const repo = repoOf(on,{ files: { [`${FOLDER}/issues/01-old.md`]: ticket('01', 'Old', ['**Status:** done']) }, branch: 'main' })

    expect(await ship($, IDEA)).toMatch(/^let-a-cart-be-paid-by-card-2: /)
    expect(repo.record('let-a-cart-be-paid-by-card-2')).toMatchObject({ phase: 'attended' })
  })

  test('/ship status shows the run as with the person, before it has a ticket', async ($, on) => {
    repoOf(on,{ files: {}, branch: 'main' })
    await ship($, IDEA)

    expect(await ship($, 'status')).toBe(
      'let-a-cart-be-paid-by-card: no tickets yet · with you, before the checkpoint: /ship resume approves it',
    )
  })

  test('with nothing after it says how the command is used', async ($, on) => {
    const repo = repoOf(on,{ files: {} })

    expect(await ship($, '')).toMatch(/^Usage:/)
    expect(repo.prompts).toEqual([])
  })
})

describe('/ship #<issue>', () => {
  test('begins a run from the issue: its number and title are the run\'s, and its text the source', async ($, on) => {
    const repo = repoOf(on,{ files: {}, branch: 'main', issues: ISSUES })

    expect(await ship($, '#12')).toBe('pay-a-cart-by-card: started from issue #12: the grilling begins.')
    expect(repo.record('pay-a-cart-by-card')).toMatchObject({ phase: 'attended', source: 'issue', issue: 12, title: 'Pay a cart by card' })
    expect(repo.prompts[0]).toContain('Source: GitHub issue #12, "Pay a cart by card", below.')
    expect(repo.prompts[0]?.endsWith('# Pay a cart by card\n\nCustomers cannot pay.')).toBe(true)
  })

  test('skips the grilling for an issue already agreed', async ($, on) => {
    const repo = repoOf(on,{ files: {}, branch: 'main', issues: { 12: { ...ISSUES[12], labels: ['enhancement', 'ready-for-agent'] } } })

    expect(await ship($, '12')).toBe('pay-a-cart-by-card: started from issue #12, which is already agreed: the spec comes next.')
    expect(repo.prompts[0]).toContain('**Skip the grilling.** Issue #12 is labelled `ready-for-agent`')
    expect(repo.prompts[0]).not.toContain('mattpocock-skills:grilling')
  })

  test('says so when the issue cannot be read, and begins nothing', async ($, on) => {
    const repo = repoOf(on,{ files: {}, branch: 'main' })

    expect(await ship($, '#99')).toBe('Issue #99 could not be read: GraphQL: Could not resolve to an Issue')
    expect(repo.prompts).toEqual([])
  })
})

describe('the checkpoint', () => {
  test('is not reached while the run has no spec: the attended phase is handed to this conversation again', async ($, on) => {
    const repo = repoOf(on,{ files: {}, branch: 'main' })

    await ship($, IDEA)

    expect(await ship($, 'resume')).toBe(
      'let-a-cart-be-paid-by-card: still before its checkpoint, with no spec yet: the attended phase goes on in this conversation.',
    )
    expect(repo.branch()).toBe('main')
    expect(repo.github.issues).toEqual([])
    expect(repo.prompts).toHaveLength(2)
    expect(repo.prompts[1]).toContain('## Taken up again')
    expect(repo.prompts[1]).toContain('This run was begun in an earlier conversation, which is gone')
    expect(repo.prompts[1]).toContain('`mattpocock-skills:grilling`')
    expect(repo.prompts[1]?.endsWith(IDEA)).toBe(true)
  })

  test('is not reached while the spec is written and the tickets are not, and says which is missing', async ($, on) => {
    const repo = repoOf(on, { files: {}, branch: 'main' })

    await ship($, IDEA)
    repo.files[`${FOLDER}/spec.md`] = spec(['npm test'])

    expect(await ship($, 'resume')).toMatch(/with no tickets yet: the attended phase goes on in this conversation\.$/)
    expect(repo.spawned).toEqual([])
  })

  test('a run begun from an issue is taken up again as that issue\'s', async ($, on) => {
    const repo = repoOf(on, { files: {}, branch: 'main', issues: ISSUES })

    await ship($, '#12')
    await ship($, 'resume')

    expect(repo.prompts[1]).toContain('Source: GitHub issue #12, "Pay a cart by card", below.')
  })

  test('is refused while the spec of a run from an idea has no title, and nothing is opened', async ($, on) => {
    const repo = repoOf(on,{ files: {}, branch: 'main' })

    await ship($, IDEA)
    attend(repo, FOLDER, { isTitled: false })

    expect(await ship($, 'resume')).toMatch(/cannot start: \.scratch\/let-a-cart-be-paid-by-card\/spec\.md has no `# Spec: <title>` line/)
    expect(repo.github.issues).toEqual([])
    expect(repo.spawned).toEqual([])
  })

  test('approved, opens the one issue of a run from an idea, from its spec: the title of its heading, and the rest as body', async ($, on) => {
    const repo = repoOf(on,{ files: {}, branch: 'main' })

    await ship($, IDEA)
    attend(repo)
    await ship($, 'resume')

    expect(repo.github.issues).toEqual([
      { title: 'Pay a cart by card', body: '## Solution\n\nSomething.\n\n## Verification\n\n```\nnpm test\n```\n' },
    ])
    expect(repo.record('let-a-cart-be-paid-by-card')).toMatchObject({ issue: 31, title: 'Pay a cart by card' })
  })

  test('approved, opens no issue for a run that started from one', async ($, on) => {
    const repo = repoOf(on,{ files: {}, branch: 'main', issues: ISSUES })

    await ship($, '#12')
    attend(repo, '.scratch/pay-a-cart-by-card', { isTitled: false })
    await ship($, 'resume')

    expect(repo.github.issues).toEqual([])
    expect(repo.record('pay-a-cart-by-card')).toMatchObject({ issue: 12, phase: 'unattended' })
  })

  test('approved, moves the run to a branch of its own and starts the first ticket there', async ($, on) => {
    const repo = repoOf(on,{ files: {}, branch: 'main' })

    await ship($, IDEA)
    attend(repo)

    expect(await ship($, 'resume')).toBe(
      'let-a-cart-be-paid-by-card: approved, on branch ship/let-a-cart-be-paid-by-card; building 01 A cart holds items on sonnet, on branch ship/let-a-cart-be-paid-by-card.',
    )
    expect(repo.branch()).toBe('ship/let-a-cart-be-paid-by-card')
    expect(repo.record('let-a-cart-be-paid-by-card')).toMatchObject({ phase: 'unattended', branch: 'ship/let-a-cart-be-paid-by-card', ticket: 1 })
  })

  test('approved, commits on that branch what the grilling changed, as the feature\'s first commit', async ($, on) => {
    const repo = repoOf(on,{ files: {}, branch: 'main' })

    await ship($, IDEA)
    attend(repo)
    repo.change(' M CONTEXT.md\n?? docs/adr/0004-card-payments.md\n')
    repo.ran.length = 0
    await ship($, 'resume')

    const made = repo.ran.indexOf('git checkout -b ship/let-a-cart-be-paid-by-card')

    expect(made).toBeGreaterThan(-1)
    expect(repo.ran.slice(made + 1, made + 4)).toEqual([
      'git status --porcelain',
      'git add -A',
      'git commit -m let-a-cart-be-paid-by-card: the glossary and decisions of the grilling',
    ])
  })

  test('approved, has the main conversation compacted to pointers', async ($, on) => {
    const repo = repoOf(on,{ files: {}, branch: 'main' })

    await ship($, IDEA)
    attend(repo)
    await ship($, 'resume')

    expect(repo.compacted).toHaveLength(1)
    expect(repo.compacted[0]).toContain(`the spec ${FOLDER}/spec.md, the tickets in ${FOLDER}/issues/, the branch ship/let-a-cart-be-paid-by-card, the issue #31`)
  })

  test('an issue that cannot be opened stops the approval with what GitHub said, on the branch the run began on', async ($, on) => {
    const repo = repoOf(on,{ files: {}, branch: 'main' })

    await ship($, IDEA)
    attend(repo)
    repo.github.failsToOpen = true

    expect(await ship($, 'resume')).toBe('let-a-cart-be-paid-by-card: cannot start: the issue could not be opened: GraphQL: not authorized.')
    expect(repo.branch()).toBe('main')
    expect(repo.record('let-a-cart-be-paid-by-card')).toMatchObject({ phase: 'attended' })
  })

  test('the pull request at the end carries the issue\'s title and closes it', async ($, on) => {
    const repo = repoOf(on,{ files: {}, branch: 'main' })
    const ends = async (agentId: string, answer = 'Built.', changes = ' M src/cart.ts\n') => {
      repo.change(changes)
      await $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId: 't1', agentId, reason: 'answer' } as never)
    }

    await ship($, IDEA)
    attend(repo)
    await ship($, 'resume')
    await ends('agent-1')
    await ends('agent-2')
    await ends('agent-3', 'Nothing is wrong.\n\nFINDINGS: 0', '')

    expect(repo.github).toMatchObject({ title: 'Pay a cart by card', base: 'main', pr: { isDraft: false } })
    expect(repo.github.body.split('\n')[0]).toBe('Closes #31')
  })
})

test('a feature is named by the first words of its title', () => {
  expect(slugOf('Let a cart be paid by card, and by wire transfer too')).toBe('let-a-cart-be-paid-by-card-and')
  expect(slugOf('  Résumé upload (PDF & DOCX)!  ')).toBe('resume-upload-pdf-docx')
  expect(slugOf('An extraordinarily overlong featurename that keeps going')).toBe('an-extraordinarily-overlong-featurename')
  expect(slugOf('???')).toBe('feature')
})
