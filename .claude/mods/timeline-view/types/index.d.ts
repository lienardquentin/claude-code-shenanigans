/**
 * One stretch of work on the timeline: a turn of the main conversation, or one tool call. Times are milliseconds
 * since the epoch; a span with no `end` still runs.
 */
export type TimelineSpan = {
  id: string
  /** The lane it is drawn in: `main`, or the id of the subagent whose loop it ran in. */
  lane: string
  kind: 'turn' | 'tool'
  /** The tool's name; `turn` for a turn. */
  name: string
  /** What it worked on, in one line: a command, a file, a pattern, a turn's prompt. Empty when the call names none. */
  target: string
  start: number
  end?: number
  /** True when the tool reported an error or was refused, or the turn died on one. */
  failed?: boolean
}

/** One subagent's lane: from its spawn to the end of its run. A lane with no `end` is still at work. */
export type TimelineLane = {
  /** The subagent's id, as its loop's events carry it. */
  id: string
  /** What it is called in the pane: the task's short description, else its agent type. */
  label: string
  start: number
  end?: number
}

declare module 'claude-code' {
  interface PluginState {
    'timeline-view': {
      /** Every span recorded this session, oldest first, the oldest dropped past a limit. */
      spans: TimelineSpan[]
      /** The subagents seen this session; the main conversation's lane is not kept, it always exists. */
      lanes: TimelineLane[]
      /** The lane whose calls are listed under the drawing. */
      selected: string
      /** The period the drawing is limited to: `all`, `turn`, or a number of minutes (`5m`). */
      range: string
      /** Time of the last redraw the clock asked for, so what still runs grows. */
      now: number
    }
  }
}
