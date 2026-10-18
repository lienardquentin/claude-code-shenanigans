import type { RunEvent } from '../../theseus/core/events'
import type { RunView } from '../../theseus/core/view'

// Where the page's data comes from: the server /theseus ui started, with the token its address carries; or, for a
// run's report, the data written into the page itself.

/** A view as the plugin kept it at a moment: the model with no events, and when. */
export type Snapshot = Omit<RunView, 'events'> & { at: number }
export type RunEntry = { file: string; view: Snapshot }
export type RunData = { views: Snapshot[]; events: RunEvent[] }

declare global {
  interface Window {
    __THESEUS_REPORT__?: { file: string; data: RunData }
  }
}

const token = new URLSearchParams(location.search).get('token') ?? ''

/** The report written into the page, when it is one. */
export const report = window.__THESEUS_REPORT__

const get = async <T,>(path: string): Promise<T> => {
  const answer = await fetch(path, { headers: { 'x-theseus-token': token } })

  if (!answer.ok) throw new Error(((await answer.json().catch(() => ({}))) as { error?: string }).error ?? `${path} answered ${answer.status}`)

  return (await answer.json()) as T
}

export const runData = (file: string): Promise<RunData> => (report !== undefined && report.file === file ? Promise.resolve(report.data) : get<RunData>(`/api/run?file=${encodeURIComponent(file)}`))

/** Every run, as it changes: the callback is called with each new list, until the returned function is called. */
export const watchRuns = (onRuns: (runs: RunEntry[]) => void, onError: (why: string) => void): (() => void) => {
  if (report !== undefined) {
    const last = report.data.views.at(-1)

    onRuns(last === undefined ? [] : [{ file: report.file, view: last }])
    return () => undefined
  }

  const stream = new EventSource(`/api/stream?token=${encodeURIComponent(token)}`)

  stream.addEventListener('runs', message => onRuns(JSON.parse((message as MessageEvent<string>).data) as RunEntry[]))
  stream.onerror = () => onError('The connection to Theseus was lost: is the session that ran /theseus ui still open?')

  return () => stream.close()
}

/** Asks for an action on a run: the plugin does it on its next tick, through the same command the terminal uses. */
export const ask = async (ref: string, action: string): Promise<void> => {
  const answer = await fetch('/api/action', { method: 'POST', headers: { 'content-type': 'application/json', 'x-theseus-token': token }, body: JSON.stringify({ ref, action }) })

  if (!answer.ok) throw new Error(((await answer.json().catch(() => ({}))) as { error?: string }).error ?? `the action answered ${answer.status}`)
}
