// Everything the workflow asks of a repository's forge, GitHub through `gh` or GitLab through `glab`, and how each
// CLI's answer reads. Nothing here touches the engine: commands run through the Shell a caller hands over, so the
// same code serves the mod and a runner outside Claude Code.

export type ForgeKind = 'github' | 'gitlab'

/** A repository on a forge: `server` is its host, `repo` its path (`owner/name`, or `group/sub/project` on GitLab). */
export type Repo = { forge: ForgeKind; server: string; repo: string }

/** An issue of a repository. */
export type IssueRef = Repo & { number: number }

/** A command's end: its exit code and what it wrote. */
export type Ran = { exitCode: number; stdout: string; stderr: string }

/**
 * Runs a command in the folder it was made for. It never rejects: a command that could not be started answers a
 * non-zero exit code and why on stderr.
 */
export type Shell = { run: (argv: readonly string[], options?: { timeoutMs?: number }) => Promise<Ran> }

/** An open issue as a list of them gives it. */
export type IssueSummary = { number: number; title: string; url: string; labels: string[]; author: string; updatedAt: string; body: string }

/**
 * An issue read whole: who opened it, and whether from outside the repository (one who cannot push to it); its
 * thread, the comments from outside left out and counted.
 */
export type Issue = {
  title: string
  body: string
  url: string
  state: string
  labels: string[]
  author: string
  isOutside: boolean
  comments: { author: string; body: string }[]
  leftOut: number
}

/**
 * What tells who is trusted on an issue: on GitHub, each author's association with the repository (the issue's own
 * given apart where the answer holds none); on GitLab, the people who can push to the project.
 */
export type Trust = { association?: string; pushers?: readonly string[] }

/** A pull request (a merge request on GitLab) as the forge says it stands. */
export type PullState = { isMerged: boolean; isConflicting: boolean; branch: string; head: string }

/** A pull request as its review is read. */
export type PullRequest = { forge: ForgeKind; repo: string; number: number; url: string; isFork?: boolean; title: string; branch: string; base: string }

/**
 * A review comment: an open thread, or a review's own words. `said` is what its first comment says, `replies` how
 * many replies from inside the repository it holds, and `leftOut` how many from outside were dropped.
 */
export type ReviewComment = { id: string; author: string; path: string; line: number; body: string; said?: string; replies?: number; leftOut?: number; url: string; thread?: string; isOutside?: boolean }

/** A pull request's open review, and what of it could not be read. */
export type Review = { pr: PullRequest; comments: ReviewComment[]; unread: string[] }

/** A check that fails on a pull request: its name, where to see it, and the end of its log, as data. */
export type FailingCheck = { name: string; url: string; log: string }

// How much of a failing check's log is kept: its end, where a failure says itself
const LOG_TAIL = 3_000

const tailOf = (log: string): string => (log.length > LOG_TAIL ? `…${log.slice(-LOG_TAIL)}` : log).trim()

/** A pull request to open from a branch onto another. */
export type NewRequest = { branch: string; base: string; title: string; body: string }

/** The calls the workflow makes of a forge. Each answers why, in a sentence, where the forge could not be asked. */
export type Forge = {
  kind: ForgeKind
  /** The CLI it is reached through. */
  cli: 'gh' | 'glab'
  /** The repository's open issues, the most recently updated first. */
  listIssues: (repo: Repo) => Promise<IssueSummary[] | string>
  /** An issue and its thread, through the CLI, else the REST API. `origin` is the repository the work is in. */
  readIssue: (ref: IssueRef, origin?: Repo) => Promise<Issue | string>
  /** Where a pull request stands, by its URL. */
  pullState: (url: string) => Promise<PullState | string>
  /** The URL of the pull request merged from a branch; nothing when there is none, or the forge could not say. */
  mergedFrom: (branch: string) => Promise<string>
  /** The number of the open pull request of the branch checked out. */
  currentRequest: () => Promise<number | string>
  /** A pull request's open review comments. */
  readReview: (repo: string, number: number) => Promise<Review | string>
  /** Opens a pull request from a branch already pushed: its URL. */
  openRequest: (request: NewRequest) => Promise<{ url: string } | string>
  /** The checks that fail on a pull request (GitHub checks, the jobs of a GitLab merge request's last pipeline), each with the end of its log where the forge gave it. */
  failingChecks: (repo: string, number: number) => Promise<FailingCheck[] | string>
  /** Opens an issue in a repository: its URL and number. */
  openIssue: (repo: Repo, title: string, body: string) => Promise<{ url: string; number: number } | string>
  /** Replies to a review thread of pull request `number` in the repository the shell runs in. */
  replyToThread: (number: number, thread: string, reply: string) => Promise<Ran>
  /** Marks a review thread resolved. */
  resolveThread: (number: number, thread: string) => Promise<Ran>
}

// How long the forge is given to answer: a read, and a review or a pull request opened, which take longer
const READ_TIMEOUT_MS = 60_000
const SLOW_TIMEOUT_MS = 120_000

// How many open issues are listed at most
export const ISSUE_LIMIT = 50

// What the planner is handed of an issue at most is cut later; the forge is asked for up to 100 comments or members
const PAGE = 100

// How many of each a review is read to at most: a pull request holding more is read in part, and says so
const MAX_THREADS = 100
const MAX_NOTES = 30
const MAX_REVIEWS = 50

/** Who a GitHub issue or comment is trusted from: one who can push to the repository. */
export const TRUSTED_ASSOCIATIONS: readonly string[] = ['OWNER', 'MEMBER', 'COLLABORATOR']

// The least GitLab access that can push: Developer
const GITLAB_DEVELOPER = 30

const text = (value: unknown): string => (typeof value === 'string' ? value : '')
const trimmed = (value: unknown): string => text(value).trim()
const record = (value: unknown): Record<string, unknown> => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {})
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const lastLine = (said: string): string => said.trim().split('\n').filter(line => line.trim() !== '').slice(-1)[0] ?? ''

const readJson = (answer: string): unknown => {
  try {
    return JSON.parse(answer) as unknown
  } catch {
    return undefined
  }
}

/** The forge a host is: GitLab where its name says so, GitHub otherwise (github.com, or an Enterprise host). */
export const forgeOfHost = (host: string): ForgeKind => (host.toLowerCase().includes('gitlab') ? 'gitlab' : 'github')

/** The forge a pull request is on, by its URL: its path says so where it can, else its host. */
export const forgeOfUrl = (url: string): ForgeKind =>
  /\/-\/merge_requests\/\d+/.test(url) ? 'gitlab' : /\/pull\/\d+/.test(url) ? 'github' : forgeOfHost(/^[a-z+]+:\/\/(?:[^@/]+@)?([^/:]+)/i.exec(url)?.[1] ?? url)

/** The repository a git remote URL names: `git@host:path.git`, `https://host/path.git`, `ssh://git@host:2222/path.git`. */
export const parseRemote = (url: string): Repo | undefined => {
  const said = url.trim()
  const scp = /^[\w.-]+@([^:/]+):(?!\d+\/)(.+?)(?:\.git)?\/?$/.exec(said)
  const full = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^:/]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/.exec(said)
  const found = scp ?? full

  if (found === null) return undefined

  const server = found[1] ?? ''
  const repo = found[2] ?? ''

  return repo.includes('/') ? { forge: forgeOfHost(server), server, repo } : undefined
}

/**
 * The issue a person or Claude named: a URL on either forge, `gh:`/`gl:` and a path with `#n`, a path with `#n` (on the
 * origin's forge when it shares its host's kind, else GitHub), or a bare `#n` or `n` on the origin itself. Says why in a
 * sentence when it names none, for the caller to add how to name one.
 */
export const parseIssueRef = (input: string, origin?: Repo): IssueRef | string => {
  const said = input.trim()

  if (said === '') return 'No issue is named.'

  const url = /^https?:\/\/([^/]+)\/(.+?)\/(-\/)?(?:issues|work_items)\/(\d+)(?:[/?#].*)?$/.exec(said)

  if (url !== null) {
    const server = url[1] ?? ''
    // GitLab's issues sit under `/-/`; a host without it is a GitHub, self-hosted or not
    const forge: ForgeKind = url[3] !== undefined || server.includes('gitlab') ? 'gitlab' : 'github'

    return { forge, server, repo: url[2] ?? '', number: Number(url[4]) }
  }

  const short = /^(?:(gh|github|gl|gitlab):)?([\w.-]+(?:\/[\w.-]+)+)#(\d+)$/.exec(said)

  if (short !== null) {
    const named = short[1]
    const forge: ForgeKind = named === undefined ? (origin?.forge ?? 'github') : named === 'gl' || named === 'gitlab' ? 'gitlab' : 'github'
    const path = (short[2] ?? '').split('/')
    // `gitlab:git.example.com/group/project#12`, as refText writes a self-hosted one: the host leads the path
    const isHosted = named !== undefined && path.length > 2 && (path[0] ?? '').includes('.')
    const server = isHosted ? (path[0] ?? '') : origin !== undefined && origin.forge === forge ? origin.server : forge === 'gitlab' ? 'gitlab.com' : 'github.com'

    return { forge, server, repo: (isHosted ? path.slice(1) : path).join('/'), number: Number(short[3]) }
  }

  const bare = /^#?(\d+)$/.exec(said)

  if (bare !== null) {
    if (origin === undefined) return `#${bare[1]} names an issue of this repository, whose git remote could not be read.`

    return { ...origin, number: Number(bare[1]) }
  }

  return `"${said}" names no issue.`
}

/** An issue written short, the key its plan is kept under: `github:owner/repo#12`, the host added when it is not the forge's own. */
export const refText = ({ forge, server, repo, number }: IssueRef): string => `${forge}:${server === `${forge}.com` ? '' : `${server}/`}${repo}#${number}`

/** The issue a ref names, as `refText` writes it: `github:owner/repo#12`, `gitlab:git.corp.io/g/p#3`. */
export const refOf = (ref: string): IssueRef | undefined => {
  const found = /^(github|gitlab):(.+)#(\d+)$/.exec(ref.trim())

  if (found === null) return undefined

  const forge = found[1] as ForgeKind
  const path = found[2] ?? ''
  const head = path.split('/')[0] ?? ''
  // A self-hosted forge is named by its host first, which a repository's owner never spells with a dot
  const isHosted = head.includes('.') && path.split('/').length > 2

  return { forge, server: isHosted ? head : `${forge}.com`, repo: isHosted ? path.slice(head.length + 1) : path, number: Number(found[3]) }
}

/**
 * The pull request named: a URL, `owner/repo#12`, `#12` or `12` on the origin's repository; `current` for none, the
 * branch's own; a sentence when it names none.
 */
export const parsePullRef = (input: string, origin?: Repo): { forge: ForgeKind; repo: string; number: number } | 'current' | string => {
  const said = input.trim()

  if (said === '') return 'current'

  const github = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(said)
  if (github !== null) return { forge: 'github', repo: github[1] ?? '', number: Number(github[2]) }

  const gitlab = /^https?:\/\/[^/]+\/(.+?)\/-\/merge_requests\/(\d+)/.exec(said)
  if (gitlab !== null) return { forge: 'gitlab', repo: gitlab[1] ?? '', number: Number(gitlab[2]) }

  const short = /^(?:([\w.-]+(?:\/[\w.-]+)+))?[#!]?(\d+)$/.exec(said)

  if (short !== null) {
    if (short[1] !== undefined) return { forge: origin?.forge ?? 'github', repo: short[1], number: Number(short[2]) }
    if (origin === undefined) return 'The origin remote could not be read: name the pull request by its URL.'

    return { forge: origin.forge, repo: origin.repo, number: Number(short[2]) }
  }

  return `"${said}" names no pull request: give its number, its URL, or nothing for this branch's own.`
}

/** Who can push to a GitLab project, from its `members/all` list; no one where the list does not read, so no one is trusted on a guess. */
export const gitlabPushers = (members: string): string[] =>
  list(readJson(members))
    .map(record)
    .filter(one => typeof one.access_level === 'number' && one.access_level >= GITLAB_DEVELOPER)
    .map(one => trimmed(one.username))

/** A label as either forge writes it: GitHub an object with its name, GitLab the name alone. */
const labelOf = (value: unknown): string => (typeof value === 'string' ? value : text(record(value).name))

/** The open issues a forge listed; nothing when the answer is no list. */
export const parseIssues = (answer: string): IssueSummary[] | undefined => {
  const listed = readJson(answer)

  if (!Array.isArray(listed)) return undefined

  return listed.flatMap(raw => {
    const one = record(raw)
    const number = Number(one.number ?? one.iid)

    if (!Number.isInteger(number) || number <= 0) return []

    const author = record(one.author)

    return [
      {
        number,
        title: text(one.title),
        url: text(one.url ?? one.web_url),
        labels: list(one.labels).map(labelOf).filter(label => label !== ''),
        author: text(author.login ?? author.username),
        updatedAt: text(one.updatedAt ?? one.updated_at),
        body: text(one.body ?? one.description).trim(),
      },
    ]
  })
}

const authorOf = (value: unknown): string => {
  const one = record(value)

  return text(one.login) || text(one.username) || text(one.name)
}

/** An author's association with the repository, as GitHub's CLI or its API spells it. */
const associationOf = (one: Record<string, unknown>): string => text(one.authorAssociation) || text(one.author_association)

/** Whether an author is trusted: one who can push to the repository, as the forge says. */
const isTrusted = (trust: Trust, author: string, association: string): boolean =>
  trust.pushers !== undefined ? author !== '' && trust.pushers.includes(author) : TRUSTED_ASSOCIATIONS.includes(association.toUpperCase())

/** A comment as any of the four answers spell it; a GitLab system note (`changed the label`) is none. */
const commentOf = (value: unknown): (Issue['comments'][number] & { association: string }) | undefined => {
  const one = record(value)

  if (one.system === true) return undefined

  const body = text(one.body)

  return body.trim() === '' ? undefined : { author: authorOf(one.author ?? one.user), body, association: associationOf(one) }
}

/**
 * An issue from what the forge answered, its CLI's JSON or its API's: GitHub's `body` and `url` or `html_url`, GitLab's
 * `description` and `web_url`; labels as names or as `{ name }`; a thread given apart, or within as `comments` or `notes`.
 * Who is trusted is told by `trust`: an author it cannot tell is from outside, so no one is trusted on a guess.
 */
export const parseIssue = (answer: string, thread = '', trust: Trust = {}): Issue | undefined => {
  const one = record(readJson(answer))
  const title = text(one.title)

  if (title === '') return undefined

  const apart = thread === '' ? [] : list(readJson(thread))
  const notes = [...list(one.comments), ...list(one.notes), ...apart].map(commentOf).filter((c): c is NonNullable<ReturnType<typeof commentOf>> => c !== undefined)
  const comments = notes.filter(c => isTrusted(trust, c.author, c.association)).map(({ author, body }) => ({ author, body }))
  const author = authorOf(one.author ?? one.user)

  return {
    title,
    body: text(one.body) || text(one.description),
    url: text(one.url) || text(one.html_url) || text(one.web_url),
    state: text(one.state),
    labels: list(one.labels).map(labelOf).filter(label => label !== ''),
    author,
    isOutside: !isTrusted(trust, author, associationOf(one) || (trust.association ?? '')),
    comments,
    leftOut: notes.length - comments.length,
  }
}

/**
 * The forge's REST API, where its CLI is missing or not logged in: the issue, its thread, and on GitLab the project's
 * members. A token in the environment is sent only to the forge's own host or the origin's: an issue named on another
 * host is read without it, so no ref can carry the token elsewhere.
 */
export const issueApiArgv = ({ forge, server, repo, number }: IssueRef, origin?: Repo): { issue: string[]; comments: string[]; members: string[] } => {
  const project = `https://${server}/api/v4/projects/${encodeURIComponent(repo)}`
  const base = forge === 'github' ? `${server === 'github.com' ? 'https://api.github.com' : `https://${server}/api/v3`}/repos/${repo}/issues/${number}` : `${project}/issues/${number}`
  const isOwnHost = server === `${forge}.com` || (origin !== undefined && origin.forge === forge && origin.server === server)
  const auth = !isOwnHost ? '' : forge === 'github' ? '${GITHUB_TOKEN:+-H "Authorization: Bearer $GITHUB_TOKEN"} ' : '${GITLAB_TOKEN:+-H "PRIVATE-TOKEN: $GITLAB_TOKEN"} '
  const curl = (url: string) => ['sh', '-c', `curl -fsSL ${auth}"$1"`, 'sh', url]

  return { issue: curl(base), comments: curl(forge === 'github' ? `${base}/comments?per_page=${PAGE}` : `${base}/notes?sort=asc&per_page=${PAGE}`), members: curl(`${project}/members/all?per_page=${PAGE}`) }
}

/** The repository as a CLI's `--repo` takes it: the path alone on the forge's own host, else with the host. */
const repoFlag = ({ forge, server, repo }: Repo): string =>
  forge === 'github' ? (server === 'github.com' ? repo : `${server}/${repo}`) : server === 'gitlab.com' ? repo : `https://${server}/${repo}`

/** A CLI's `--hostname`, for a host that is not the forge's own. */
const hostFlag = ({ forge, server }: Repo): string[] => (server === `${forge}.com` ? [] : ['--hostname', server])

/** An issue read through the CLI, else the API, with who is trusted on it; why neither could read it, when neither could. */
async function readIssueVia(shell: Shell, ref: IssueRef, origin: Repo | undefined, cli: string[], trustOf: () => Promise<Trust>): Promise<Issue | string> {
  const viewed = await shell.run(cli, { timeoutMs: READ_TIMEOUT_MS })
  const trust = await trustOf()
  const viaCli = viewed.exitCode === 0 ? parseIssue(viewed.stdout, '', trust) : undefined

  if (viaCli !== undefined) return viaCli

  const api = issueApiArgv(ref, origin)
  const got = await shell.run(api.issue, { timeoutMs: READ_TIMEOUT_MS })

  if (got.exitCode === 0) {
    const thread = await shell.run(api.comments, { timeoutMs: READ_TIMEOUT_MS })
    // GitHub's API says each author's association itself; GitLab's is told by the members
    const viaApi = parseIssue(got.stdout, thread.exitCode === 0 ? thread.stdout : '', ref.forge === 'github' ? {} : trust)

    if (viaApi !== undefined) return viaApi
  }

  return `${refText(ref)} could not be read. ${cli[0] ?? ''} said: ${lastLine(viewed.stderr) || `it exited with ${viewed.exitCode}`}; the API said: ${lastLine(got.stderr) || `curl exited with ${got.exitCode}`}.`
}

/** A pull request's state from what the CLI answered, or why it does not read. */
const pullStateIn = (forge: ForgeKind, url: string, ran: Ran): PullState | string => {
  const cli = forge === 'github' ? 'gh' : 'glab'

  if (ran.exitCode !== 0) return `${cli} could not read ${url}: ${lastLine(ran.stderr || ran.stdout) || `it exited with ${ran.exitCode}`}`

  const held = readJson(ran.stdout)

  if (typeof held !== 'object' || held === null) return `${cli} answered nothing that reads for ${url}: ${ran.stdout.trim().slice(0, 120)}`

  const one = record(held)
  const isGithub = forge === 'github'

  return {
    isMerged: one.state === 'MERGED' || one.state === 'merged',
    // GitHub answers UNKNOWN while it works the answer out: that is no conflict yet
    isConflicting: isGithub ? one.state === 'OPEN' && one.mergeable === 'CONFLICTING' : one.state === 'opened' && one.has_conflicts === true,
    branch: text(isGithub ? one.headRefName : one.source_branch),
    head: text(isGithub ? one.headRefOid : one.sha),
  }
}

/** The URL of the first pull request a list of them holds, as either forge writes it. */
export const firstUrl = (answer: string): string => {
  const first = record(list(readJson(answer))[0])

  return String(first.url ?? first.web_url ?? '')
}

/** The URL a CLI printed last: the pull request it opened. */
const printedUrl = (said: string): string => [...said.matchAll(/https?:\/\/\S+/g)].map(found => found[0]).pop() ?? ''

/**
 * A thread's notes as one comment: its body, its first then each reply after `--- <author>:`, those from outside left out
 * and counted; and, apart, what its first says and how many replies it holds, which no one's text can feign.
 */
const threadOf = (notes: readonly { author: string; body: string; isOutside: boolean }[]): Pick<ReviewComment, 'body' | 'said' | 'replies' | 'leftOut'> => {
  const [first, ...replies] = notes
  const kept = replies.filter(one => !one.isOutside)
  const outside = replies.length - kept.length

  return {
    body: [
      first?.body ?? '',
      ...kept.map(one => `--- ${one.author}:\n${one.body}`),
      ...(outside > 0 ? [`--- (${outside} ${outside === 1 ? 'reply' : 'replies'} from outside the repository left out)`] : []),
    ].join('\n\n'),
    said: first?.body ?? '',
    replies: kept.length,
    leftOut: outside,
  }
}

const GITHUB_REVIEW_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      url title headRefName baseRefName isCrossRepository
      reviewThreads(first: ${MAX_THREADS}) { totalCount nodes { id isResolved isOutdated path line comments(first: ${MAX_NOTES}) { totalCount nodes { author { login } authorAssociation body url } } } }
      reviews(first: ${MAX_REVIEWS}) { totalCount nodes { id author { login } authorAssociation body state url } }
    }
  }
}`

/** What GitHub answered of a pull request: it, and each open thread and review's own words as a comment. */
export const parseGithubReview = (answer: string, repo: string, number: number): Review | string => {
  const held = readJson(answer) as { data?: { repository?: { pullRequest?: Record<string, unknown> | null } }; errors?: { message?: string }[] } | undefined

  if (typeof held !== 'object' || held === null) return `GitHub answered nothing that reads: ${answer.trim().slice(0, 200)}`

  const pull = held.data?.repository?.pullRequest

  if (pull === undefined || pull === null) return held.errors?.[0]?.message ?? `No pull request #${number} in ${repo}.`

  type Note = { author?: { login?: unknown }; authorAssociation?: unknown; body?: unknown; url?: unknown }
  const threads = list(record(pull.reviewThreads).nodes) as { id?: unknown; isResolved?: unknown; path?: unknown; line?: unknown; comments?: { totalCount?: unknown; nodes?: Note[] } }[]
  const reviews = list(record(pull.reviews).nodes) as (Note & { id?: unknown; state?: unknown })[]
  const isOutside = (note: Note | undefined) => !TRUSTED_ASSOCIATIONS.includes(trimmed(note?.authorAssociation))
  const total = (of: unknown) => (typeof record(of).totalCount === 'number' ? (record(of).totalCount as number) : 0)
  const longThreads = threads.filter(thread => total(thread.comments) > MAX_NOTES).length
  const unread = [
    ...(total(pull.reviewThreads) > MAX_THREADS ? [`${total(pull.reviewThreads) - MAX_THREADS} review threads past the first ${MAX_THREADS} were not read`] : []),
    ...(total(pull.reviews) > MAX_REVIEWS ? [`${total(pull.reviews) - MAX_REVIEWS} reviews past the first ${MAX_REVIEWS} were not read`] : []),
    ...(longThreads > 0 ? [`${longThreads} ${longThreads === 1 ? 'thread holds' : 'threads hold'} more than ${MAX_NOTES} comments, read only to its ${MAX_NOTES}th`] : []),
  ]

  const comments: ReviewComment[] = [
    ...threads
      .filter(thread => thread.isResolved !== true && (thread.comments?.nodes ?? []).length > 0)
      .map(thread => {
        const notes = thread.comments?.nodes ?? []

        return {
          id: trimmed(thread.id),
          author: trimmed(notes[0]?.author?.login),
          path: trimmed(thread.path),
          line: typeof thread.line === 'number' ? thread.line : 0,
          ...threadOf(notes.map(note => ({ author: trimmed(note.author?.login), body: trimmed(note.body), isOutside: isOutside(note) }))),
          url: trimmed(notes[0]?.url),
          thread: trimmed(thread.id),
          isOutside: isOutside(notes[0]),
        }
      }),
    // A review's own words, when it asked for changes or said something: an approval's are not a request
    ...reviews
      .filter(review => trimmed(review.body) !== '' && review.state !== 'APPROVED' && review.state !== 'DISMISSED')
      // A review's words are all its author's: none of it is a reply, whatever it holds
      .map(review => ({ id: trimmed(review.id), author: trimmed(review.author?.login), path: '', line: 0, body: trimmed(review.body), said: trimmed(review.body), replies: 0, leftOut: 0, url: trimmed(review.url), isOutside: isOutside(review) })),
  ]

  return { pr: { forge: 'github', repo, number, url: trimmed(pull.url), title: trimmed(pull.title), branch: trimmed(pull.headRefName), base: trimmed(pull.baseRefName), isFork: pull.isCrossRepository === true }, comments, unread }
}

/**
 * What GitLab answered of a merge request: it, and each open discussion as a comment. `members` is the project's
 * members as GitLab lists them; where they could not be read, every author is taken as outside the repository.
 */
export const parseGitlabReview = (request: string, discussions: string, repo: string, number: number, members = ''): Review | string => {
  const mr = readJson(request)
  const held = readJson(discussions)

  if (mr === undefined || held === undefined) return `GitLab answered nothing that reads: ${request.trim().slice(0, 200)}`

  const one = record(mr)
  const pushers = gitlabPushers(members)
  const isOutside = (author: unknown) => !pushers.includes(trimmed(author))

  if (typeof one.iid !== 'number') return `No merge request !${number} in ${repo}.`

  type Note = { id?: unknown; author?: { username?: unknown }; body?: unknown; system?: unknown; resolvable?: unknown; resolved?: unknown; position?: { new_path?: unknown; new_line?: unknown } }
  const discussed = list(held).map(record)
  const comments = discussed
    .map(discussion => ({ id: trimmed(discussion.id), notes: (list(discussion.notes) as Note[]).filter(note => note.system !== true) }))
    .filter(({ notes }) => notes.length > 0 && notes[0]?.resolvable === true && notes[0]?.resolved !== true)
    .map(({ id, notes }) => ({
      id,
      author: trimmed(notes[0]?.author?.username),
      path: trimmed(notes[0]?.position?.new_path),
      line: typeof notes[0]?.position?.new_line === 'number' ? notes[0].position.new_line : 0,
      ...threadOf(notes.map(note => ({ author: trimmed(note.author?.username), body: trimmed(note.body), isOutside: isOutside(note.author?.username) }))),
      // A link names a note, not its discussion
      url: `${trimmed(one.web_url)}#note_${notes[0]?.id !== undefined ? String(notes[0].id) : id}`,
      thread: id,
      isOutside: isOutside(notes[0]?.author?.username),
    }))
  const isFork = typeof one.source_project_id === 'number' && typeof one.target_project_id === 'number' && one.source_project_id !== one.target_project_id

  return {
    pr: { forge: 'gitlab', repo, number, url: trimmed(one.web_url), title: trimmed(one.title), branch: trimmed(one.source_branch), base: trimmed(one.target_branch), isFork },
    comments,
    unread: discussed.length >= MAX_THREADS ? [`discussions past the first ${MAX_THREADS} were not read`] : [],
  }
}

/** A JSON list of objects, as a CLI printed it; nothing where it printed none. */
const jsonList = (said: string): Record<string, unknown>[] | undefined => {
  try {
    const parsed: unknown = JSON.parse(said)

    return Array.isArray(parsed) ? parsed.filter((one): one is Record<string, unknown> => typeof one === 'object' && one !== null) : undefined
  } catch {
    return undefined
  }
}

/** The issue a CLI opened, by the address it printed (`/issues/12`, `/-/issues/12` on GitLab); why there is none. */
const openedIssue = (opened: Ran, cli: 'gh' | 'glab'): { url: string; number: number } | string => {
  const url = printedUrl(opened.stdout)
  const number = Number(/\/issues\/(\d+)/.exec(url)?.[1] ?? NaN)

  if (opened.exitCode !== 0) return `The issue could not be opened: ${cli} said ${(opened.stderr || opened.stdout).trim() || 'nothing'}`

  return Number.isInteger(number) ? { url, number } : `${cli} opened the issue, but printed no address of it that reads: ${opened.stdout.trim().slice(0, 200)}`
}

/** GitHub, through `gh`. */
export const github = (shell: Shell): Forge => ({
  kind: 'github',
  cli: 'gh',

  async listIssues(repo) {
    const got = await shell.run(['gh', 'issue', 'list', '--repo', repoFlag(repo), '--state', 'open', '--limit', String(ISSUE_LIMIT), '--json', 'number,title,url,labels,author,updatedAt,body'], { timeoutMs: READ_TIMEOUT_MS })

    if (got.exitCode !== 0) return `gh could not list the issues of ${repo.repo}: ${lastLine(got.stderr || got.stdout)}`

    return parseIssues(got.stdout) ?? 'gh answered no list of issues that reads.'
  },

  readIssue: (ref, origin) =>
    readIssueVia(shell, ref, origin, ['gh', 'issue', 'view', String(ref.number), '--repo', repoFlag(ref), '--json', 'number,title,body,url,state,labels,comments,author'], async () => {
      const said = await shell.run(['gh', 'api', ...hostFlag(ref), `repos/${ref.repo}/issues/${ref.number}`, '--jq', '.author_association'], { timeoutMs: READ_TIMEOUT_MS })

      return said.exitCode === 0 ? { association: said.stdout.trim() } : {}
    }),

  async pullState(url) {
    return pullStateIn('github', url, await shell.run(['gh', 'pr', 'view', url, '--json', 'state,mergeable,headRefName,headRefOid'], { timeoutMs: READ_TIMEOUT_MS }))
  },

  async mergedFrom(branch) {
    const listed = await shell.run(['gh', 'pr', 'list', '--head', branch, '--state', 'merged', '--json', 'url', '--limit', '1'], { timeoutMs: READ_TIMEOUT_MS })

    return listed.exitCode === 0 ? firstUrl(listed.stdout) : ''
  },

  async currentRequest() {
    const viewed = await shell.run(['gh', 'pr', 'view', '--json', 'number'], { timeoutMs: SLOW_TIMEOUT_MS })
    const number = viewed.exitCode === 0 ? Number(record(readJson(viewed.stdout)).number) : NaN

    return Number.isInteger(number) ? number : "This branch has no open pull request that gh knows of: name one."
  },

  async readReview(repo, number) {
    const [owner, name] = repo.split('/')
    const got = await shell.run(['gh', 'api', 'graphql', '-f', `query=${GITHUB_REVIEW_QUERY}`, '-F', `owner=${owner ?? ''}`, '-F', `name=${name ?? ''}`, '-F', `number=${number}`], { timeoutMs: SLOW_TIMEOUT_MS })

    if (got.exitCode !== 0) return `gh could not read ${repo}#${number}: ${lastLine(got.stderr || got.stdout)}`

    return parseGithubReview(got.stdout, repo, number)
  },

  async openRequest({ branch, base, title, body }) {
    const opened = await shell.run(['gh', 'pr', 'create', '--base', base, '--head', branch, '--title', title, '--body', body], { timeoutMs: SLOW_TIMEOUT_MS })

    return opened.exitCode === 0 ? { url: printedUrl(opened.stdout) } : `The pull request could not be opened: gh said ${(opened.stderr || opened.stdout).trim() || 'nothing'}`
  },

  async failingChecks(repo, number) {
    // gh answers 1 where a check fails and 8 where one is pending: what it printed says which
    const got = await shell.run(['gh', 'pr', 'checks', String(number), '--repo', repo, '--json', 'name,bucket,link'], { timeoutMs: READ_TIMEOUT_MS })
    const checks = jsonList(got.stdout)

    if (checks === undefined) return got.exitCode !== 0 && /no checks/i.test(got.stderr) ? [] : `gh could not read the checks of ${repo}#${number}: ${lastLine(got.stderr || got.stdout)}`

    const failing = checks.filter(one => one.bucket === 'fail')

    return Promise.all(
      failing.map(async one => {
        const url = typeof one.link === 'string' ? one.link : ''
        const job = /\/actions\/runs\/\d+\/job\/(\d+)/.exec(url)?.[1]
        const log = job === undefined ? undefined : await shell.run(['gh', 'run', 'view', '--repo', repo, '--job', job, '--log-failed'], { timeoutMs: SLOW_TIMEOUT_MS })

        return { name: typeof one.name === 'string' ? one.name : 'a check', url, log: log?.exitCode === 0 ? tailOf(log.stdout) : '' }
      }),
    )
  },

  async openIssue(repo, title, body) {
    const opened = await shell.run(['gh', 'issue', 'create', '--repo', repoFlag(repo), '--title', title, '--body', body], { timeoutMs: SLOW_TIMEOUT_MS })

    return openedIssue(opened, 'gh')
  },

  replyToThread: (_number, thread, reply) =>
    shell.run(['gh', 'api', 'graphql', '-f', 'query=mutation($id: ID!, $body: String!) { addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $id, body: $body }) { comment { id } } }', '-f', `id=${thread}`, '-f', `body=${reply}`]),

  resolveThread: (_number, thread) => shell.run(['gh', 'api', 'graphql', '-f', 'query=mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { isResolved } } }', '-f', `id=${thread}`]),
})

/** GitLab, through `glab`. */
export const gitlab = (shell: Shell): Forge => ({
  kind: 'gitlab',
  cli: 'glab',

  async listIssues(repo) {
    const got = await shell.run(['glab', 'issue', 'list', '--repo', repoFlag(repo), '--per-page', String(ISSUE_LIMIT), '--output', 'json'], { timeoutMs: READ_TIMEOUT_MS })

    if (got.exitCode !== 0) return `glab could not list the issues of ${repo.repo}: ${lastLine(got.stderr || got.stdout)}`

    return parseIssues(got.stdout) ?? 'glab answered no list of issues that reads.'
  },

  readIssue: (ref, origin) =>
    readIssueVia(shell, ref, origin, ['glab', 'issue', 'view', String(ref.number), '--repo', repoFlag(ref), '--comments', '--output', 'json'], async () => {
      const cli = await shell.run(['glab', 'api', ...hostFlag(ref), `projects/${encodeURIComponent(ref.repo)}/members/all?per_page=${PAGE}`], { timeoutMs: READ_TIMEOUT_MS })
      const members = cli.exitCode === 0 ? cli : await shell.run(issueApiArgv(ref, origin).members, { timeoutMs: READ_TIMEOUT_MS })

      return { pushers: members.exitCode === 0 ? gitlabPushers(members.stdout) : [] }
    }),

  async pullState(url) {
    return pullStateIn('gitlab', url, await shell.run(['glab', 'mr', 'view', url, '--output', 'json'], { timeoutMs: READ_TIMEOUT_MS }))
  },

  async mergedFrom(branch) {
    const listed = await shell.run(['glab', 'mr', 'list', '--source-branch', branch, '--merged', '--output', 'json'], { timeoutMs: READ_TIMEOUT_MS })

    return listed.exitCode === 0 ? firstUrl(listed.stdout) : ''
  },

  async currentRequest() {
    const viewed = await shell.run(['glab', 'mr', 'view', '--output', 'json'], { timeoutMs: SLOW_TIMEOUT_MS })
    const number = viewed.exitCode === 0 ? Number(record(readJson(viewed.stdout)).iid) : NaN

    return Number.isInteger(number) ? number : 'This branch has no open pull request that glab knows of: name one.'
  },

  async readReview(repo, number) {
    const project = encodeURIComponent(repo)
    const request = await shell.run(['glab', 'api', `projects/${project}/merge_requests/${number}`], { timeoutMs: SLOW_TIMEOUT_MS })

    if (request.exitCode !== 0) return `glab could not read ${repo}#${number}: ${lastLine(request.stderr || request.stdout)}`

    const discussions = await shell.run(['glab', 'api', `projects/${project}/merge_requests/${number}/discussions?per_page=${MAX_THREADS}`], { timeoutMs: SLOW_TIMEOUT_MS })

    if (discussions.exitCode !== 0) return `glab could not read ${repo}#${number}: ${lastLine(discussions.stderr || discussions.stdout)}`

    // The members say whose comments are trusted: unread, every author is taken as outside, and that is said
    const members = await shell.run(['glab', 'api', `projects/${project}/members/all?per_page=${PAGE}`], { timeoutMs: SLOW_TIMEOUT_MS })
    const read = parseGitlabReview(request.stdout, discussions.stdout, repo, number, members.exitCode === 0 ? members.stdout : '')

    if (typeof read === 'string' || members.exitCode === 0) return read

    return { ...read, unread: [`the project's members could not be read (${lastLine(members.stderr || members.stdout)}), so every comment is taken as from outside the repository`, ...read.unread] }
  },

  async openRequest({ branch, base, title, body }) {
    const opened = await shell.run(['glab', 'mr', 'create', '--source-branch', branch, '--target-branch', base, '--title', title, '--description', body, '--yes'], { timeoutMs: SLOW_TIMEOUT_MS })

    return opened.exitCode === 0 ? { url: printedUrl(opened.stdout) } : `The pull request could not be opened: glab said ${(opened.stderr || opened.stdout).trim() || 'nothing'}`
  },

  async failingChecks(repo, number) {
    const project = encodeURIComponent(repo)
    const pipelines = await shell.run(['glab', 'api', `projects/${project}/merge_requests/${number}/pipelines`], { timeoutMs: READ_TIMEOUT_MS })
    const last = jsonList(pipelines.stdout)?.[0]

    if (pipelines.exitCode !== 0) return `glab could not read the pipelines of ${repo}!${number}: ${lastLine(pipelines.stderr || pipelines.stdout)}`
    if (last === undefined || typeof last.id !== 'number') return []

    const jobs = await shell.run(['glab', 'api', `projects/${project}/pipelines/${last.id}/jobs?scope[]=failed`], { timeoutMs: READ_TIMEOUT_MS })
    const failed = jsonList(jobs.stdout)

    if (jobs.exitCode !== 0 || failed === undefined) return `glab could not read the jobs of pipeline ${last.id}: ${lastLine(jobs.stderr || jobs.stdout)}`

    return Promise.all(
      failed.map(async one => {
        const trace = typeof one.id === 'number' ? await shell.run(['glab', 'api', `projects/${project}/jobs/${one.id}/trace`], { timeoutMs: SLOW_TIMEOUT_MS }) : undefined

        return { name: typeof one.name === 'string' ? one.name : 'a job', url: typeof one.web_url === 'string' ? one.web_url : '', log: trace?.exitCode === 0 ? tailOf(trace.stdout) : '' }
      }),
    )
  },

  async openIssue(repo, title, body) {
    const opened = await shell.run(['glab', 'issue', 'create', '--repo', repoFlag(repo), '--title', title, '--description', body, '--yes'], { timeoutMs: SLOW_TIMEOUT_MS })

    return openedIssue(opened, 'glab')
  },

  replyToThread: (number, thread, reply) => shell.run(['glab', 'api', '-X', 'POST', `projects/:id/merge_requests/${number}/discussions/${thread}/notes`, '-f', `body=${reply}`]),

  resolveThread: (number, thread) => shell.run(['glab', 'api', '-X', 'PUT', `projects/:id/merge_requests/${number}/discussions/${thread}`, '-f', 'resolved=true']),
})

/** The forge of a kind, its commands run through a shell. */
export const forgeOf = (kind: ForgeKind, shell: Shell): Forge => (kind === 'github' ? github(shell) : gitlab(shell))

/**
 * Where a pull request stands, by its URL, as its forge says; or why that is not known (no URL, the CLI failed, its
 * answer does not read), for the caller to say rather than take for "not merged".
 */
export const pullStateAt = async (shell: Shell, url: string): Promise<PullState | string> => {
  if (!/^https?:\/\//.test(url)) return url === '' ? 'no pull request is known' : `${url} is no pull request's URL`

  return forgeOf(forgeOfUrl(url), shell).pullState(url)
}
