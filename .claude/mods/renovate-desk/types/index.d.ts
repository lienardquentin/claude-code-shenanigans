export type Kind = 'major' | 'minor' | 'patch' | 'digest' | 'pin' | 'lockfile' | 'unknown'

/** `safe` is merged by the one button, `waiting` needs nobody, `look` is the person's call. */
export type Bucket = 'safe' | 'waiting' | 'look'

export type MergeMethod = 'squash' | 'merge' | 'rebase'

export type Pr = {
  /** `owner/repo#number` on GitHub, `group/project!number` on GitLab */
  id: string
  /** The forge it is on, which is the command line a merge goes through. */
  forge: 'github' | 'gitlab'
  /** `owner/repo`, or the project's full path. */
  repo: string
  number: number
  title: string
  url: string
  kind: Kind
  bucket: Bucket
  reason: string
  /** Whether the forge would take a merge now; a `look` row that has it gets its own button. */
  canMerge: boolean
  method: MergeMethod
  /** The head commit that was judged, the only one a merge goes through for. */
  head: string
}

export type Phase = 'idle' | 'loading' | 'merging'

export type LogEntry = { at: string; level: 'info' | 'warn' | 'error'; message: string }

declare module 'claude-code' {
  interface PluginState {
    'renovate-desk': {
      prs: Pr[]
      /** How many the forge found, which is more than `prs` past a hundred. */
      total: number
      /** The repo's origin as the last refresh read it, which says the forge; empty outside a repo and before one. */
      remote: string
      phase: Phase
      /** When the forge was last asked, as HH:MM; empty before the first refresh. */
      checkedAt: string
      /** Why the last refresh failed; empty when it did not. */
      error: string
      log: LogEntry[]
    }
  }
}
