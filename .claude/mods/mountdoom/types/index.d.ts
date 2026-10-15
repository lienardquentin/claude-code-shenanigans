/** A mod that keeps work of a pull request: what it remembers, Mount Doom has it forget. */
export type MountdoomKeeper = 'fellowship' | 'blackgate'

/** One branch's work, as the mods that keep it remember it. */
export type MountdoomRelic = {
  /** The issue as Elrond writes it short, `github:owner/repo#12`; the pull request's own for a review or a gate alone. */
  ref: string
  branch: string
  base: string
  /** The worktree the Fellowship built it in, absolute; empty when it kept none. */
  tree: string
  /** The pull request's URL: kept by a mod, or found on the forge by its branch; empty when none is known. */
  pr: string
  keepers: MountdoomKeeper[]
  /** Whether the forge says it is merged, when last looked. */
  isMerged: boolean
}

declare module 'claude-code' {
  interface PluginState {
    mountdoom: {
      relics: MountdoomRelic[]
      /** The pull requests the person was told are merged: each is told once. */
      told: string[]
      note: string
      /**
       * What /mountdoom asked the clock for: `look`, or `cast` and what to cast. The other mods answer no call made
       * beneath a command's hooks, and a look and a cast both ask them.
       */
      wanted: string
      working: string
    }
  }
}
