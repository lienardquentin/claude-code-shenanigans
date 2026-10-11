import type { Host } from './host'
import type { Reading } from './radius'

// A line that holds one of the words a language imports with, beside a quote
const IMPORT_LINE = '\\b(import|from|require|include|use|source|load)\\b.*["\'`]'

const git = async (host: Host, argv: readonly string[], okCodes: readonly number[] = [0]): Promise<string | undefined> => {
  try {
    const { exitCode, stdout } = await host.run(['git', ...argv], { timeoutMs: 30_000 })

    return okCodes.includes(exitCode) ? stdout : undefined
  } catch {
    return undefined
  }
}

/** Reads the repo through `git`, with no shell: its tracked files, and one search of them for import lines. */
export const readRepo = async (host: Host): Promise<Reading | undefined> => {
  const listed = await git(host, ['ls-files'])
  // Exit 1 is a search that found nothing. A file git ignores is not tracked, so it is never searched
  const found = await git(host, ['grep', '-I', '--null', '-E', IMPORT_LINE], [0, 1])

  if (listed === undefined || found === undefined) return undefined

  return {
    tracked: listed.split(/\r?\n/).filter(file => file !== ''),
    imports: found
      .split(/\r?\n/)
      .flatMap(row => {
        const cut = row.indexOf('\0')

        return cut > 0 ? [{ file: row.slice(0, cut), line: row.slice(cut + 1) }] : []
      }),
  }
}

/**
 * What was read of the repo, kept by the commit it is on: drawing the pane again at the same commit searches nothing.
 * `forget` drops it, for the pane's Refresh.
 */
export const reader = () => {
  // The reading itself is kept, so that two draws at once share one search
  const kept = new Map<string, Promise<Reading | undefined>>()

  return {
    forget: () => kept.clear(),
    /** The repo as it is now, or undefined when `git` cannot be read. */
    read: async (host: Host): Promise<Reading | undefined> => {
      const commit = (await git(host, ['rev-parse', 'HEAD']))?.trim()

      if (!commit) return undefined

      const hit = kept.get(commit)

      if (hit) return hit

      const reading = readRepo(host)

      kept.clear()
      kept.set(commit, reading)
      // A failed read is not kept: the next draw tries again
      void reading.then(read => (read === undefined && kept.get(commit) === reading ? kept.delete(commit) : undefined))

      return reading
    },
  }
}
