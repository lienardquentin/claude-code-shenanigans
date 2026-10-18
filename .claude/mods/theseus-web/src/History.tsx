import type { RunEntry } from './api'
import { day, durationOf } from './format'

// Every run the project's views hold, the latest first: how it stands or ended, how far it got, how long it took.

const STATUS = (entry: RunEntry): { label: string; tone: string } =>
  entry.view.pr !== '' ? { label: 'pull request', tone: 'done' } : entry.view.phase === 'stuck' ? { label: 'stopped', tone: 'stopped' } : entry.view.phase === 'submitted' ? { label: 'submitted', tone: 'done' } : entry.view.waiting !== null ? { label: 'waiting', tone: 'waiting' } : { label: entry.view.said, tone: 'running' }

export function History({ runs, onOpen }: { runs: RunEntry[]; onOpen: (file: string) => void }) {
  if (runs.length === 0) return <div className="panel empty">No run yet. /theseus build starts one, and it shows here as it goes.</div>

  const finished = runs.filter(entry => entry.view.pr !== '').length

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div className="facts">
        <span><b>{runs.length}</b> runs</span>
        <span><b>{finished}</b> reached a pull request</span>
        <span><b>{runs.reduce((sum, entry) => sum + entry.view.done, 0)}</b> tasks committed</span>
      </div>
      <div className="panel table-wrap">
        <table className="hist num">
          <thead>
            <tr><th>Run</th><th>Status</th><th>Started</th><th>Took</th><th>Tasks</th><th>Pull request</th></tr>
          </thead>
          <tbody>
            {runs.map(entry => {
              const status = STATUS(entry)

              return (
                <tr key={entry.file} className="link" tabIndex={0} onClick={() => onOpen(entry.file)} onKeyDown={event => event.key === 'Enter' && onOpen(entry.file)}>
                  <td><b>{entry.view.ref}</b> {entry.view.title}</td>
                  <td><span className={`pill ${status.tone}`}><i />{status.label}</span></td>
                  <td className="muted">{day(entry.view.startedAt)}</td>
                  <td>{durationOf(entry.view.lastAt - entry.view.startedAt)}</td>
                  <td>{`${entry.view.done} / ${entry.view.total}`}</td>
                  <td className="mono">{entry.view.pr !== '' ? entry.view.pr.replace(/^https?:\/\//, '') : '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
