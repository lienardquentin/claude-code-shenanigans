import type { Shell } from './forge'
import { UNTRACKED, changesByTarget, sizeText } from './proof'
import type { Target } from './proof'

// What git says a change holds, in the folder a shell runs in: its fingerprint, its diff and new files as the
// reviewers are shown them, its size, and what it holds in each target's folders. The mods' own folders are no part
// of any change.

// The folders the mods keep for themselves in a tree, and the ones they kept before they were renamed: a builder leaves
// them alone, and a commit takes nothing of them
export const MOD_FOLDERS = ['pipeline', 'anduril', 'elrond', 'argonath', 'fellowship', 'lothlorien', 'blackgate'] as const

/** The pathspec of a tree's own files, the mods' folders left out: what a commit stages, and what a change is looked for in. */
export const UNMODDED: readonly string[] = ['--', '.', ...MOD_FOLDERS.map(folder => `:(exclude).${folder}`)]

/** `UNMODDED` as a shell script spells it: what the reviewers are shown, and what a change is known by, is what a commit takes. */
export const UNMODDED_WORDS = UNMODDED.map(one => `'${one}'`).join(' ')

/**
 * The shell script that fingerprints what the change holds, so the one last proved or reviewed is known again: HEAD,
 * the diff against the merge base of `$1` and HEAD, and the files git neither tracks nor ignores, by name and by
 * content (so an edit of a new file moves it too), hashed whole by git. It writes nothing to the object store.
 */
const CHANGE_SCRIPT = `held=$(b=$(git merge-base "$1" HEAD) || exit 1; git rev-parse HEAD; git diff "$b" --no-color --no-ext-diff ${UNMODDED_WORDS}; git ls-files -o --exclude-standard ${UNMODDED_WORDS}; git ls-files -o --exclude-standard -z ${UNMODDED_WORDS} | xargs -0 -r git hash-object --) || exit 1; printf %s "$held" | git hash-object --stdin`


const lastLine = (said: string): string => said.trim().split('\n').slice(-1)[0] ?? ''

// What a fingerprint of a change git could not read starts with: it matches no change that was read, so no proof or
// judgement made of one is ever taken for another's
export const UNREADABLE = 'unreadable:'

/**
 * The whole change as one fingerprint: HEAD, the diff since `against` left it, and the new files by name and content.
 * One git could not read is `unreadable:` and why, the same each time it fails alike, so a judgement of it is not stale.
 */
export const fingerprintOf = async (shell: Shell, against = 'HEAD'): Promise<string> => {
  const ran = await shell.run(['sh', '-c', CHANGE_SCRIPT, 'sh', against])

  return ran.exitCode === 0 ? `git:${ran.stdout.trim()}` : `${UNREADABLE}${lastLine(ran.stderr)}`
}

/** The change as the reviewers are handed it: the diff since `against` left HEAD, then the new files by name, the mods' folders left out; or why git could not say it. */
export const changeText = async (shell: Shell, against = 'HEAD'): Promise<{ text: string } | { error: string }> => {
  const ran = await shell.run(['sh', '-c', `b=$(git merge-base "$1" HEAD) || exit 1; git diff "$b" --no-color --no-ext-diff ${UNMODDED_WORDS}; echo; echo "New files:"; git ls-files -o --exclude-standard ${UNMODDED_WORDS}`, 'sh', against])

  return ran.exitCode === 0 ? { text: ran.stdout } : { error: `git could not show the change since ${against}: ${lastLine(ran.stderr) || `it exited with ${ran.exitCode}`}` }
}

/**
 * How big the change is, in a sentence for the reviewers: nothing when git could not count it, as a size is only a note.
 * Each new file is counted as git would diff it (a link by where it points, a binary by no line), and one git cannot
 * diff (a nested repository) is left out of the count.
 */
export const sizeOf = async (shell: Shell, against = 'HEAD'): Promise<string> => {
  const ran = await shell.run(['sh', '-c', `b=$(git merge-base "$1" HEAD) || exit 1; git diff "$b" --numstat -z --no-ext-diff ${UNMODDED_WORDS} || exit 1; printf '%s\\0' '${UNTRACKED}'; git ls-files -o --exclude-standard -z ${UNMODDED_WORDS} | xargs -0 -r -n1 sh -c 'git diff --no-index --numstat -z -- /dev/null "$1" 2>/dev/null; true' sh`, 'sh', against])

  return ran.exitCode === 0 ? sizeText(ran.stdout) : ''
}

/**
 * What each target's folders hold against HEAD in the tree a shell runs in, by label, read in one go: empty for a
 * target the change did not reach; none at all where git could not say.
 */
export const changesIn = async (shell: Shell, tree: string, list: readonly Target[]): Promise<Map<string, string>> => {
  const roots = [...new Set(list.flatMap(({ roots }) => roots))]

  if (roots.length === 0) return new Map()

  const ran = await shell.run(['sh', '-c', `git diff HEAD --no-color --no-ext-diff -- "$@"; echo; echo '${UNTRACKED}'; git ls-files -o --exclude-standard -- "$@"`, 'sh', ...roots])

  return ran.exitCode !== 0 ? new Map() : changesByTarget(ran.stdout, list, tree)
}

/** The diff of a target's tests against HEAD, the files they hold deleted with it: where a change weakens them. */
export const testsDiffOf = async (shell: Shell, target: Pick<Target, 'tests'>): Promise<string> => {
  if (target.tests.length === 0) return ''

  const ran = await shell.run(['git', 'diff', 'HEAD', '--no-color', '--no-ext-diff', '--', ...target.tests])

  return ran.exitCode === 0 ? ran.stdout : ''
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
