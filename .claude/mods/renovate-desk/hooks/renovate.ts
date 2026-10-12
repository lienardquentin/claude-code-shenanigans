import type { Bucket, Kind, MergeMethod, Pr } from '../types'

// Everything the pane needs, in one request per refresh: the mod never asks GitHub about a pull request by itself
export const QUERY =
  'query($q:String!){search(query:$q,type:ISSUE,first:100){issueCount nodes{...on PullRequest{number title url body isDraft mergeable reviewDecision headRefOid repository{nameWithOwner viewerDefaultMergeMethod} commits(last:1){nodes{commit{statusCheckRollup{state}}}}}}}}'

export const searchArgv = (query: string): string[] => [
  'gh',
  'api',
  'graphql',
  '-f',
  `query=${QUERY}`,
  '-f',
  `q=is:pr is:open archived:false ${query}`,
]

// The head commit is pinned: a pull request Renovate pushed to since the refresh is not the one that was judged
export const mergeArgv = (pr: Pr): string[] => ['gh', 'pr', 'merge', pr.url, `--${pr.method}`, '--match-head-commit', pr.head]

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

const judge = (node: Node, kind: Kind): { bucket: Bucket; reason: string; canMerge: boolean } => {
  const checks = node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state

  if (node.isDraft) return { bucket: 'look', reason: 'draft', canMerge: false }
  // Renovate rebases its own branches: nothing to do, and nothing to ask it
  if (node.mergeable === 'CONFLICTING') return { bucket: 'waiting', reason: 'conflicts, Renovate rebases it', canMerge: false }
  if (node.mergeable !== 'MERGEABLE') return { bucket: 'waiting', reason: 'GitHub is still checking', canMerge: false }
  if (checks === 'PENDING' || checks === 'EXPECTED') return { bucket: 'waiting', reason: 'checks running', canMerge: false }
  if (checks === 'FAILURE' || checks === 'ERROR') return { bucket: 'look', reason: 'checks failing', canMerge: false }
  if (node.reviewDecision === 'CHANGES_REQUESTED') return { bucket: 'look', reason: 'changes requested', canMerge: false }
  if (node.reviewDecision === 'REVIEW_REQUIRED') return { bucket: 'look', reason: 'needs a review', canMerge: false }
  if (checks !== 'SUCCESS') return { bucket: 'look', reason: 'no checks ran', canMerge: true }
  if (kind === 'major') return { bucket: 'look', reason: 'major update', canMerge: true }
  if (kind === 'unknown') return { bucket: 'look', reason: 'unknown kind of update', canMerge: true }

  return { bucket: 'safe', reason: 'checks pass', canMerge: true }
}

const ORDER: Record<Bucket, number> = { safe: 0, look: 1, waiting: 2 }

/** The pull requests of a search answer, the safe ones first; throws on an answer that is not one. */
export const parse = (stdout: string): { prs: Pr[]; total: number } => {
  const search = (JSON.parse(stdout) as { data?: { search?: { issueCount?: number; nodes?: Node[] } } }).data?.search

  if (search === undefined) throw new Error('GitHub answered no search result')

  const prs = (search.nodes ?? [])
    .filter(node => node.url !== undefined && node.number !== undefined)
    .map((node): Pr => {
      const title = node.title ?? ''
      const kind = kindOf(title, node.body ?? '')

      return {
        id: `${node.repository?.nameWithOwner ?? '?'}#${node.number}`,
        title,
        url: node.url!,
        kind,
        head: node.headRefOid ?? '',
        method: METHODS[node.repository?.viewerDefaultMergeMethod ?? ''] ?? 'squash',
        ...judge(node, kind),
      }
    })
    .sort((a, b) => ORDER[a.bucket] - ORDER[b.bucket] || a.id.localeCompare(b.id))

  return { prs, total: search.issueCount ?? prs.length }
}

/** A title without the words every Renovate title starts with. */
export const shortTitle = (title: string) =>
  title.replace(/^[a-z]+\(deps[^)]*\):\s*/i, '').replace(/^update (dependency )?/i, '')
