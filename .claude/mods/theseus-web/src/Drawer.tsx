import { STEPS } from '../../theseus/core/view'
import type { Step } from '../../theseus/core/view'
import type { RunEvent } from '../../theseus/core/events'
import type { Snapshot } from './api'
import { clock, durationOf } from './format'

// What is picked, in full: a task's steps with when each began and how long it took, its events, and why it waits or
// stopped; or, with nothing picked, the run's own standing and actions.

// The event that begins each step of a task, read off the run's log
const STEP_BEGUN: Record<Step, (event: RunEvent) => boolean> = {
  tests: event => event.kind === 'working' && /tests of task \d+ first/.test(event.text),
  build: event => event.kind === 'sent',
  prove: event => event.kind === 'working' && /^Proving task/.test(event.text),
  review: event => event.kind === 'working' && /^Reviewing task/.test(event.text),
  commit: event => event.kind === 'committed',
}

export function Drawer({ view, events, selected, onAction, isReplay, now }: { view: Snapshot; events: RunEvent[]; selected: number | null; onAction: (id: string) => void; isReplay: boolean; now: number }) {
  const task = view.tasks.find(one => one.id === selected)
  const own = task === undefined ? events : events.filter(event => event.task === task.id || ((event.kind === 'working' || event.kind === 'note') && event.text.includes(`task ${task.id}`)))

  return (
    <aside className="panel drawer" aria-label="Detail">
      {task === undefined ? (
        <section>
          <h2>{view.title}</h2>
          <div className="muted">{`${view.kind} · ${view.said} · ${view.done}/${view.total} tasks done`}</div>
          {view.waiting !== null && <div className="notice wait">{`Waiting until ${clock(view.waiting.until)}: ${view.waiting.why}`}</div>}
          {view.stopped !== '' && <div className="notice fail">{`Stopped: ${view.stopped}`}</div>}
          <div className="muted">Pick a task in the graph to see its steps and events.</div>
        </section>
      ) : (
        <>
          <section>
            <div className="muted mono">{`Task ${task.id} · ${task.weight}${task.isLane ? ' · lane' : ''}`}</div>
            <h2>{task.title}</h2>
            <div className="muted">{`${task.standing}${task.builder !== '' ? ` · ${task.builder}` : ''}${task.attempt > 1 ? ` · try ${task.attempt}` : ''}${task.sha !== '' ? ` · ${task.sha}` : ''}`}</div>
            {task.why !== '' && <div className={`notice ${task.standing === 'stopped' ? 'fail' : 'wait'}`}>{task.why}</div>}
          </section>
          <section>
            <h3>Steps</h3>
            <table className="steps num">
              <tbody>
                {STEPS.map((step, at) => {
                  const begun = own.find(STEP_BEGUN[step])
                  const next = STEPS.slice(at + 1).map(later => own.find(STEP_BEGUN[later])).find(found => found !== undefined)
                  const ended = task.steps[step] === 'done' ? (next?.at ?? (task.doneAt > 0 ? task.doneAt : undefined)) : undefined

                  return (
                    <tr key={step} data-step={step}>
                      <td>
                        <span className={`dot ${task.steps[step]}`} />
                        {step}
                      </td>
                      <td className="r mono">{begun !== undefined ? clock(begun.at) : ''}</td>
                      <td className="r">{begun !== undefined ? durationOf((ended ?? now) - begun.at) : task.steps[step] === 'skipped' ? 'skipped' : ''}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </section>
        </>
      )}
      <section>
        <h3>{task === undefined ? 'Events' : `Events of task ${task.id}`}</h3>
        <div className="log">{own.length === 0 ? 'Nothing yet.' : own.slice(-40).map(event => `${clock(event.at)}  ${event.text}`).join('\n')}</div>
      </section>
      {!isReplay && view.actions.length > 0 && (
        <section>
          <h3>Actions</h3>
          <div className="actions">
            {view.actions.map(action => (
              <button key={action.id} className={`btn${action.id === 'abandon' ? ' danger' : ''}`} title={action.command} onClick={() => onAction(action.id)}>
                {action.label}
              </button>
            ))}
          </div>
        </section>
      )}
    </aside>
  )
}
