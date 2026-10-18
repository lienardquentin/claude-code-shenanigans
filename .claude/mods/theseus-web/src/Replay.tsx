import type { RunEvent } from '../../theseus/core/events'
import { clock, durationOf } from './format'

// The run's course: a scrubber over every view the plugin kept of it, to play it again from its start at any speed or
// stop at any moment, and its events up to that moment, the latest first.

const SPEEDS = [1, 4, 16, 64]

export function Replay(props: {
  times: number[]
  at: number
  isLive: boolean
  isPlaying: boolean
  speed: number
  events: RunEvent[]
  onScrub: (index: number) => void
  onPlay: () => void
  onLive: () => void
  onSpeed: (speed: number) => void
}) {
  const { times, at, isLive, isPlaying, speed, events } = props
  const first = times[0] ?? 0
  const now = times[at] ?? first

  return (
    <div className="panel">
      <div className="replay">
        <div className="controls">
          <button className="play" aria-label={isPlaying ? 'Pause' : 'Play the run again'} onClick={props.onPlay}>
            <svg viewBox="0 0 14 14">{isPlaying ? <><rect x="2" y="1" width="3.5" height="12" rx="1" /><rect x="8.5" y="1" width="3.5" height="12" rx="1" /></> : <path d="M3 1.5v11l9.5-5.5z" />}</svg>
          </button>
          <span className="mono num">{`${clock(now)} · ${durationOf(now - first)} into the run`}</span>
          <span className="spacer" />
          <label className="muted" htmlFor="speed">Speed</label>
          <select id="speed" className="btn" value={speed} onChange={event => props.onSpeed(Number(event.target.value))}>
            {SPEEDS.map(one => (
              <option key={one} value={one}>{`${one}×`}</option>
            ))}
          </select>
          <button className="btn" disabled={isLive} onClick={props.onLive}>
            {isLive ? 'Live' : 'Back to live'}
          </button>
        </div>
        <input className="scrub" type="range" aria-label="Moment of the run" min={0} max={Math.max(0, times.length - 1)} value={at} onChange={event => props.onScrub(Number(event.target.value))} />
      </div>
      <ul className="events" aria-label="Events">
        {events
          .filter(event => event.at <= now)
          .slice(-60)
          .reverse()
          .map((event, index) => (
            <li key={`${event.at}-${index}`}>
              <span className="t">{clock(event.at)}</span>
              <span className={`${event.kind}${event.to !== undefined ? ` ${event.to}` : ''}`}>{event.text}</span>
              <span className="cause">{event.cause}</span>
            </li>
          ))}
      </ul>
    </div>
  )
}
