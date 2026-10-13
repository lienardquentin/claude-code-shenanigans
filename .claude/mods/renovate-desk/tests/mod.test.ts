import { describe, expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { kindOf } from '../hooks/renovate'

type On = Parameters<TestBody>[1]
type Engine = Parameters<TestBody>[0]

const PANE = { bodyColumns: 120 } as const

type Given = { repo: string; number: number; title: string; body?: string; checks?: string | null; mergeable?: string; review?: string }

const node = ({ repo, number, title, body = '', checks = 'SUCCESS', mergeable = 'MERGEABLE', review }: Given) => ({
  number,
  title,
  url: `https://github.com/${repo}/pull/${number}`,
  body,
  isDraft: false,
  mergeable,
  reviewDecision: review ?? null,
  headRefOid: `head${number}`,
  repository: { nameWithOwner: repo, viewerDefaultMergeMethod: 'SQUASH' },
  commits: { nodes: [{ commit: { statusCheckRollup: checks === null ? null : { state: checks } } }] },
})

const BACKLOG: Given[] = [
  { repo: 'acme/api', number: 7, title: 'Update dependency zod to v3.23.8', body: '| zod | `3.23.0` -> `3.23.8` |' },
  { repo: 'acme/web', number: 12, title: 'chore(deps): update dependency vite to v5.4.0', body: '| vite | devDependencies | minor | `5.3.1` -> `5.4.0` |' },
  { repo: 'acme/web', number: 13, title: 'Update dependency react to v19', body: '| react | `18.3.1` -> `19.0.0` |' },
  { repo: 'acme/api', number: 8, title: 'Update dependency eslint to v9.1.1', body: '| eslint | `9.1.0` -> `9.1.1` |', checks: 'FAILURE' },
  { repo: 'acme/api', number: 9, title: 'Update dependency pg to v8.12.0', body: '| pg | `8.11.0` -> `8.12.0` |', checks: 'PENDING' },
]

const exited = (exitCode: number, stdout = '', stderr = '') =>
  ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } }) as never

/** Stands for `gh` beneath the mod: answers the search with `backlog`, takes every merge but the refused ones. */
const answerGh = (on: On, backlog: Given[] = BACKLOG, refused: string[] = [], origin = 'git@github.com:acme/web.git') => {
  const runs: (readonly string[])[] = []

  mock.clock(on, { now: 1000 })
  on('process.run', (_, e) => {
    // The repo's origin, which says the forge: read by git, and no request to a forge
    if (e.argv[0] === 'git') return exited(0, `${origin}\n`)

    runs.push(e.argv)

    const isSearch = e.argv[1] === 'api'
    const isRefused = refused.some(url => e.argv.includes(url))

    return {
      value: {
        exitCode: isRefused ? 1 : 0,
        stdout: isSearch ? JSON.stringify({ data: { search: { issueCount: backlog.length, nodes: backlog.map(node) } } }) : '',
        stderr: isRefused ? 'GraphQL: Head branch was modified. Review and try the merge again.' : '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    } as never
  })

  return runs
}

const mount = ($: Engine) =>
  $.ui.mount({ plugin: 'renovate-desk', surface: 'terminal', component: 'Pane', props: PANE as never, requestId: 'renovate-desk' })

const merges = (runs: (readonly string[])[]) => runs.filter(argv => argv[1] === 'pr' || argv[1] === 'mr').map(argv => argv.join(' '))

type Mr = { project: string; iid: number; title: string; description?: string; pipeline?: string | null; status?: string; draft?: boolean; conflicts?: boolean; squash?: boolean }

const mr = ({ project, iid, title, description = '', pipeline = 'SUCCESS', status = 'MERGEABLE', draft = false, conflicts = false, squash = false }: Mr) => ({
  iid: String(iid),
  title,
  webUrl: `https://gitlab.com/${project}/-/merge_requests/${iid}`,
  description,
  draft,
  conflicts,
  detailedMergeStatus: status,
  diffHeadSha: `head${iid}`,
  squashOnMerge: squash,
  headPipeline: pipeline === null ? null : { status: pipeline },
  project: { fullPath: project },
})

const GITLAB_BACKLOG: Mr[] = [
  { project: 'acme/tools/api', iid: 7, title: 'Update dependency zod to v3.23.8', description: '| zod | `3.23.0` -> `3.23.8` |', squash: true },
  { project: 'acme/web', iid: 12, title: 'chore(deps): update dependency vite to v5.4.0', description: '| vite | devDependencies | minor | `5.3.1` -> `5.4.0` |' },
  { project: 'acme/web', iid: 13, title: 'Update dependency react to v19', description: '| react | `18.3.1` -> `19.0.0` |' },
  { project: 'acme/web', iid: 14, title: 'Update dependency eslint to v9.1.1', description: '| eslint | `9.1.0` -> `9.1.1` |', pipeline: 'FAILED', status: 'CI_MUST_PASS' },
  { project: 'acme/web', iid: 15, title: 'Update dependency pg to v8.12.0', description: '| pg | `8.11.0` -> `8.12.0` |', pipeline: 'RUNNING', status: 'CI_STILL_RUNNING' },
  { project: 'acme/web', iid: 16, title: 'Update dependency ws to v8.18.1', description: '| ws | `8.18.0` -> `8.18.1` |', status: 'NEED_REBASE' },
  { project: 'acme/web', iid: 17, title: 'Update dependency ky to v1.7.5', description: '| ky | `1.7.4` -> `1.7.5` |', status: 'NOT_APPROVED' },
  { project: 'acme/web', iid: 18, title: 'Update dependency ms to v2.1.3', description: '| ms | `2.1.2` -> `2.1.3` |', status: 'DISCUSSIONS_NOT_RESOLVED' },
  { project: 'acme/web', iid: 19, title: 'Update dependency he to v1.2.1', description: '| he | `1.2.0` -> `1.2.1` |', pipeline: null, status: 'CI_MUST_PASS' },
]

/** Stands for `glab` beneath the mod, in a repo whose origin is on GitLab unless another is given. */
const answerGlab = (on: On, given: { backlog?: Mr[]; refused?: number[]; origin?: string; user?: boolean } = {}) => {
  const { backlog = GITLAB_BACKLOG, refused = [], origin = 'git@gitlab.com:acme/web.git', user = true } = given
  const runs: (readonly string[])[] = []

  mock.clock(on, { now: 1000 })
  on('process.run', (_, e) => {
    if (e.argv[0] === 'git') return exited(0, `${origin}\n`)

    runs.push(e.argv)

    if (e.argv[1] === 'api') {
      return exited(0, JSON.stringify({ data: { user: user ? { authoredMergeRequests: { count: backlog.length, nodes: backlog.map(mr) } } : null } }))
    }

    return refused.includes(Number(e.argv[3])) ? exited(1, '', 'ERROR: SHA does not match HEAD of source branch') : exited(0)
  })

  return runs
}

describe('renovate-desk', () => {
  test('asks GitHub nothing until the person asks', async ($, on) => {
    const runs = answerGh(on)
    const pane = await mount($)

    expect(await pane.find({ text: /Press Refresh to ask GitHub/ })).toBeDefined()
    expect(runs).toHaveLength(0)
  })

  test('sorts the pull requests into safe, waiting and to look at, in one request', async ($, on) => {
    const runs = answerGh(on)
    const pane = await mount($)

    await pane.press({ key: 'refresh' })

    expect(await pane.find({ text: /2 safe · 1 waiting · 2 to look at/ })).toBeDefined()
    expect(await pane.find({ text: /safe · patch/ })).toBeDefined()
    expect(await pane.find({ text: /safe · minor/ })).toBeDefined()
    expect(await pane.find({ text: /major update/ })).toBeDefined()
    expect(await pane.find({ text: /checks failing/ })).toBeDefined()
    expect(await pane.find({ text: /checks running/ })).toBeDefined()
    expect(runs).toHaveLength(1)
    expect(runs[0]!.join(' ')).toContain('q=is:pr is:open archived:false author:app/renovate user:@me')
  })

  test('one press merges the safe ones only, each pinned to the commit that was judged', async ($, on) => {
    const runs = answerGh(on)
    const pane = await mount($)

    await pane.press({ key: 'refresh' })
    await pane.press({ key: 'merge-safe' })

    expect(merges(runs)).toEqual([
      'gh pr merge https://github.com/acme/api/pull/7 --squash --match-head-commit head7',
      'gh pr merge https://github.com/acme/web/pull/12 --squash --match-head-commit head12',
    ])
    expect(await pane.find({ text: /0 safe · 1 waiting · 2 to look at/ })).toBeDefined()
    expect(await pane.find({ text: /merged acme\/api#7/ })).toBeDefined()
  })

  test('writes nothing on GitHub but merges: no comment, no review, no second search', async ($, on) => {
    const runs = answerGh(on)
    const pane = await mount($)

    await pane.press({ key: 'refresh' })
    await pane.press({ key: 'merge-safe' })

    expect(runs.filter(argv => argv[1] === 'api')).toHaveLength(1)
    expect(runs.every(argv => argv[1] === 'api' || (argv[1] === 'pr' && argv[2] === 'merge'))).toBe(true)
  })

  test('a major update is merged only by its own button', async ($, on) => {
    const runs = answerGh(on)
    const pane = await mount($)

    await pane.press({ key: 'refresh' })
    await pane.press({ key: 'merge-acme/web#13' })

    expect(merges(runs)).toEqual(['gh pr merge https://github.com/acme/web/pull/13 --squash --match-head-commit head13'])
  })

  test('a merge GitHub refuses is left for the person and the rest still go', async ($, on) => {
    const runs = answerGh(on, BACKLOG, ['https://github.com/acme/api/pull/7'])
    const pane = await mount($)

    await pane.press({ key: 'refresh' })
    await pane.press({ key: 'merge-safe' })

    expect(merges(runs)).toHaveLength(2)
    expect(await pane.find({ text: /acme\/api#7 not merged: GraphQL: Head branch was modified/ })).toBeDefined()
    expect(await pane.find({ text: /merge refused/ })).toBeDefined()
    expect(await pane.find({ text: /0 safe/ })).toBeDefined()
  })

  test('says why when gh fails', async ($, on) => {
    mock.clock(on, { now: 1000 })
    on('process.run', () => ({ value: { exitCode: 4, stdout: '', stderr: 'gh: To get started with GitHub CLI, please run: gh auth login\n' } }) as never)

    const pane = await mount($)

    await pane.press({ key: 'refresh' })

    expect(await pane.find({ text: /gh auth login/ })).toBeDefined()
  })

  test('looks where the option says', { options: { query: 'author:app/renovate org:acme' } }, async ($, on) => {
    const runs = answerGh(on)
    const pane = await mount($)

    await pane.press({ key: 'refresh' })

    expect(runs[0]!.join(' ')).toContain('archived:false author:app/renovate org:acme')
  })

  test('the command opens the pane, asks GitHub and answers the counts', async ($, on) => {
    answerGh(on)
    on('ui.open', () => ({ value: { isPlaced: true } }) as never)

    const answer = await $.command.run({ command: 'renovate', args: '' } as never)

    expect(JSON.stringify(answer)).toContain('2 safe to merge, 1 waiting, 2 to look at')
  })

  test('hands the model what the pane shows, as text', async ($, on) => {
    answerGh(on)

    const pane = await mount($)

    await pane.press({ key: 'refresh' })

    const { result } = await $.tool.call({ tool: 'mcp__renovate-desk__pane' } as never)

    expect(result).toMatch(/2 safe · 1 waiting · 2 to look at/)
    expect(result).toMatch(/acme\/web#13/)
    expect(result).toMatch(/Merge 2 safe/)
  })

  test('in a repo on GitLab it asks glab, in one request, for the merge requests of the user Renovate runs as', async ($, on) => {
    const runs = answerGlab(on)
    const pane = await mount($)

    await pane.press({ key: 'refresh' })

    expect(runs).toHaveLength(1)
    expect(runs[0]!.slice(0, 3)).toEqual(['glab', 'api', 'graphql'])
    expect(runs[0]!.at(-1)).toBe('author=renovate-bot')
    expect(await pane.find({ text: /2 safe · 2 waiting · 5 to look at/ })).toBeDefined()
    expect(await pane.find({ text: /Merge request/ })).toBeDefined()
    expect(await pane.find({ text: /acme\/tools\/api!7/ })).toBeDefined()
    expect(await pane.find({ text: /major update/ })).toBeDefined()
    expect(await pane.find({ text: /checks failing/ })).toBeDefined()
    expect(await pane.find({ text: /checks running/ })).toBeDefined()
    expect(await pane.find({ text: /behind, Renovate rebases it/ })).toBeDefined()
    expect(await pane.find({ text: /needs a review/ })).toBeDefined()
    expect(await pane.find({ text: /discussions not resolved/ })).toBeDefined()
    expect(await pane.find({ text: /a pipeline must pass/ })).toBeDefined()
  })

  test('on GitLab one press merges the safe ones only, now or not at all, each pinned to the commit that was judged', async ($, on) => {
    const runs = answerGlab(on)
    const pane = await mount($)

    await pane.press({ key: 'refresh' })
    await pane.press({ key: 'merge-safe' })

    expect(merges(runs)).toEqual([
      'glab mr merge 7 --repo acme/tools/api --sha head7 --auto-merge=false --yes --squash',
      'glab mr merge 12 --repo acme/web --sha head12 --auto-merge=false --yes',
    ])
    expect(runs.every(argv => argv[0] === 'glab' && (argv[1] === 'api' || (argv[1] === 'mr' && argv[2] === 'merge')))).toBe(true)
    expect(await pane.find({ text: /0 safe · 2 waiting · 5 to look at/ })).toBeDefined()
    expect(await pane.find({ text: /merged acme\/tools\/api!7/ })).toBeDefined()
  })

  test('on GitLab a major update is merged only by its own button, and a merge glab refuses is left for the person', async ($, on) => {
    const runs = answerGlab(on, { refused: [13] })
    const pane = await mount($)

    await pane.press({ key: 'refresh' })
    await pane.press({ key: 'merge-acme/web!13' })

    expect(merges(runs)).toEqual(['glab mr merge 13 --repo acme/web --sha head13 --auto-merge=false --yes'])
    expect(await pane.find({ text: /acme\/web!13 not merged: ERROR: SHA does not match HEAD/ })).toBeDefined()
    expect(await pane.find({ text: /merge refused/ })).toBeDefined()
  })

  test('the forge option settles it whatever the repo is on, and the username option says whose merge requests', { options: { forge: 'gitlab', gitlabAuthor: 'acme-renovate' } }, async ($, on) => {
    const runs = answerGlab(on, { origin: 'https://code.acme.dev/acme/web.git' })
    const pane = await mount($)

    expect(await pane.find({ text: /Press Refresh to ask GitLab/ })).toBeDefined()

    await pane.press({ key: 'refresh' })

    expect(runs[0]![0]).toBe('glab')
    expect(runs[0]!.at(-1)).toBe('author=acme-renovate')
  })

  test('a repo on GitLab is still asked on GitHub when the option says so', { options: { forge: 'github' } }, async ($, on) => {
    const runs = answerGh(on, BACKLOG, [], 'git@gitlab.com:acme/web.git')
    const pane = await mount($)

    await pane.press({ key: 'refresh' })

    expect(runs[0]![0]).toBe('gh')
    expect(await pane.find({ text: /2 safe · 1 waiting · 2 to look at/ })).toBeDefined()
  })

  test('says so when GitLab knows nobody by the username', async ($, on) => {
    answerGlab(on, { user: false })
    on('ui.open', () => ({ value: { isPlaced: true } }) as never)

    const answer = await $.command.run({ command: 'renovate', args: '' } as never)

    expect(JSON.stringify(answer)).toContain('could not ask GitLab: GitLab knows no user by that name')
  })

  test('reads the kind of an update off what Renovate wrote', () => {
    expect(kindOf('Update dependency a to v2', '')).toBe('major')
    expect(kindOf('Update dependency a to v1.2.3', '')).toBe('unknown')
    expect(kindOf('Update a', '| a | `1.2.3` → `1.2.4` |\n| b | `1.0.0` → `2.0.0` |')).toBe('major')
    expect(kindOf('Update a', '| a | dependencies | patch | `1.2.3` -> `1.2.4` |')).toBe('patch')
    expect(kindOf('Lock file maintenance', '')).toBe('lockfile')
    expect(kindOf('Update actions/checkout digest to abc1234', '')).toBe('digest')
  })
})
