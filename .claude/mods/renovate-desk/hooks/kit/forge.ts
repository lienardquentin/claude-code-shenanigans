// @ui-kit
// ui-kit part: forge. Copy this file to a mod's `hooks/kit/forge.ts`, then `import { forgeOf } from './kit/forge'`.
// Self-contained: it imports nothing. Not a drawing: which forge a repo is on, its command line and its words.

export type ForgeId = 'github' | 'gitlab'

export type Forge = {
  id: ForgeId
  /** As a person reads it. */
  name: 'GitHub' | 'GitLab'
  /** Its command line, the first word of every argv sent to it. */
  cli: 'gh' | 'glab'
  /** What it calls a branch that asks to be merged. */
  request: 'pull request' | 'merge request'
  /** What stands before such a request's number: `#12`, `!12`. */
  mark: '#' | '!'
}

export const FORGES: Readonly<Record<ForgeId, Forge>> = {
  github: { id: 'github', name: 'GitHub', cli: 'gh', request: 'pull request', mark: '#' },
  gitlab: { id: 'gitlab', name: 'GitLab', cli: 'glab', request: 'merge request', mark: '!' },
}

/** What to run, where the repo is, for the remote `forgeOf` reads; a run that fails leaves the remote unknown. */
export const REMOTE_ARGV: readonly string[] = ['git', 'remote', 'get-url', 'origin']

/** The host of a git remote, in lower case: of `git@host:group/repo.git` as of `https://host/group/repo`. */
export const hostOfRemote = (remote: string): string | undefined => {
  const trimmed = remote.trim()
  const host = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:]+)/i.exec(trimmed)?.[1] ?? /^(?:[^@/]*@)?([^/:]+):/.exec(trimmed)?.[1]

  return host?.toLowerCase()
}

const asId = (value: unknown): ForgeId | undefined => {
  const named = typeof value === 'string' ? value.trim().toLowerCase() : ''

  return named === 'github' || named === 'gitlab' ? named : undefined
}

/**
 * The forge a mod talks to. What the person asked for wins (a `forge` option: `github` or `gitlab`, which a GitLab
 * of one's own under a host that does not say so needs); else the host of the repo's remote says it; else GitHub.
 */
export const forgeOf = (given: { asked?: unknown; remote?: string | undefined }): Forge => {
  const asked = asId(given.asked)

  if (asked !== undefined) return FORGES[asked]

  return FORGES[(hostOfRemote(given.remote ?? '') ?? '').includes('gitlab') ? 'gitlab' : 'github']
}
