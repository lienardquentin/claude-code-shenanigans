export type Kind = 'major' | 'minor' | 'patch' | 'digest' | 'pin' | 'lockfile' | 'unknown'

/** `safe` is merged by the one button, `waiting` needs nobody, `look` is the person's call. */
export type Bucket = 'safe' | 'waiting' | 'look'

export type MergeMethod = 'squash' | 'merge' | 'rebase'

export type Pr = {
  /** `owner/repo#number` */
  id: string
  title: string
  url: string
  kind: Kind
  bucket: Bucket
  reason: string
  /** Whether GitHub would take a merge now; a `look` row that has it gets its own button. */
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
      /** How many GitHub found, which is more than `prs` past a hundred. */
      total: number
      phase: Phase
      /** When GitHub was last asked, as HH:MM; empty before the first refresh. */
      checkedAt: string
      /** Why the last refresh failed; empty when it did not. */
      error: string
      log: LogEntry[]
    }
  }
}
