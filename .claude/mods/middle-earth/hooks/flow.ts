import type { EngineInterface } from 'claude-code'

// What the parts of the mod share: the project's folder, git and the forge, what a command changes, and how the
// Fellowship reads Argonath's proof and judgement of a builder's change.
// A helper that takes `$` is a function declaration: past an import, the engine follows `$` into no other kind.

type $ = EngineInterface

/** The trailer each commit a builder's change is committed with ends with, and each pull request. */
export const COMMIT_TRAILER = 'Co-Authored-By: Claude <noreply@anthropic.com>'
export const PR_TRAILER = '🤖 Generated with [Claude Code](https://claude.com/claude-code)'

/** The model the statues judge a change with when it is not heavy: lighter than their own, and enough for it. */
export const SWIFT_STATUE_MODEL = 'claude-sonnet-5-5'

// How long the forge is given to take a push or open a pull request
const FORGE_TIMEOUT_MS = 120_000

export const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((one): one is string => typeof one === 'string') : [])
const text = (value: unknown): string => (typeof value === 'string' ? value : '')

/**
 * Whether a shell command changes the tree or the machine: a git command that moves HEAD, the index or the refs, a
 * command that writes, moves or installs, a download, or a redirection into a file. Those who only read are held to
 * what this lets through.
 */
export const isChanging = (command: string): boolean =>
  /(^|[;&|(]\s*|\s)git\s+(-\S+(\s+[^-\s]\S*)?\s+)*(add|commit|push|checkout|switch|reset|rebase|merge|stash|restore|clean|rm|mv|apply|am|cherry-pick|revert|tag|branch)\b/.test(command) ||
  /(^|[;&|(]\s*|\s)(rm|mv|cp|touch|mkdir|chmod|chown|tee|truncate|dd|(npm|pnpm|yarn)\s+(install|i|add|remove|update)|pip3?\s+install|uv\s+(add|remove|sync|lock|pip)|cargo\s+(add|install|update)|sed\s+-i|perl\s+-i|curl|wget)\b/.test(command) ||
  // A redirection writes a file; one into the void, or into another stream, does not
  /(^|[^<>=!0-9&])\d?>{1,2}\s*(?!&|\/dev\/null)\S/.test(command)

/** A path as it lands from a folder: absolute, its `.` and `..` walked. */
export const resolvedFrom = (cwd: string, path: string): string => {
  const parts: string[] = []

  for (const part of (/^([A-Za-z]:)?\//.test(path) ? path : `${cwd}/${path}`).split('/')) {
    if (part === '..') parts.pop()
    else if (part !== '.' && part !== '') parts.push(part)
  }

  return `/${parts.join('/')}`
}

/**
 * The project's folder: the repository's top, wherever the session's directory has wandered within it (a `cd` in
 * Claude's shell moves it), else the session's directory itself.
 */
export async function rootOf($: $): Promise<string> {
  const cwd = (await $.session.cwd()).replace(/\/+$/, '')
  const top = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd }).catch(() => undefined)
  const found = top?.exitCode === 0 ? top.stdout.trim() : ''

  return found !== '' ? found : cwd
}

/**
 * A command run in a folder, the project's when none is named (a quest's commands run in its worktree): whether it
 * ended well, and what it said (its error when it did not).
 */
export async function run($: $, argv: readonly string[], timeoutMs?: number, cwd?: string): Promise<{ ok: boolean; out: string }> {
  const ran = await $.process.run([...argv], { cwd: cwd ?? (await rootOf($)), ...(timeoutMs !== undefined ? { timeoutMs } : {}) }).catch((error: unknown) => ({ exitCode: -1, stdout: '', stderr: errorText(error) }))

  return { ok: ran.exitCode === 0, out: (ran.exitCode === 0 ? ran.stdout : ran.stderr || ran.stdout).trim() }
}

export async function git($: $, args: readonly string[], cwd?: string): Promise<{ ok: boolean; out: string }> {
  return run($, ['git', ...args], undefined, cwd)
}

/**
 * Whether the forge says a pull request (a merge request on GitLab) is merged, by its URL, and, when a branch is named,
 * merged from that branch: what a mod forgets after it, it forgets only once its work has landed.
 */
/** Whether the forge says an open pull request can no longer merge into its base as it stands: it is in conflict. */
export async function isConflictingAt($: $, url: string): Promise<boolean> {
  if (!/^https?:\/\//.test(url)) return false

  const isGithub = /\/\/github\.com\//.test(url)
  const ran = await $.process.run(isGithub ? ['gh', 'pr', 'view', url, '--json', 'state,mergeable'] : ['glab', 'mr', 'view', url, '--output', 'json'], { timeoutMs: 60_000 }).catch(() => undefined)

  if (ran === undefined || ran.exitCode !== 0) return false

  try {
    const held = JSON.parse(ran.stdout) as { state?: unknown; mergeable?: unknown; has_conflicts?: unknown }

    // GitHub answers UNKNOWN while it works the answer out: that is no conflict yet
    return isGithub ? held.state === 'OPEN' && held.mergeable === 'CONFLICTING' : held.state === 'opened' && held.has_conflicts === true
  } catch {
    return false
  }
}

export async function isMergedFrom($: $, url: string, branch?: string): Promise<boolean> {
  if (!/^https?:\/\//.test(url)) return false

  const isGithub = /\/\/github\.com\//.test(url)
  const ran = await $.process.run(isGithub ? ['gh', 'pr', 'view', url, '--json', 'state,headRefName'] : ['glab', 'mr', 'view', url, '--output', 'json'], { timeoutMs: 60_000 }).catch(() => undefined)

  if (ran === undefined || ran.exitCode !== 0) return false

  try {
    const held = JSON.parse(ran.stdout) as { state?: unknown; headRefName?: unknown; source_branch?: unknown }
    const from = isGithub ? held.headRefName : held.source_branch

    return (held.state === 'MERGED' || held.state === 'merged') && (branch === undefined || from === branch)
  } catch {
    return false
  }
}

/** A turn's end, as each part reads it: whose turn (no agent for the session's own), its answer, and how it ended. */
export type TurnEnded = { agentId?: string; answer?: string; isAborted: boolean; reason: 'answer' | 'aborted' | 'refusal' | 'error' }

/** A section a part adds to the system prompt, for the session. */
export type Section = { id: string; text: string }

/** A target of the project, as Argonath knows it: a builder is chosen by the target its work is in. */
export type Target = { label: string; kind: 'frontend' | 'service' | 'cli'; roots: string[] }

/** Argonath's proof as a mod reads it. */
export type ProofVerdict = { isSettled: boolean; isUnlooked: boolean; line: string; unhandled: string[]; unreached: string[]; text: string }

/** An answer as a part hands it, or as JSON text: the object it is, or why it is none. */
const heldOf = (answer: unknown): Record<string, unknown> | string => {
  if (typeof answer === 'object' && answer !== null) return answer as Record<string, unknown>

  const said = String(answer)

  try {
    const held = JSON.parse(said) as unknown

    return typeof held === 'object' && held !== null ? (held as Record<string, unknown>) : said
  } catch {
    return said
  }
}

/**
 * Argonath's proof, as it answers a part: whether it settles the change (every changed run pinned, no test turned),
 * whether a target the change reached could not be looked at at all, which no builder can mend, the targets nothing
 * proves, the targets no kept run sees, and the proof as it reads. An answer that is not one is a proof that could not
 * be looked at.
 */
export const proofVerdict = (answer: unknown): ProofVerdict => {
  const held = heldOf(answer)

  if (typeof held === 'string' || typeof held.verdict !== 'string') {
    const said = typeof held === 'string' ? held : JSON.stringify(held)

    return { isSettled: false, isUnlooked: true, line: `Argonath answered no proof that reads: ${said.trim().slice(0, 200)}`, unhandled: [], unreached: [], text: said }
  }

  return { isSettled: held.verdict === 'settled', isUnlooked: held.verdict === 'unlooked', line: text(held.line) || held.verdict, unhandled: strings(held.unhandled), unreached: strings(held.unreached), text: text(held.text) || JSON.stringify(held) }
}

/** The statues' judgement as a part reads it: the verdict, their findings a line each, and the verdict in a line. */
export type Judged = { verdict: string; blocking: string[]; minor: string[]; line: string }

/** The statues' judgement as Argonath answers it to a part. */
export const parseJudgement = (answer: unknown): Judged => {
  const held = heldOf(answer)

  if (typeof held === 'string') return { verdict: 'unreadable', blocking: [], minor: [], line: `the Argonath answered no judgement: ${held.trim().slice(0, 200)}` }

  const verdict = typeof held.verdict === 'string' ? held.verdict : 'unreadable'
  const seats = (Array.isArray(held.seats) ? held.seats : []) as { title?: unknown; state?: unknown; why?: unknown; findings?: { severity?: unknown; where?: unknown; text?: unknown }[] }[]
  const lines = (severity: string) =>
    seats.flatMap(seat => (Array.isArray(seat.findings) ? seat.findings : []).filter(one => one.severity === severity).map(one => `- ${String(seat.title ?? '')}${typeof one.where === 'string' && one.where !== '' ? `, ${one.where}` : ''}: ${String(one.text ?? '')}`))
  const blocking = lines('blocking')
  const minor = lines('minor')
  const silent = seats.filter(seat => seat.state === 'silent').map(seat => `${String(seat.title ?? '')} ${String(seat.why ?? 'could not judge')}`)
  const many = (count: number, one: string) => `${count} ${one}${count === 1 ? '' : 's'}`
  const line =
    verdict === 'pass'
      ? `passed${minor.length > 0 ? `, ${many(minor.length, 'minor finding')}` : ''}`
      : verdict === 'fail'
        ? many(blocking.length, 'blocking finding')
        : verdict === 'silent'
          ? `not judged: ${silent.join('; ')}`
          : verdict === 'sitting'
            ? 'judging'
            : verdict

  return { verdict, blocking, minor, line }
}

/** A command a builder is not to run: its mod commits, and the branch is the mod's to keep. */
export const isForbiddenGit = (command: string): boolean => /(^|[;&|(]\s*|\s)git\s+(-\S+(\s+[^-\s]\S*)?\s+)*(commit|push|checkout|switch|reset|rebase|merge|stash|restore|clean|branch|tag|cherry-pick|revert|am|pull)\b/.test(command)

const withinOf = (root: string, path: string): string => (path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path.replace(/^\.\//, ''))

// The folders the mods keep for themselves in a tree: a builder leaves them alone, and a commit takes nothing of them
const MOD_FOLDERS = ['elrond', 'argonath', 'anduril', 'fellowship', 'lothlorien', 'blackgate'] as const

/** A path in the folders the mods keep for themselves, which a builder leaves alone. */
export const isModPath = (root: string, path: string): boolean => new RegExp(`^\\.(${MOD_FOLDERS.join('|')})(/|$)`).test(withinOf(root, path))

/** The pathspec of a tree's own files, the mods' folders left out: what a commit stages, and what a change is looked for in. */
export const UNMODDED: readonly string[] = ['--', '.', ...MOD_FOLDERS.map(folder => `:(exclude).${folder}`)]

/** The issue a ref is of, from Elrond's short spelling: `github:owner/repo#12`, `gitlab:git.corp.io/g/p#3`. */
export const issueOf = (ref: string): { forge: 'github' | 'gitlab'; server: string; repo: string; number: number } | undefined => {
  const found = /^(github|gitlab):(.+)#(\d+)$/.exec(ref.trim())

  if (found === null) return undefined

  const forge = found[1] as 'github' | 'gitlab'
  const path = found[2] ?? ''
  const head = path.split('/')[0] ?? ''
  // A self-hosted forge is named by its host first, which a repository's owner never spells with a dot
  const isHosted = head.includes('.') && path.split('/').length > 2

  return { forge, server: isHosted ? head : `${forge}.com`, repo: isHosted ? path.slice(head.length + 1) : path, number: Number(found[3]) }
}

/** The forge's CLI that opens a pull request (a merge request on GitLab) from a branch onto another. */
export const requestArgv = ({ forge, branch, base, title, body }: { forge: 'github' | 'gitlab'; branch: string; base: string; title: string; body: string }): string[] =>
  forge === 'github'
    ? ['gh', 'pr', 'create', '--base', base, '--head', branch, '--title', title, '--body', body]
    : ['glab', 'mr', 'create', '--source-branch', branch, '--target-branch', base, '--title', title, '--description', body, '--yes']

/** Pushes a branch and opens a pull request from it with the forge's CLI: its URL, or why it could not be. */
export async function openRequest($: $, branch: string, argv: readonly string[], cwd?: string): Promise<{ url: string } | string> {
  const pushed = await push($, branch, cwd)

  if (!pushed.ok) return `${branch} could not be pushed: ${pushed.out || 'git failed'}`

  const opened = await run($, argv, FORGE_TIMEOUT_MS, cwd)

  if (!opened.ok) return `The pull request could not be opened: ${argv[0] ?? ''} said ${opened.out || 'nothing'}`

  return { url: [...opened.out.matchAll(/https?:\/\/\S+/g)].map(found => found[0]).pop() ?? '' }
}

/** Pushes a branch to origin, tracking it, from a folder it is checked out in. */
export async function push($: $, branch: string, cwd?: string): Promise<{ ok: boolean; out: string }> {
  return run($, ['git', 'push', '-u', 'origin', branch], FORGE_TIMEOUT_MS, cwd)
}

/**
 * Sends a builder whose turn has ended back to its work, with what it read and did still in its context: cheaper and
 * surer than a fresh builder, who starts cold. Known by the id its spawn answered, else as the last of its type sent.
 * Whether it was reached.
 */
export async function sendBack($: $, agentId: string, agentType: string, text: string): Promise<boolean> {
  const to = agentId !== '' ? agentId : ((await $.agent.list().catch(() => [])).filter(one => one.type === agentType).at(-1)?.id ?? '')

  if (to === '') return false

  const sent = await $.session.send({ to: { agentId: to }, text }).catch(() => undefined)

  return sent?.isDelivered === true
}

/** What a builder is sent back with: what the proof or the statues found, to mend in the change it made. */
export const sendBackPrompt = (why: { proof?: string; findings?: string[] }): string =>
  why.findings !== undefined
    ? [
        'Every changed run of your change is pinned, but its review found what blocks it. Fix each finding in the change you made, prove it again, and end your turn with your account as before.',
        '<findings>',
        ...why.findings,
        '</findings>',
      ].join('\n')
    : [
        "Argonath's proof does not settle your change yet. Carry on from where you are: write the integration test each changed run it lists as bare asks for, bring a loose or broken one to what the code now does, or fix the code where a change was not meant. Then prove it again, and end your turn with your account as before.",
        '<proof>',
        (why.proof ?? '').trim(),
        '</proof>',
      ].join('\n')
