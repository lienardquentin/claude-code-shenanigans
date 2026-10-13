import type { Attachment, Baseline, Signature, Watch } from '../types'
import { clockTime, describeLine, EMPTY_WATCH, fresh, requestIds, signatureOf } from './lines'
import type { Labelled } from './report'

// The errors of the watched apps kind by kind, what each is new since, and what Claude is handed of them. Values
// in, values out.

export const BASELINES: readonly Baseline[] = ['edit', 'mark', 'start']

export const BASELINE_NAME: Record<Baseline, string> = { edit: 'the last edit', mark: 'the mark', start: 'the last start' }

const firstOf = ({ firstAt, lastAt }: Signature): number => firstAt ?? lastAt

/** The errors of a watch that first showed after what is named: the last edit routed to it, its mark, or its last start. */
export const newSince = (watch: Watch, baseline: Baseline): Signature[] => {
  if (baseline === 'edit') return fresh(watch)

  const from = baseline === 'mark' ? watch.markedAt : watch.rolledAt

  return from === undefined ? [] : watch.signatures.filter(signature => firstOf(signature) >= from)
}

/** What a watch's errors are counted from, in words: or why nothing is, yet. */
export const sinceText = (watch: Watch, baseline: Baseline): string => {
  if (baseline === 'edit') return watch.edits === 0 ? 'no edit has been routed to it in this session' : `since the edit to ${watch.editedPath}`
  if (baseline === 'mark') return watch.markedAt === undefined ? 'no mark is set on it' : `since the mark set at ${clockTime(watch.markedAt)}`

  return watch.rolledAt === undefined ? 'it has not been seen to start over in this session' : `since it started over at ${clockTime(watch.rolledAt)}`
}

export type Kind = { label: string; signature: Signature; isNew: boolean }

/** Every kind of error of the attachments, the new ones first, then the last written first. */
export const kindsOf = (attachments: readonly Attachment[], held: Record<string, Watch>, baseline: Baseline): Kind[] =>
  attachments
    .flatMap(({ label }) => {
      const watch = held[label] ?? EMPTY_WATCH
      const news = newSince(watch, baseline)

      return watch.signatures.map(signature => ({ label, signature, isNew: news.includes(signature) }))
    })
    .sort((a, b) => Number(b.isNew) - Number(a.isNew) || b.signature.lastAt - a.signature.lastAt)

/** What names a kind among all: its app, then its key. */
export const kindId = ({ label, signature }: Pick<Kind, 'label' | 'signature'>): string => `${label}\n${signature.key}`

const MAX_AROUND = 12
// How many lines of its own app are said before an error that names no request
const BEFORE = 3

/**
 * The last time an error of a kind was written, with what led to it: the lines of every app that share its request
 * id, or, where it names none, the lines its own app wrote just before.
 */
export const around = ({ label, signature }: Pick<Kind, 'label' | 'signature'>, everything: readonly Labelled[]): Labelled[] => {
  const last = [...everything].reverse().find(entry => entry.label === label && entry.line.level === 'error' && signatureOf(entry.line.message).startsWith(signature.key))

  if (last === undefined) return []

  const ids = requestIds(last.line.message)

  if (ids.length > 0) return everything.filter(entry => entry === last || requestIds(entry.line.message).some(id => ids.includes(id))).slice(-MAX_AROUND)

  const own = everything.filter(entry => entry.label === label)

  return own.slice(Math.max(0, own.indexOf(last) - BEFORE), own.indexOf(last) + 1)
}

/** What is handed to Claude when the person asks for an error to be looked into: the error, how often, and what led to it. */
export const diagnosePrompt = (kind: Kind, watch: Watch, lines: readonly Labelled[]): string =>
  [
    `Find why the running ${kind.label}, which palantir watches, writes this error, and fix the cause in the code, not around it:`,
    '',
    `  ${kind.signature.sample}`,
    '',
    `Written ${kind.signature.count} time${kind.signature.count === 1 ? '' : 's'}, first at ${clockTime(firstOf(kind.signature))}, last at ${clockTime(kind.signature.lastAt)}${kind.isNew && watch.edits > 0 ? `; it first showed after the edit to ${watch.editedPath}` : ''}.`,
    ...(lines.length === 0 ? [] : ['', 'The last time, with what led to it across the watched apps:', ...lines.map(({ label, line }) => `  ${describeLine(label, line)}`)]),
    '',
    `mcp__palantir__logs reads more (\`request\` follows one request id across the apps, \`grep\` searches). Once it is fixed and ${kind.label} has reloaded, mcp__palantir__errors_since_edit says whether it still writes it. If the cause is not in the code (a service that is down, a setting), say so and change nothing.`,
  ].join('\n')

export type Untold = { label: string; path: string; signatures: Signature[] }

/** The errors that are new since the last edit to each app and that Claude has not been handed yet. */
export const untoldOf = (attachments: readonly Attachment[], held: Record<string, Watch>): Untold[] =>
  attachments.flatMap(({ label }) => {
    const watch = held[label] ?? EMPTY_WATCH
    const signatures = fresh(watch).filter(({ isTold }) => isTold !== true)

    return signatures.length === 0 ? [] : [{ label, path: watch.editedPath, signatures }]
  })

const MAX_TOLD = 5

/** What Claude reads of them, unasked: each app's new errors since its edit, a few of each, and where to read more. */
export const untoldText = (untold: readonly Untold[]): string =>
  [
    'palantir, which watches the running apps, saw errors that first showed after an edit of this session:',
    ...untold.flatMap(({ label, path, signatures }) => [
      `${label}, since the edit to ${path}: ${signatures.length} new kind${signatures.length === 1 ? '' : 's'} of error`,
      ...signatures.slice(0, MAX_TOLD).map(({ count, sample, lastAt }) => `  ${clockTime(lastAt)} x${count} ${sample.slice(0, 300)}`),
      ...(signatures.length > MAX_TOLD ? [`  and ${signatures.length - MAX_TOLD} more`] : []),
    ]),
    'The edit may be what brought them. mcp__palantir__errors_since_edit reads them afresh, and mcp__palantir__logs what was written around them.',
  ].join('\n')

/** What is submitted to Claude when it guards the edits and no turn runs: the same, with what is asked of it. */
export const guardPrompt = (untold: readonly Untold[]): string =>
  `${untoldText(untold)}\n\nLook into ${untold.length === 1 && untold[0]?.signatures.length === 1 ? 'it' : 'them'}: where the edit is the cause, fix it; where it is not, say what is.`

/** The watches once Claude has been handed every error that is new since an edit. */
export const told = (held: Record<string, Watch>): Record<string, Watch> =>
  Object.fromEntries(
    Object.entries(held).map(([label, watch]) => {
      const news = fresh(watch)

      return [label, news.some(({ isTold }) => isTold !== true) ? { ...watch, signatures: watch.signatures.map(signature => (news.includes(signature) ? { ...signature, isTold: true } : signature)) } : watch]
    }),
  )
