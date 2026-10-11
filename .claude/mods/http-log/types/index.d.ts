/**
 * One HTTP call the session made. `code` is the response code, or 0 when the call failed before one came.
 * `limited` marks a call the rate limiter refused: it never went out.
 */
export type HttpLogCall = {
  id: string
  url: string
  code: number
  codeText: string
  durationMs: number
  at: string
  /** Milliseconds since the epoch, when the call started. */
  ts: number
  limited: boolean
  /** True from the call's start until its response (or failure) came. */
  pending: boolean
  /** What WebFetch was asked to do with the page. */
  prompt?: string
  /** The agent that made the call: its name, else its type (`Explore`); absent when the main loop did. */
  agent?: string
  /** The HTTP method, for a request made from a shell command (curl, Invoke-RestMethod); WebFetch calls have none. */
  method?: string
  /** What the request sent, for a shell command that sent a body. */
  body?: string
  /** The shell command that made the request, cut to a few thousand characters. Absent for WebFetch. */
  command?: string
  /**
   * How the request was seen when the command's text did not say: by the PowerShell wrapper (`wrapper`, in full), by
   * the proxy (`proxy`, in full for plain HTTP) or as an HTTPS tunnel (`tunnel`: the host and the bytes only).
   */
  via?: 'wrapper' | 'proxy' | 'tunnel'
  /** Whether the tool ran without an error or interruption, once the call finished. */
  ok?: boolean
  /** Size of the fetched content in bytes, once the response came. */
  bytes?: number
  /** The url the response came from, when it differs from `url` (a redirect). */
  finalUrl?: string
  /** The start of the processed result, cut to a few thousand characters. */
  result?: string
}

/**
 * A rate limit for the calls whose url a regex matches. They share one counter. The first rule that matches
 * decides; a rule with an empty or invalid pattern, or a limit of 0, matches nothing.
 */
export type HttpLogRule = {
  id: string
  /** A JavaScript regex source, tested against the whole url. */
  pattern: string
  /** Most matching calls allowed in any 60 seconds. */
  limit: number
}

declare module 'claude-code' {
  interface PluginState {
    'http-log': {
      calls: HttpLogCall[]
      regexRules: HttpLogRule[]
      /** What the table is filtered by; empty shows every call. Per session: the pane's own. */
      search: string
      /** Id of the call whose details are shown under the table; empty shows none. Per session: the pane's own. */
      selected: string
      /** What the last Copy button copied, as `<call id>:<field>`; empty when nothing was or the copy failed. Per session. */
      copied: string
      /** What the taps are doing, for the pane to say: the wrapper and the proxy. Per session. */
      capture: string
      /** The period the table is limited to: `all`, or a configured period's key (`10m`, `1h`). Per session. */
      range: string
      /** Time of the last redraw a period asked for, so calls age out of the table. Per session. */
      now: number
    }
  }
}
