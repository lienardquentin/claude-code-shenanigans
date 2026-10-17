// Small helpers the core and the mod share: text in, text out, and work done one at a time.

/** What an error says, whatever was thrown. */
export const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * Work done one at a time, each after the one before has ended, however that one ended: where what parts do beside one
 * another reads and writes the same thing.
 */
export const inTurn = (): (<T>(work: () => Promise<T>) => Promise<T>) => {
  let last: Promise<unknown> = Promise.resolve()

  return work => {
    const done = last.then(work)

    last = done.catch(() => undefined)

    return done
  }
}
