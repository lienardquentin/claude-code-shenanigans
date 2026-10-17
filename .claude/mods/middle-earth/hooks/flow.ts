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

/** What a task of each weight is, as the council weighs it and the statues weigh a change's size against it. */
export const WEIGHT_MEANS = {
  light: 'docs, config, a rename or a test to adjust',
  standard: "one module's change and the test that proves it",
  heavy: 'a change that crosses targets, reworks a design, or touches code that is risky to change',
} as const

// How long the forge is given to take a push or open a pull request
const FORGE_TIMEOUT_MS = 120_000

export const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * What a tool of the mod answers when its hook failed: the failure, said to Claude, rather than the call left unanswered
 * as if no tool were there.
 */
export const toolFailed = (tool: string, error: { kind: string; message?: string }): { result: string } => ({
  result: `${tool} failed: ${error.kind === 'timeout' ? 'it ran past its time' : 'it stumbled'}${error.message !== undefined && error.message !== '' ? ` (${error.message})` : ''}. Say so to the person; the pane may say more.`,
})

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((one): one is string => typeof one === 'string') : [])
const text = (value: unknown): string => (typeof value === 'string' ? value : '')

// Where a command word starts: the line's start, after an operator or a space, or a backtick
const AT_WORD = '(^|[;&|(`]\\s*|\\s)'
// git, run by its name or by its path (`/usr/bin/git`), and the options it takes before its verb
const GIT = `${AT_WORD}(\\S*/)?git\\s+(-\\S+(\\s+[^-\\s]\\S*)?\\s+)*`

// git run with config of the command's own, before its verb (`git -c core.fsmonitor=… status`), or with the
// environment that stands for it: a config can run any command, and so can a git told to look in another repository
const GIT_CONFIGURED = `${AT_WORD}(\\S*/)?git\\s+((?!-c\\b|--config-env)-\\S+(\\s+[^-\\s]\\S*)?\\s+)*(-c|--config-env)\\b|\\bGIT_(CONFIG\\w*|DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|EXEC_PATH|SSH_COMMAND|EXTERNAL_DIFF|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES)=`

// `git config` that writes: one that only reads (`--get`, `--list`) changes nothing
const GIT_CONFIG_WRITE = 'config(?!(\\s+--(show-origin|show-scope|null|includes|global|system|local|worktree|file\\s+\\S+))*\\s+(--get\\S*|--list|-l)\\b)'

/** The command and the shell scripts it runs inline (`sh -c '…'`, `bash -c "…"`), each read as a command of its own. */
const scriptsOf = (command: string): string[] => [command, ...[...command.matchAll(/\b(?:ba|z|da)?sh\s+(?:-\S+\s+)*-c\s+(['"])([\s\S]*?)\1/g)].map(found => found[2] ?? '')]

/**
 * Whether a shell command changes the tree or the machine: a git command that moves HEAD, the index or the refs, a
 * command that writes, moves or installs, a download, a redirection into a file, or code run inline by an interpreter
 * (`python -c`, `node -e`), which can do any of these. It reads the command's words, so it is a guide an agent is held
 * to, not a sandbox: a command built to hide what it does can pass it.
 */
export const isChanging = (command: string): boolean =>
  scriptsOf(command).some(
    script =>
      new RegExp(`${GIT}(add|commit|push|pull|fetch|checkout|switch|reset|rebase|merge|stash|restore|clean|rm|mv|apply|am|cherry-pick|revert|tag|branch|worktree|update-ref|gc|init|clone|${GIT_CONFIG_WRITE})\\b`).test(script) ||
      new RegExp(GIT_CONFIGURED).test(script) ||
      new RegExp(`${AT_WORD}(rm|mv|cp|ln|touch|mkdir|chmod|chown|tee|truncate|dd|rsync|unzip|(npm|pnpm|yarn)\\s+(install|i|add|remove|update)|pip3?\\s+install|uv\\s+(add|remove|sync|lock|pip)|cargo\\s+(add|install|update)|sed\\s+-i|perl\\s+-i|curl|wget)\\b`).test(script) ||
      new RegExp(`${AT_WORD}(python[\\d.]*|node|deno|bun|ruby|perl|php)\\s+(-\\S+\\s+)*-[ce]\\b`).test(script) ||
      /(^|\s)find\s[^;&|]*\s-(delete|exec|execdir|ok)\b/.test(script) ||
      // A redirection writes a file; one into the void, or into another stream, does not
      /(^|[^<>=!0-9&])\d?>{1,2}\s*(?!&|\/dev\/null)\S/.test(script),
  )

// The folders of the machine where what is private lives: the people's homes, the system's config and secrets, the
// processes' environment, the drives mounted in
const PRIVATE_ROOTS = /^\/(home|root|Users|etc|proc|run|srv|media|mnt|var(?!\/tmp(\/|$)))(\/|$)/

/** Whether a path, absolute once resolved from a folder, is somewhere private on the machine outside the project's folder. */
export const isPrivatePath = (root: string, cwd: string, path: string): boolean => {
  const whole = resolvedFrom(cwd, path)

  return whole !== root && !whole.startsWith(`${root}/`) && PRIVATE_ROOTS.test(whole)
}

/**
 * Why a shell command no agent the mod sends is to run, whatever its role; nothing when it may. It names the home
 * folder or a private folder of the machine outside the project (`cat ~/.ssh/id_rsa`, `cat /etc/shadow`), or runs what
 * it downloads (`curl … | sh`). It reads the command's words: a fence for agents that mean well, not a sandbox.
 */
export const privateRefusal = (root: string, cwd: string, command: string): string | undefined => {
  for (const script of scriptsOf(command)) {
    if (/(^|[\s=:'"(])(~|\$\{?HOME\}?)(\/|[\s'";&|)]|$)/.test(script)) return 'Leave the home folder alone: work in the project, by paths relative to your working directory.'
    if (new RegExp(`${AT_WORD}(curl|wget)\\b[^;&]*\\|\\s*(sudo\\s+)?((ba|z|da)?sh|python[\\d.]*|node|perl|ruby|php)\\b`).test(script)) return 'Run nothing you download: what a builder needs is in the project, or named in its manifests for the person to install.'

    const named = script.split(/[\s;&|()<>'"`]+/).map(word => word.replace(/^[^=/]*=/, '')).find(word => word.startsWith('/') && isPrivatePath(root, cwd, word))

    if (named !== undefined) return `${named} is outside the project, somewhere private on the machine: read and run only what the project holds.`
  }

  return undefined
}

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
 * Claude's shell moves it), else the session's directory itself. Inside a linked worktree (a quest's, a target's) it is
 * still the main checkout, whose `.git` the worktree shares: never the worktree, or a quest set out from there would
 * nest its own worktree inside it.
 */
export async function rootOf($: $): Promise<string> {
  const cwd = (await $.session.cwd()).replace(/\/+$/, '')
  const top = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd }).catch(() => undefined)
  const found = top?.exitCode === 0 ? top.stdout.trim() : ''

  if (found === '') return cwd

  const common = await $.process.run(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd }).catch(() => undefined)
  const shared = common?.exitCode === 0 ? common.stdout.trim().replace(/\/+$/, '') : ''
  const main = shared.endsWith('/.git') ? shared.slice(0, -'/.git'.length) : ''

  return main !== '' && main !== found ? main : found
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
 * The forge a host or a remote is, as every part reads it: GitLab where its name says so, GitHub otherwise (github.com,
 * or an Enterprise host).
 */
export const forgeOfHost = (host: string): 'github' | 'gitlab' => (host.toLowerCase().includes('gitlab') ? 'gitlab' : 'github')

/** Who a GitHub issue or comment is trusted from: one who can push to the repository. Anyone else's is the person's to weigh. */
export const TRUSTED_ASSOCIATIONS: readonly string[] = ['OWNER', 'MEMBER', 'COLLABORATOR']

// The least GitLab access that can push: Developer
const GITLAB_DEVELOPER = 30

/** Who can push to a GitLab project, from its `members/all` list; no one where the list does not read, so no one is trusted on a guess. */
export const gitlabPushers = (members: string): string[] => {
  try {
    return (JSON.parse(members) as { username?: unknown; access_level?: unknown }[]).filter(one => typeof one.access_level === 'number' && one.access_level >= GITLAB_DEVELOPER).map(one => text(one.username).trim())
  } catch {
    return []
  }
}

/** The forge a pull request (a merge request on GitLab) is on, by its URL: its path says so where it can, else its host. */
export const forgeOfUrl = (url: string): 'github' | 'gitlab' =>
  /\/-\/merge_requests\/\d+/.test(url) ? 'gitlab' : /\/pull\/\d+/.test(url) ? 'github' : forgeOfHost(/^[a-z+]+:\/\/(?:[^@/]+@)?([^/:]+)/i.exec(url)?.[1] ?? url)

/** A pull request as the forge says it stands: merged or not, in conflict with its base, and the branch and commit it is of. */
export type PullState = { isMerged: boolean; isConflicting: boolean; branch: string; head: string }

/**
 * Where a pull request stands, by its URL, as its forge's CLI says; or why that is not known (no URL, the CLI failed,
 * its answer does not read), for the caller to say rather than take for "not merged".
 */
export async function pullStateOf($: $, url: string): Promise<PullState | string> {
  if (!/^https?:\/\//.test(url)) return `${url === '' ? 'no pull request is known' : `${url} is no pull request's URL`}`

  const isGithub = forgeOfUrl(url) === 'github'
  const ran = await $.process
    .run(isGithub ? ['gh', 'pr', 'view', url, '--json', 'state,mergeable,headRefName,headRefOid'] : ['glab', 'mr', 'view', url, '--output', 'json'], { timeoutMs: 60_000 })
    .catch((error: unknown) => ({ exitCode: -1, stdout: '', stderr: errorText(error) }))

  if (ran.exitCode !== 0) return `${isGithub ? 'gh' : 'glab'} could not read ${url}: ${(ran.stderr || ran.stdout).trim().split('\n').slice(-1)[0] || `it exited with ${ran.exitCode}`}`

  try {
    const held = JSON.parse(ran.stdout) as { state?: unknown; mergeable?: unknown; has_conflicts?: unknown; headRefName?: unknown; source_branch?: unknown; headRefOid?: unknown; sha?: unknown }

    return {
      isMerged: held.state === 'MERGED' || held.state === 'merged',
      // GitHub answers UNKNOWN while it works the answer out: that is no conflict yet
      isConflicting: isGithub ? held.state === 'OPEN' && held.mergeable === 'CONFLICTING' : held.state === 'opened' && held.has_conflicts === true,
      branch: text(isGithub ? held.headRefName : held.source_branch),
      head: text(isGithub ? held.headRefOid : held.sha),
    }
  } catch {
    return `${isGithub ? 'gh' : 'glab'} answered nothing that reads for ${url}: ${ran.stdout.trim().slice(0, 120)}`
  }
}

/** Whether the forge says an open pull request can no longer merge into its base as it stands: it is in conflict. */
export async function isConflictingAt($: $, url: string): Promise<boolean> {
  const state = await pullStateOf($, url)

  return typeof state !== 'string' && state.isConflicting
}

/**
 * Whether the forge says a pull request (a merge request on GitLab) is merged, by its URL, and, when a branch is named,
 * merged from that branch: what a mod forgets after it, it forgets only once its work has landed. A forge that could
 * not be asked says no, so nothing is forgotten on a guess.
 */
export async function isMergedFrom($: $, url: string, branch?: string): Promise<boolean> {
  const state = await pullStateOf($, url)

  return typeof state !== 'string' && state.isMerged && (branch === undefined || state.branch === branch)
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

// Secrets as their issuers spell them: each a name, and a pattern no test fixture or prose matches by chance
const SECRETS: readonly [string, RegExp][] = [
  ['a private key', /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY(?: BLOCK)?-----/],
  ['an AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['a GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/],
  ['a GitLab token', /\bglpat-[A-Za-z0-9_-]{20,}\b/],
  ['a Slack token', /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/],
  ['an Anthropic key', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/],
  ['an OpenAI key', /\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b/],
  ['a Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['a Stripe live key', /\b[sr]k_live_[0-9A-Za-z]{20,}\b/],
  // One for a host on a network: a local database's or a compose service's (`postgres://postgres:postgres@db`) is a fixture
  ['a password in a URL', /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@'"]+:[^\s@/'"$]{6,}@(?!localhost\b|127\.|0\.0\.0\.0\b)[\w-]+\.[\w.-]+/i],
]

/**
 * The secrets a diff adds: each added line that holds one, as `file: what`. A diff that takes one out, or a line that
 * names one in a variable, adds none.
 */
export const secretsIn = (diff: string): string[] => {
  const found: string[] = []
  let file = ''

  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) file = line.slice(4).replace(/^b\//, '')
    else if (line.startsWith('+')) for (const [what, pattern] of SECRETS) if (pattern.test(line)) found.push(`${file}: ${what}`)
  }

  return [...new Set(found)]
}

/**
 * A command a builder is not to run: its mod commits, and the branch is the mod's to keep. Nor does it set what git
 * runs (its config, by `git config`, `-c` or the environment): the mod's own commit would run it, outside the guard.
 */
export const isForbiddenGit = (command: string): boolean =>
  scriptsOf(command).some(
    script =>
      new RegExp(`${GIT}(commit|push|checkout|switch|reset|rebase|merge|stash|restore|clean|branch|tag|cherry-pick|revert|am|pull|update-ref|worktree|${GIT_CONFIG_WRITE})\\b`).test(script) ||
      new RegExp(GIT_CONFIGURED).test(script),
  )

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

/** What a builder is sent back with once its change passed with minor findings: to tidy them, and change nothing else. */
export const tidyPrompt = (minor: readonly string[]): string =>
  [
    'Your change passed its review, with minor findings. Tidy each one that is about what your change itself wrote, with the smallest edit that answers it, and change no behaviour; leave one you judge wrong, and say why in your account. Then prove it again, and end your turn with your account as before. Minor findings of the review after this one are left as they are.',
    '<findings>',
    ...minor,
    '</findings>',
  ].join('\n')
