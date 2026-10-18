import type { EngineInterface, TurnUsage } from 'claude-code'

import type { SentAgent, SpentTurn } from '../types'

// What each agent the mod sends costs, a line a turn: its role, its model, its tokens and its time, by the issue it
// works for and the folder it works in. Kept in .theseus/, which no commit takes, across sessions, so a run says
// what it has cost and the person can weigh what runs cost from the record.
// A helper that takes `$` is a function declaration: past an import, the engine follows `$` into no other kind.

type $ = EngineInterface

/** The record, under the project's folder. */
export const SPEND_FILE = '.theseus/spend.jsonl'

// Where the record was kept before: read until the first turn is recorded under the new name

// How many turns the record keeps, the oldest left out first: the engine reads a file whole, under 4 MiB
const KEPT = 5_000

// The record is written one turn at a time: two reviewers that end together would each write over the other's line
let writing: Promise<void> = Promise.resolve()

/** One turn of an agent, as the record keeps it; nothing for a turn that counted no tokens (interrupted, an API error). */
export const spendOf = (agent: SentAgent, e: { durationMs: number; usage?: TurnUsage }, at: number): SpentTurn | undefined =>
  e.usage === undefined
    ? undefined
    : {
        role: agent.role,
        ...(agent.ref !== undefined && agent.ref !== '' ? { ref: agent.ref } : {}),
        tree: agent.tree,
        model: e.usage.model,
        input: e.usage.input_tokens,
        cacheRead: e.usage.cache_read_input_tokens,
        cacheWrite: e.usage.cache_creation_input_tokens,
        output: e.usage.output_tokens,
        durationMs: e.durationMs,
        at,
      }

/** The turns a record's text holds, a line each; a line that does not read is passed over. */
export const spendsIn = (text: string): SpentTurn[] =>
  text.split('\n').flatMap(line => {
    if (line.trim() === '') return []

    try {
      const held = JSON.parse(line) as SpentTurn

      return typeof held.model === 'string' && typeof held.output === 'number' ? [held] : []
    } catch {
      return []
    }
  })

async function recordText($: $, root: string): Promise<string> {
  if (await $.fs.exists(`${root}/${SPEND_FILE}`)) return String(await $.fs.read(`${root}/${SPEND_FILE}`))

  return ''
}

/** Adds a turn to the project's record; the record as it then stands. */
export async function record($: $, root: string, spend: SpentTurn): Promise<SpentTurn[]> {
  const done = writing.then(async () => {
    const all = [...spendsIn(await recordText($, root)), spend].slice(-KEPT)

    await $.fs.write(`${root}/${SPEND_FILE}`, `${all.map(one => JSON.stringify(one)).join('\n')}\n`)

    return all
  })

  writing = done.then(
    () => undefined,
    () => undefined,
  )

  return done
}

/** The turns the project's record holds. */
export async function spends($: $, root: string): Promise<SpentTurn[]> {
  return spendsIn(await recordText($, root))
}

const count = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${Math.round(n / 1_000)}k` : String(n))
const minutes = (ms: number): string => `${Math.round(ms / 60_000)} min`

/** What turns cost, in a line: how many, their time, and their tokens, read in all (from the cache among them) and written. */
export const costLine = (turns: readonly SpentTurn[]): string => {
  const read = turns.reduce((sum, one) => sum + one.input + one.cacheRead + one.cacheWrite, 0)
  const cached = turns.reduce((sum, one) => sum + one.cacheRead, 0)
  const out = turns.reduce((sum, one) => sum + one.output, 0)
  const ms = turns.reduce((sum, one) => sum + one.durationMs, 0)

  return `${turns.length} ${turns.length === 1 ? 'turn' : 'turns'}, ${minutes(ms)}, ${count(read)} tokens in (${count(cached)} cached), ${count(out)} out`
}

/** What a run's agents cost: in all, then by role, each as `costLine` says it, with the models it ran on. Nothing for a run none was counted to. */
export const costText = (turns: readonly SpentTurn[]): string => {
  if (turns.length === 0) return ''

  const roles = [...new Set(turns.map(one => one.role))]
  const models = (some: readonly SpentTurn[]) => [...new Set(some.map(one => one.model))].map(model => `${model} ×${some.filter(one => one.model === model).length}`).join(', ')

  return [
    `Spent: ${costLine(turns)}.`,
    ...roles.map(role => {
      const some = turns.filter(one => one.role === role)

      return `- ${role}: ${costLine(some)} (${models(some)})`
    }),
  ].join('\n')
}
