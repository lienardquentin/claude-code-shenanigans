import type { Target } from '../../types'
import { tidy, targetsOf } from './project'
import { plural } from './verdict'

// What a change touched: its diff by target, where each target's files stand, its dependency manifests, its size,
// and the tests it weakened.

/** What each target's folders hold against HEAD, split from one diff and one list of new files, by label. */
export const changesByTarget = (output: string, targets: readonly Pick<Target, 'label' | 'roots'>[], cwd: string): Map<string, string> => {
  const [diff = '', fresh = ''] = output.split(`\n${UNTRACKED}\n`)
  const chunks = diff.split(/^(?=diff --git )/m).filter(chunk => chunk.startsWith('diff --git '))
  const pathOf = (chunk: string) => `${cwd}/${/^diff --git a\/(\S+)/.exec(chunk)?.[1] ?? ''}`
  const held = new Map<string, string>()

  for (const target of targets) {
    const isIn = (path: string) => targetsOf(path, [target as Target]).length > 0
    const files = fresh.split('\n').filter(line => line.trim() !== '' && isIn(`${cwd}/${line.trim()}`))

    held.set(target.label, [...chunks.filter(chunk => isIn(pathOf(chunk))), ...files].join('\n'))
  }

  return held
}

/** The line between the diff and the new files in what `changesByTarget` reads. */
export const UNTRACKED = '--untracked--'

/**
 * The shell script that says where the folders `$@` stand, cheaply: git status's lines, then a line a changed file
 * that is still there, `path<TAB>size mtime`. No file's content is read.
 */
export const STANDING_SCRIPT =
  'out=$(git status --porcelain=v1 -uall -- "$@") || exit 1; printf "%s\\n" "$out"; printf "%s\\n" "$out" | cut -c4- | sed "s/.* -> //" | tr "\\n" "\\0" | xargs -0 -r stat --printf "%n\\t%s %.9Y\\n" -- 2>/dev/null; true'

/** What `STANDING_SCRIPT` said, split by target: each line by the file it names. */
export const standingByTarget = (output: string, targets: readonly Pick<Target, 'label' | 'roots'>[], cwd: string): Map<string, string> => {
  const pathOf = (line: string) => {
    const [named = ''] = line.split('\t')

    // A status line names its file after two letters and a space; a rename names where it went last
    return (line.includes('\t') ? named : named.slice(3).split(' -> ').at(-1) ?? '').replace(/^"|"$/g, '')
  }
  const lines = output.split('\n').filter(line => line.trim() !== '')
  const held = new Map<string, string>()

  for (const target of targets) {
    const isIn = (path: string) => targetsOf(`${tidy(cwd)}/${path}`, [target as Target]).length > 0

    held.set(target.label, lines.filter(line => isIn(pathOf(line))).join('\n'))
  }

  return held
}

// The files a dependency is declared or locked in, by name
export const MANIFEST = /(^|\/)(Cargo\.(toml|lock)|package(-lock)?\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|pyproject\.toml|uv\.lock|poetry\.lock|Pipfile(\.lock)?|requirements[\w.-]*\.txt|go\.(mod|sum)|Gemfile(\.lock)?|composer\.(json|lock))$/

/** The dependency manifests a change touches, from its diff and the new files after it, a path each. */
export const manifestsOf = (change: string): string[] =>
  [
    ...new Set(
      change.split('\n').flatMap(line => {
        // A chunk's header names its file; a new file is a bare path, where every line of a chunk starts otherwise
        const path = /^diff --git a\/(\S+)/.exec(line)?.[1] ?? (/^[\w.][^\s]*$/.test(line) && !line.startsWith('index') ? line : '')

        return MANIFEST.test(path) ? [path] : []
      }),
    ),
  ]

// The files a dependency's lock is written whole in: they say nothing of what a change wrote
export const LOCKED = /(^|\/)(Cargo\.lock|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|uv\.lock|poetry\.lock|Pipfile\.lock|go\.sum|Gemfile\.lock|composer\.lock)$/

// How many of the files a change adds most to are named
export const SIZE_FILES = 5

/**
 * The files git's `--numstat -z` names, each with the lines it adds and takes out: `added<TAB>removed<TAB>path`, or for
 * a rename `added<TAB>removed<TAB>`, then where from and where to, each ended by a NUL. A binary file adds no line.
 */
export const numstatOf = (tokens: readonly string[], isNew: boolean): { path: string; added: number; removed: number; isNew: boolean }[] => {
  const files: { path: string; added: number; removed: number; isNew: boolean }[] = []

  for (let at = 0; at < tokens.length; at += 1) {
    const found = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(tokens[at] ?? '')

    if (found === null) continue

    // A rename names where it came from and where it went, after its counts
    const path = found[3] !== '' ? (found[3] ?? '') : (tokens[(at += 2)] ?? '')

    files.push({ path, added: Number(found[1]) || 0, removed: Number(found[2]) || 0, isNew })
  }

  return files
}

/**
 * How big a change is, in a sentence for the reviewers, from git's `--numstat -z` of its diff, `UNTRACKED`, then of each
 * new file against nothing: the lines it adds and takes out, across how many files, how many new, and where it adds
 * most. Lock files are not counted. Nothing for a change of no line.
 */
export const sizeText = (output: string): string => {
  const tokens = output.split('\0')
  const split = tokens.indexOf(UNTRACKED)
  const all = [...numstatOf(split === -1 ? tokens : tokens.slice(0, split), false), ...(split === -1 ? [] : numstatOf(tokens.slice(split + 1), true))]
  const counted = all.filter(one => !LOCKED.test(one.path))
  const added = counted.reduce((sum, one) => sum + one.added, 0)
  const removed = counted.reduce((sum, one) => sum + one.removed, 0)

  if (added === 0 && removed === 0) return ''

  const news = counted.filter(one => one.isNew).length
  const most = [...counted].filter(one => one.added > 0).sort((one, other) => other.added - one.added).slice(0, SIZE_FILES)

  return [
    `The change adds ${plural(added, 'line', 'lines')} and takes out ${removed}, across ${plural(counted.length, 'file', 'files')}${news > 0 ? `, ${news} of them new` : ''}.`,
    ...(most.length > 0 ? [`Where it adds most: ${most.map(one => `${one.path} +${one.added}${one.isNew ? ' (new)' : ''}`).join(', ')}.`] : []),
    ...(counted.length < all.length ? ['Lock files are not counted.'] : []),
  ].join(' ')
}

// A test declared, as a removed or added line of a diff spells it: Rust's attribute, Python's and Go's test functions,
// a JavaScript runner's call
export const TEST_DECLARED = /^\s*(#\[(\w+::)?test\]|(async\s+)?def\s+test_\w+|func\s+Test\w+|(it|test)\s*\(\s*['"`])/

// A test skipped, or the rest of a file's tests skipped by running one alone, as an added line spells it
export const TEST_SKIPPED = /#\[ignore\b|@pytest\.mark\.(skip|skipif|xfail)\b|\bpytest\.skip\(|@unittest\.skip|\b(it|test|describe)\.(skip|only|todo)\s*\(|\bx(it|test|describe)\s*\(|\bt\.Skip(Now|f)?\(/

/**
 * What a change does to the tests it touches that weakens them, as its diff of their files shows: a test file
 * deleted, tests taken out of a file (more declared on removed lines than on added ones), a test skipped or run
 * alone. A line each; none when it weakens nothing. Moving a test within the diff takes out nothing.
 */
export const weakenedOf = (diff: string): string[] =>
  diff
    .split(/^(?=diff --git )/m)
    .filter(chunk => chunk.startsWith('diff --git '))
    .flatMap(chunk => {
      const file = /^diff --git a\/(\S+)/.exec(chunk)?.[1] ?? ''
      const lines = chunk.split('\n').filter(line => !line.startsWith('---') && !line.startsWith('+++'))
      const removed = lines.filter(line => line.startsWith('-') && TEST_DECLARED.test(line.slice(1))).length
      const added = lines.filter(line => line.startsWith('+') && TEST_DECLARED.test(line.slice(1))).length
      const skipped = lines.filter(line => line.startsWith('+') && TEST_SKIPPED.test(line.slice(1))).map(line => line.slice(1).trim())

      if (/^deleted file mode/m.test(chunk)) return [`${file}: the test file is deleted${removed > 0 ? `, with its ${plural(removed, 'test', 'tests')}` : ''}`]

      return [
        ...(removed > added ? [`${file}: ${plural(removed - added, 'test', 'tests')} taken out`] : []),
        ...skipped.map(line => `${file}: skipped or run alone, \`${line.slice(0, 120)}\``),
      ]
    })
