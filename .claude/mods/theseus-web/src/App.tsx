import { useEffect, useMemo, useState } from 'react'

import { ask, report, runData, watchRuns } from './api'
import type { RunData, RunEntry } from './api'
import { Drawer } from './Drawer'
import { durationOf } from './format'
import { Graph } from './Graph'
import { History } from './History'
import { Replay } from './Replay'

// The page: the run picked (live, or played again from its log) as its graph beside the detail of what is picked, its
// course under it; and the history of every run.

const pillOf = (phase: string, isWaiting: boolean): string => (phase === 'stuck' ? 'stopped' : isWaiting ? 'waiting' : phase === 'submitted' || phase === 'built' ? 'done' : phase === 'ready' ? 'quiet' : 'running')

export function App() {
  const [runs, setRuns] = useState<RunEntry[]>([])
  const [file, setFile] = useState<string>(report?.file ?? '')
  const [data, setData] = useState<RunData>({ views: [], events: [] })
  const [tab, setTab] = useState<'run' | 'history'>('run')
  const [selected, setSelected] = useState<number | null>(null)
  const [cursor, setCursor] = useState<number | null>(null)
  const [isPlaying, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(4)
  const [notice, setNotice] = useState('')
  const [now, setNow] = useState(Date.now())

  useEffect(() => watchRuns(found => setRuns(found), why => setNotice(why)), [])
  useEffect(() => {
    if (file === '' && runs[0] !== undefined) setFile(runs[0].file)
  }, [runs, file])
  // The run picked is read again whenever the runs change: a new view, a new event
  const stamp = runs.find(entry => entry.file === file)?.view.lastAt ?? 0
  useEffect(() => {
    if (file !== '') void runData(file).then(setData, (error: Error) => setNotice(error.message))
  }, [file, stamp])
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)

    return () => clearInterval(timer)
  }, [])

  // Playing steps through the kept views at their own pace, sped up
  useEffect(() => {
    if (!isPlaying || cursor === null) return
    const here = data.views[cursor]
    const next = data.views[cursor + 1]

    if (here === undefined || next === undefined) {
      setPlaying(false)
      return
    }
    const timer = setTimeout(() => setCursor(cursor + 1), Math.min(2000, Math.max(120, (next.at - here.at) / speed)))

    return () => clearTimeout(timer)
  }, [isPlaying, cursor, speed, data.views])

  const live = data.views.at(-1)
  const view = cursor === null ? live : (data.views[cursor] ?? live)
  const times = useMemo(() => data.views.map(one => one.at), [data.views])
  // A run counts its time while it goes on by itself or has an agent out, not while it waits for you
  const isGoing = cursor === null && view !== undefined && !['stuck', 'built', 'submitted', 'ready'].includes(view.phase)

  const act = (action: string) => {
    if (view === undefined) return
    ask(view.ref, action).then(
      () => setNotice(`Asked: ${view.actions.find(one => one.id === action)?.label ?? action}. Theseus does it on its next tick.`),
      (error: Error) => setNotice(error.message),
    )
  }

  useEffect(() => {
    if (notice === '') return
    const timer = setTimeout(() => setNotice(''), 4000)

    return () => clearTimeout(timer)
  }, [notice])

  return (
    <div className="app">
      {view === undefined ? (
        <header className="top">
          <h1>Theseus</h1>
        </header>
      ) : (
        <header style={{ display: 'grid', gap: 10 }}>
          <div className="top">
            <h1>
              <span className="ref">{view.ref}</span> {view.title}
            </h1>
            <span className={`pill ${pillOf(view.phase, view.waiting !== null)}`}>
              <i />
              {view.said}
            </span>
            {report !== undefined && <span className="pill quiet">report</span>}
            <span className="spacer" />
            {runs.length > 1 && (
              <select className="btn" aria-label="Run" value={file} onChange={event => (setFile(event.target.value), setCursor(null), setSelected(null))}>
                {runs.map(entry => (
                  <option key={entry.file} value={entry.file}>
                    {entry.view.ref}
                  </option>
                ))}
              </select>
            )}
          </div>
          <div className="facts num">
            <span><b>{`${view.done} of ${view.total}`}</b> tasks done</span>
            <span>
              {isGoing ? 'Elapsed' : 'Took'} <b>{durationOf((isGoing ? now : view.lastAt) - view.startedAt)}</b>
            </span>
            <span className="mono">{`${view.branch} ← ${view.base}`}</span>
            {view.isAuto && <span>Going on by itself</span>}
            {view.pr !== '' && <span className="mono">{view.pr}</span>}
          </div>
        </header>
      )}

      <nav className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'run'} onClick={() => setTab('run')}>Run</button>
        <button role="tab" aria-selected={tab === 'history'} onClick={() => setTab('history')}>History</button>
      </nav>

      {tab === 'history' ? (
        <History runs={runs} onOpen={next => (setFile(next), setCursor(null), setSelected(null), setTab('run'))} />
      ) : view === undefined ? (
        <div className="panel empty">No run yet. /theseus build starts one, and it shows here as it goes.</div>
      ) : (
        <div className="run-view">
          <div style={{ display: 'grid', gap: 14, minWidth: 0 }}>
            <Graph view={view} selected={selected} onSelect={setSelected} now={cursor === null ? now : view.at} />
            <Replay
              times={times}
              at={cursor ?? Math.max(0, times.length - 1)}
              isLive={cursor === null}
              isPlaying={isPlaying}
              speed={speed}
              events={data.events}
              onScrub={index => (setPlaying(false), setCursor(index))}
              onPlay={() => (cursor === null || cursor >= times.length - 1 ? (setCursor(0), setPlaying(true)) : setPlaying(!isPlaying))}
              onLive={() => (setPlaying(false), setCursor(null))}
              onSpeed={setSpeed}
            />
          </div>
          <Drawer view={view} events={data.events.filter(event => event.at <= (cursor === null ? Number.MAX_SAFE_INTEGER : view.at))} selected={selected} onAction={act} isReplay={cursor !== null || report !== undefined} now={cursor === null ? now : view.at} />
        </div>
      )}
      {notice !== '' && <div className="toast" role="status">{notice}</div>}
    </div>
  )
}
