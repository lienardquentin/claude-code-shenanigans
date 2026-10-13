import type { Bucket, Kind, MergeMethod, Pr } from '../types'
import type { Forge } from './kit/forge'

// Everything the pane needs, in one request per refresh: the mod never asks the forge about a pull request by itself
export const QUERY =
  'query($q:String!){search(query:$q,type:ISSUE,first:100){issueCount nodes{...on PullRequest{number title url body isDraft mergeable reviewDecision headRefOid repository{nameWithOwner viewerDefaultMergeMethod} commits(last:1){nodes{commit{statusCheckRollup{state}}}}}}}}'

// GitLab has no search across projects that answers all of this: the open merge requests of Renovate's own user do
export const GITLAB_QUERY =
  'query($author:String!){user(username:$author){authoredMergeRequests(state:opened,first:100){count nodes{iid title webUrl description draft conflicts detailedMergeStatus diffHeadSha squashOnMerge headPipeline{status} project{fullPath}}}}}'

/** Where to look: search qualifiers on GitHub, the username Renovate runs as on GitLab. */
export type Where = { query: string; author: string }

export const searchArgv = (forge: Forge, where: Where): string[] =>
  forge.id === 'gitlab'
    ? ['glab', 'api', 'graphql', '-f', `query=${GITLAB_QUERY}`, '-f', `author=${where.author}`]
    : ['gh', 'api', 'graphql', '-f', `query=${QUERY}`, '-f', `q=is:pr is:open archived:false ${where.query}`]

// The head commit is pinned: a pull request Renovate pushed to since the refresh is not the one that was judged.
// GitLab is told to merge now or not at all: left to itself it waits for a pipeline and merges what is there then
export const mergeArgv = (pr: Pr): string[] =>
  pr.forge === 'gitlab'
    ? [
        'glab',
        'mr',
        'merge',
        String(pr.number),
        '--repo',
        pr.repo,
        '--sha',
        pr.head,
        '--auto-merge=false',
        '--yes',
        ...(pr.method === 'squash' ? ['--squash'] : []),
      ]
    : ['gh', 'pr', 'merge', pr.url, `--${pr.method}`, '--match-head-commit', pr.head]

type Node = {
  number?: number
  title?: string
  url?: string
  body?: string
  isDraft?: boolean
  mergeable?: string
  reviewDecision?: string | null
  headRefOid?: string
  repository?: { nameWithOwner?: string; viewerDefaultMergeMethod?: string }
  commits?: { nodes?: { commit?: { statusCheckRollup?: { state?: string } | null } }[] }
}

type GitlabNode = {
  iid?: string | number
  title?: string
  webUrl?: string
  description?: string | null
  draft?: boolean
  conflicts?: boolean
  detailedMergeStatus?: string | null
  diffHeadSha?: string | null
  squashOnMerge?: boolean
  headPipeline?: { status?: string } | null
  project?: { fullPath?: string }
}

const NAMED: Record<string, Kind> = {
  major: 'major',
  minor: 'minor',
  patch: 'patch',
  digest: 'digest',
  pin: 'pin',
  pinDigest: 'pin',
  lockFileMaintenance: 'lockfile',
}

const major = (version: string) => Number(/\d+/.exec(version)?.[0] ?? Number.NaN)

/** What kind of update a pull request is, read off what Renovate wrote: the worst of the updates it groups. */
export const kindOf = (title: string, body: string): Kind => {
  // The Update column of Renovate's table, where the preset has one
  const named = [...body.matchAll(/\|\s*(major|minor|patch|digest|pinDigest|pin|lockFileMaintenance)\s*\|/g)].map(m => NAMED[m[1]!]!)

  if (named.includes('major')) return 'major'
  if (named.length > 0) return named[0]!

  // The Change column: `1.2.3` -> `1.3.0`
  const changes = [...body.matchAll(/`v?(\d[^`\s]*)`\s*(?:->|→)\s*`v?(\d[^`\s]*)`/g)]

  if (changes.some(m => major(m[1]!) !== major(m[2]!))) return 'major'
  if (changes.length > 0) return changes.every(m => m[1]!.split('.')[1] === m[2]!.split('.')[1]) ? 'patch' : 'minor'

  if (/lock file maintenance/i.test(title)) return 'lockfile'
  if (/\bdigest\b/i.test(title)) return 'digest'
  if (/^(chore\(deps[^)]*\):\s*)?pin\b/i.test(title)) return 'pin'
  // "to v5" names a major alone; a full version in a title does not say what it came from
  if (/\bto v?\d+$/i.test(title.trim())) return 'major'

  return 'unknown'
}

const METHODS: Record<string, MergeMethod> = { SQUASH: 'squash', MERGE: 'merge', REBASE: 'rebase' }

// A request as either forge tells it, in the words it is judged in
type Seen = {
  isDraft: boolean
  /** Whether the forge would take a merge; `blocked` is anything else in the way, said in `why`. */
  state: 'ready' | 'conflicts' | 'behind' | 'checking' | 'blocked'
  why?: string
  checks: 'pass' | 'running' | 'failing' | 'none'
  review: 'fine' | 'changes' | 'required'
}

const judge = (seen: Seen, kind: Kind, forge: Forge): { bucket: Bucket; reason: string; canMerge: boolean } => {
  if (seen.isDraft) return { bucket: 'look', reason: 'draft', canMerge: false }
  // Renovate rebases its own branches: nothing to do, and nothing to ask it
  if (seen.state === 'conflicts') return { bucket: 'waiting', reason: 'conflicts, Renovate rebases it', canMerge: false }
  if (seen.state === 'behind') return { bucket: 'waiting', reason: 'behind, Renovate rebases it', canMerge: false }
  if (seen.state === 'checking') return { bucket: 'waiting', reason: `${forge.name} is still checking`, canMerge: false }
  if (seen.checks === 'running') return { bucket: 'waiting', reason: 'checks running', canMerge: false }
  if (seen.checks === 'failing') return { bucket: 'look', reason: 'checks failing', canMerge: false }
  if (seen.review === 'changes') return { bucket: 'look', reason: 'changes requested', canMerge: false }
  if (seen.review === 'required') return { bucket: 'look', reason: 'needs a review', canMerge: false }
  if (seen.state === 'blocked') return { bucket: 'look', reason: seen.why ?? 'blocked', canMerge: false }
  if (seen.checks !== 'pass') return { bucket: 'look', reason: 'no checks ran', canMerge: true }
  if (kind === 'major') return { bucket: 'look', reason: 'major update', canMerge: true }
  if (kind === 'unknown') return { bucket: 'look', reason: 'unknown kind of update', canMerge: true }

  return { bucket: 'safe', reason: 'checks pass', canMerge: true }
}

const seenOnGithub = (node: Node): Seen => {
  const checks = node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state

  return {
    isDraft: node.isDraft === true,
    state: node.mergeable === 'CONFLICTING' ? 'conflicts' : node.mergeable === 'MERGEABLE' ? 'ready' : 'checking',
    checks: checks === 'PENDING' || checks === 'EXPECTED' ? 'running' : checks === 'FAILURE' || checks === 'ERROR' ? 'failing' : checks === 'SUCCESS' ? 'pass' : 'none',
    review: node.reviewDecision === 'CHANGES_REQUESTED' ? 'changes' : node.reviewDecision === 'REVIEW_REQUIRED' ? 'required' : 'fine',
  }
}

// A pipeline that has not ended, and one that ended badly, as GitLab names their states
const RUNNING = ['CREATED', 'WAITING_FOR_RESOURCE', 'WAITING_FOR_CALLBACK', 'PREPARING', 'PENDING', 'RUNNING', 'SCHEDULED']
const FAILING = ['FAILED', 'CANCELED', 'CANCELING']
// The merge states that say nothing the other fields do not: the draft, the pipeline and the approvals have theirs
const SAID_ELSEWHERE = ['MERGEABLE', 'DRAFT_STATUS', 'CI_STILL_RUNNING', 'REQUESTED_CHANGES', 'NOT_APPROVED']
const UNSETTLED = ['', 'UNCHECKED', 'CHECKING', 'PREPARING', 'APPROVALS_SYNCING']

const seenOnGitlab = (node: GitlabNode): Seen => {
  const status = (node.detailedMergeStatus ?? '').toUpperCase()
  const pipeline = (node.headPipeline?.status ?? '').toUpperCase()
  const checks: Seen['checks'] =
    RUNNING.includes(pipeline) || status === 'CI_STILL_RUNNING' ? 'running' : FAILING.includes(pipeline) ? 'failing' : pipeline === 'SUCCESS' ? 'pass' : 'none'
  const given = {
    isDraft: node.draft === true || status === 'DRAFT_STATUS',
    checks,
    review: (status === 'REQUESTED_CHANGES' ? 'changes' : status === 'NOT_APPROVED' ? 'required' : 'fine') as Seen['review'],
  }

  if (node.conflicts === true || status === 'CONFLICT') return { ...given, state: 'conflicts' }
  if (status === 'NEED_REBASE') return { ...given, state: 'behind' }
  if (UNSETTLED.includes(status)) return { ...given, state: 'checking' }
  // The project wants a pipeline that passed: one that runs or failed says so by itself, none at all does not
  if (status === 'CI_MUST_PASS') {
    return checks === 'running' || checks === 'failing' ? { ...given, state: 'ready' } : { ...given, state: 'blocked', why: 'a pipeline must pass' }
  }
  if (SAID_ELSEWHERE.includes(status)) return { ...given, state: 'ready' }

  return { ...given, state: 'blocked', why: status.toLowerCase().replaceAll('_', ' ').replace(/ status$/, '') }
}

const ORDER: Record<Bucket, number> = { safe: 0, look: 1, waiting: 2 }

const sorted = (prs: Pr[]): Pr[] => prs.sort((a, b) => ORDER[a.bucket] - ORDER[b.bucket] || a.id.localeCompare(b.id))

const parseGithub = (stdout: string, forge: Forge): { prs: Pr[]; total: number } => {
  const search = (JSON.parse(stdout) as { data?: { search?: { issueCount?: number; nodes?: Node[] } } }).data?.search

  if (search === undefined) throw new Error('GitHub answered no search result')

  const prs = (search.nodes ?? [])
    .filter(node => node.url !== undefined && node.number !== undefined)
    .map((node): Pr => {
      const title = node.title ?? ''
      const kind = kindOf(title, node.body ?? '')
      const repo = node.repository?.nameWithOwner ?? '?'

      return {
        id: `${repo}#${node.number}`,
        forge: 'github',
        repo,
        number: node.number!,
        title,
        url: node.url!,
        kind,
        head: node.headRefOid ?? '',
        method: METHODS[node.repository?.viewerDefaultMergeMethod ?? ''] ?? 'squash',
        ...judge(seenOnGithub(node), kind, forge),
      }
    })

  return { prs: sorted(prs), total: search.issueCount ?? prs.length }
}

const parseGitlab = (stdout: string, forge: Forge): { prs: Pr[]; total: number } => {
  const answer = JSON.parse(stdout) as {
    data?: { user?: { authoredMergeRequests?: { count?: number; nodes?: GitlabNode[] } } | null }
    errors?: { message?: string }[]
  }

  if (!answer.data) throw new Error(answer.errors?.[0]?.message ?? 'GitLab answered no merge requests')
  // An answer with no user in it is how GitLab says the username is nobody's
  if (!answer.data.user) throw new Error('GitLab knows no user by that name: set the username Renovate runs as')

  const found = answer.data.user.authoredMergeRequests
  const prs = (found?.nodes ?? [])
    .filter(node => node.webUrl !== undefined && node.iid !== undefined && node.project?.fullPath !== undefined)
    .map((node): Pr => {
      const title = node.title ?? ''
      const kind = kindOf(title, node.description ?? '')
      const repo = node.project!.fullPath!

      return {
        id: `${repo}!${node.iid}`,
        forge: 'gitlab',
        repo,
        number: Number(node.iid),
        title,
        url: node.webUrl!,
        kind,
        head: node.diffHeadSha ?? '',
        method: node.squashOnMerge === true ? 'squash' : 'merge',
        ...judge(seenOnGitlab(node), kind, forge),
      }
    })

  return { prs: sorted(prs), total: found?.count ?? prs.length }
}

/** The pull requests of a search answer, the safe ones first; throws on an answer that is not one. */
export const parse = (stdout: string, forge: Forge): { prs: Pr[]; total: number } =>
  forge.id === 'gitlab' ? parseGitlab(stdout, forge) : parseGithub(stdout, forge)

/** A title without the words every Renovate title starts with. */
export const shortTitle = (title: string) =>
  title.replace(/^[a-z]+\(deps[^)]*\):\s*/i, '').replace(/^update (dependency )?/i, '')
