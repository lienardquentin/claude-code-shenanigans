import type { Attachment, RuntimeId } from '../types'
import { workloadOf } from './runtime'

// What a session watches, and which of it an edit counts against. Text in, attachments out.

/** The project's own list of attachments, one per line, beside its other Claude files. */
export const PROJECT_FILE = '.claude/runtime'

/** The same list under the mod's old name, read where the project has not moved it yet. */

const RUNTIME: Record<string, RuntimeId> = {
  local: 'local',
  file: 'local',
  docker: 'docker',
  compose: 'compose',
  k8s: 'kubernetes',
  kubernetes: 'kubernetes',
}

/** A path with forward slashes and no trailing one, so two spellings of a folder compare equal. */
export const tidy = (path: string): string => path.replace(/\\/g, '/').replace(/\/+$/, '')

const isAbsolute = (path: string): boolean => /^([A-Za-z]:)?\//.test(path)

/** The path from the working directory, unless it is already whole. */
export const under =(cwd: string, path: string): string => (isAbsolute(tidy(path)) ? tidy(path) : `${tidy(cwd)}/${tidy(path).replace(/^\.\//, '')}`)

/**
 * One attachment as the option and the project's file write it: `label=runtime:ref@root,root#port`. The roots are
 * the source folders whose edits count against it, read from the working directory; the port is the one a local
 * app listens on, which is how its process is found.
 */
export const parseSpec = (spec: string, cwd: string): Attachment | undefined => {
  const found = /^([\w.-]+)\s*=\s*(\w+):(.+)$/.exec(spec.trim())

  if (found === null) return undefined

  const [, label = '', kind = '', whole = ''] = found
  const ported = /^(.*)#(\d{1,5})$/.exec(whole.trim())
  const rest = ported?.[1] ?? whole
  const runtime = RUNTIME[kind.toLowerCase()]
  // The last @ parts the roots from the ref
  const cut = rest.lastIndexOf('@')
  const ref = (cut === -1 ? rest : rest.slice(0, cut)).trim()
  const roots = cut === -1 ? [] : rest.slice(cut + 1).split(',').map(root => root.trim()).filter(root => root !== '')

  if (runtime === undefined || ref === '') return undefined
  if (runtime === 'kubernetes' && workloadOf(ref) === undefined) return undefined

  return { label, runtime, ref: runtime === 'local' ? under(cwd, ref) : ref, roots: roots.map(root => under(cwd, root)), port: Number(ported?.[2] ?? 0) }
}

/** Every attachment a text lists, one per line or parted by `;`, a `#` line a comment; what does not read is left out. */
export const parseList = (text: string, cwd: string): Attachment[] =>
  text
    .split(/[\n;]/)
    .map(line => line.trim())
    .filter(line => line !== '' && !line.startsWith('#'))
    .flatMap(line => parseSpec(line, cwd) ?? [])

/**
 * A compose project's services as attachments, read off `docker compose config --format json`: each named as its
 * service, and counted against the folder it is built from. One built from the project's own folder, or pulled as
 * an image, has no folder of its own: every edit counts against it.
 */
export const composeAttachments = (stdout: string, cwd: string): Attachment[] => {
  let project: unknown

  try {
    project = JSON.parse(stdout)
  } catch {
    return []
  }

  const services = (project as { services?: Record<string, { build?: { context?: unknown } } | null> } | null)?.services ?? {}

  return Object.entries(services).map(([service, spec]) => {
    const context = typeof spec?.build?.context === 'string' ? under(cwd, spec.build.context) : ''

    return { label: service, runtime: 'compose' as const, ref: service, roots: context === '' || context === tidy(cwd) ? [] : [context], port: 0 }
  })
}

/** The lists as one, a later list's attachment taking the place of an earlier one of the same label. */
export const merged = (...lists: Attachment[][]): Attachment[] => {
  const byLabel = new Map<string, Attachment>()

  for (const attachment of lists.flat()) byLabel.set(attachment.label, attachment)

  return [...byLabel.values()]
}

// Windows folds case in paths, and a drive letter is written both ways
const same = (path: string): string => tidy(path).toLowerCase()

/**
 * The attachments an edit to `path` counts against: those one of whose roots holds it, and, for a file of the
 * working directory, those with no roots. A file elsewhere (another worktree) is no edit of the app that runs.
 */
export const routed = (attachments: readonly Attachment[], path: string, cwd: string): Attachment[] => {
  const file = same(under(cwd, path))
  const isHere = file.startsWith(`${same(cwd)}/`)

  return attachments.filter(({ roots }) => (roots.length === 0 ? isHere : roots.some(root => file === same(root) || file.startsWith(`${same(root)}/`))))
}

/** The path as the person would write it: from the working directory when it is under it. */
export const shown = (path: string, cwd: string): string => {
  const file = under(cwd, path)

  return same(file).startsWith(`${same(cwd)}/`) ? file.slice(tidy(cwd).length + 1) : file
}

/** The files git says differ from what is committed, by path, with when each was last written: -1 for one that is gone. */
export type Dirty = Record<string, number>

/** The command that lists those files, from the folder it is run in: changed, new and not ignored, or deleted. */
export const DIRTY_ARGV = ['git', 'ls-files', '--modified', '--others', '--deleted', '--exclude-standard', '-z'] as const

/** The command that names the commit the working tree stands on. */
export const HEAD_ARGV = ['git', 'rev-parse', 'HEAD'] as const

/** The command that lists the files two commits differ by. */
export const movedArgv = (from: string, to: string): readonly string[] => ['git', 'diff', '--name-only', '-z', from, to]

/**
 * The files written between two looks at the working tree, whoever wrote them: a shell command, a checkout, the
 * person's own editor. `before` is what git listed at the last look and `now` every file looked at this time: the
 * ones listed then, the ones listed now, and the ones a move to another commit touched. A file known from before
 * was written if its time changed; one that is new to the list, if it was written since that look or is gone. A
 * file that only left the list (committed, staged) keeps its time and is no edit.
 */
export const editedBetween = (before: Dirty, now: Dirty, lookedAt: number): string[] =>
  Object.entries(now)
    .filter(([path, written]) => (before[path] === undefined ? written === -1 || written > lookedAt : written !== before[path]))
    .map(([path]) => path)
