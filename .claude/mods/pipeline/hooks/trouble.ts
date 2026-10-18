import type { EngineInterface } from 'claude-code'

import { errorText } from '../core/kit'

// What went wrong in the parts, kept for as long as the module lives: work a clock, a hook or a session start does
// that nobody awaits has no caller to fail to, so its failure is said here, and kept to be read again.
// A helper that takes `$` is a function declaration: past an import, the engine follows `$` into no other kind.

type $ = EngineInterface

/** One part's failures: how many, the last one, and when the first and the last happened. */
export type Trouble = { part: string; count: number; last: string; firstAt: number; lastAt: number }

const troubles = new Map<string, Trouble>()

/** Keeps a failure of a part; true when it differs from the part's last one, and so is worth saying again. */
export const kept = (part: string, error: unknown, now = Date.now()): boolean => {
  const why = errorText(error)
  const was = troubles.get(part)

  troubles.set(part, { part, count: (was?.count ?? 0) + 1, last: why, firstAt: was?.firstAt ?? now, lastAt: now })

  return was?.last !== why
}

/** What the parts have failed at, as `mcp__pipeline__pane` answers it for `troubles`. */
export const troublesText = (): string => {
  if (troubles.size === 0) return 'No part of the pipeline has failed since the session started.'

  return [...troubles.values()]
    .sort((a, b) => b.lastAt - a.lastAt)
    .map(one => `${one.part}: failed ${one.count === 1 ? 'once' : `${one.count} times`}, last at ${new Date(one.lastAt).toISOString()}: ${one.last}`)
    .join('\n')
}

/** Forgets every kept failure, as a fresh module does: for tests. */
export const forgetTroubles = (): void => troubles.clear()

/**
 * What a part's failure comes to: it is kept, and said in a toast when it differs from the part's last failure, so a
 * part that keeps failing alike is said once and counted after. It answers nothing in the part's place.
 */
export function stumbled($: $, part: string): (error: unknown) => undefined {
  return error => {
    if (kept(part, error)) $.ui.toast(`Pipeline: ${part} failed: ${errorText(error).split('\n')[0] ?? ''}`)

    return undefined
  }
}

/** A clock's callback that does a part's work, its failure kept and said rather than dropped. */
export function inBackground($: $, part: string, work: () => Promise<unknown>): () => void {
  return () => void work().catch(stumbled($, part))
}
