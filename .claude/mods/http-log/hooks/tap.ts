import type { HttpLogCall } from '../types'

// What the two taps report. The wrapper (tap/http-log-tap.ps1) writes `via: 'wrapper'` lines, one per Invoke-RestMethod
// or Invoke-WebRequest, with everything; the proxy (tap/http_log_proxy.py) writes `via: 'proxy'` lines, with everything
// for plain HTTP and only the host, bytes and duration for an HTTPS tunnel.
export type TapEvent = {
  via: 'wrapper' | 'proxy'
  /** The command the proxy was told the request belongs to, when the client sent it. */
  token: string
  ts: number
  method: string
  url: string
  code: number
  codeText: string
  durationMs: number
  ok: boolean
  body?: string
  result?: string
  bytes?: number
  /** True for an HTTPS CONNECT tunnel: nothing but its host is known. */
  tunnel: boolean
}

// Commands that can reach the network: only they are given a tap, so `ls` or `git status` is run as it was written.
// It reads the text, so it is a guess: a command that only names one of these gets the line too, and logs nothing.
export const NETWORK_HINT = new RegExp(
  [
    String.raw`\b(?:curl(?:\.exe)?|wget|invoke-(?:restmethod|webrequest)|irm|iwr|python3?|py|node|npm|npx|pnpm|yarn|pip3?|uv|poetry|cargo|dotnet|ruby|gem|bundle|php|composer|java|mvn|gradle|deno|bun|az|aws|gcloud|gh|glab|kubectl|helm|terraform|ssh|scp)\b`,
    // only the subcommands that go out
    String.raw`\bgit\s+(?:clone|fetch|pull|push|ls-remote|submodule|remote|lfs)\b`,
    String.raw`\bdocker\s+(?:pull|push|build|run|compose|login|search)\b`,
    String.raw`\bgo\s+(?:get|install|mod|run|build|test)\b`,
    String.raw`https?:\/\/`,
    String.raw`\.(?:py|js|mjs|ts|ps1|sh|rb|php)\b`,
  ].join('|'),
  'i',
)

export const parseEvents = (text: string): TapEvent[] =>
  text.split('\n').flatMap((line): TapEvent[] => {
    if (line.trim() === '') return []

    try {
      const value = JSON.parse(line) as Partial<TapEvent>

      return typeof value.url === 'string' && typeof value.method === 'string'
        ? [
            {
              via: value.via === 'proxy' ? 'proxy' : 'wrapper',
              token: typeof value.token === 'string' ? value.token : '',
              ts: typeof value.ts === 'number' ? value.ts : 0,
              method: value.method.toUpperCase(),
              url: value.url,
              code: typeof value.code === 'number' ? value.code : 0,
              codeText: typeof value.codeText === 'string' ? value.codeText : '',
              durationMs: typeof value.durationMs === 'number' ? value.durationMs : 0,
              ok: value.ok !== false,
              body: typeof value.body === 'string' ? value.body : undefined,
              result: typeof value.result === 'string' ? value.result : undefined,
              bytes: typeof value.bytes === 'number' ? value.bytes : undefined,
              tunnel: value.tunnel === true,
            },
          ]
        : []
    } catch {
      return []
    }
  })

const psQuote = (text: string): string => `'${text.replace(/'/g, "''")}'`
const shQuote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`

// The one line put before a PowerShell command: where the wrapper logs, which proxy to use and the wrapper itself.
// The wrapper is evaluated from its text, not dot-sourced: a script file is refused where the execution policy is
// Restricted, which is the default on Windows, and text handed to Invoke-Expression is not a script file.
export const powershellPrelude = (input: { file: string; proxy?: string; script: string }): string =>
  `$env:HTTPLOG_FILE=${psQuote(input.file)};` +
  (input.proxy === undefined ? '' : `$env:HTTPLOG_PROXY=${psQuote(input.proxy)};`) +
  `Invoke-Expression ([System.IO.File]::ReadAllText(${psQuote(input.script)}))\n`

// The one line put before a bash command: every client that reads a proxy variable goes through the proxy
export const bashPrelude = (input: { proxy: string }): string => {
  const proxy = shQuote(input.proxy)
  const names = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']

  // curl -i and -v print the proxy's answer to a tunnel request as if it were the response: a function in front of it
  // asks it not to, so the output is what it is without the proxy
  const curl = `curl() { command curl --suppress-connect-headers "$@"; }`

  return `export ${names.map(name => `${name}=${proxy}`).join(' ')} NO_PROXY='localhost,127.0.0.1,::1' no_proxy='localhost,127.0.0.1,::1'; ${curl}\n`
}

const hostOf = (url: string): string => /^[a-z][a-z0-9+.-]*:\/\/(?:[^/@]*@)?([^/:?#]+)/i.exec(url)?.[1]?.toLowerCase() ?? ''

/**
 * Merges what the taps saw into the rows a command already has from reading its text.
 *
 * A request the wrapper or the proxy saw in full takes the place of the row that came from the text. An HTTPS tunnel
 * adds its bytes to a row for the same host, or is a row of its own (one per host) when the text named nothing for it.
 * The wrapper and the proxy both see a request a PowerShell 7 cmdlet makes: it is kept once, from the wrapper.
 */
export const mergeTap = (input: {
  rows: readonly HttpLogCall[]
  events: readonly TapEvent[]
  agent: string | undefined
  command: string | undefined
  newId: () => string
  at: (ts: number) => string
}): HttpLogCall[] => {
  const { rows, events, newId, at } = input
  const wrapper = events.filter(event => event.via === 'wrapper')
  const proxied = events.filter(event => event.via === 'proxy' && !event.tunnel)
  const tunnels = events.filter(event => event.via === 'proxy' && event.tunnel)
  const taken = new Set<TapEvent>()
  const same = (event: TapEvent, row: { url: string; method?: string }) =>
    event.url === row.url && event.method === (row.method ?? 'GET')

  // A request in full, for each: the wrapper's first, then the proxy's plain HTTP; one the wrapper had is not again
  const full: TapEvent[] = [...wrapper]
  for (const event of proxied) {
    const twin = full.find(other => !taken.has(other) && same(other, event) && Math.abs(other.ts - event.ts) < 5000)

    if (twin === undefined) full.push(event)
    else taken.add(twin)
  }

  // The rows from the command's text that something saw in full are replaced by what it saw
  const kept: HttpLogCall[] = []
  const used = new Set<TapEvent>()
  for (const row of rows) {
    const seen = full.find(event => !used.has(event) && same(event, row))

    if (seen === undefined) kept.push(row)
    else used.add(seen)
  }

  // A tunnel for a host a row or a full request already names only adds its size to that row; the rest are rows
  const named = new Set<string>([...kept.map(row => hostOf(row.url)), ...full.map(event => hostOf(event.url))])
  const bytesByHost = new Map<string, number>()
  const loose = new Map<string, TapEvent>()

  for (const tunnel of tunnels) {
    const host = hostOf(tunnel.url)

    if (named.has(host)) bytesByHost.set(host, (bytesByHost.get(host) ?? 0) + (tunnel.bytes ?? 0))
    else {
      const held = loose.get(tunnel.url)
      loose.set(
        tunnel.url,
        held === undefined
          ? tunnel
          : {
              ...held,
              ts: Math.min(held.ts, tunnel.ts),
              bytes: (held.bytes ?? 0) + (tunnel.bytes ?? 0),
              durationMs: Math.max(held.durationMs, tunnel.durationMs),
              ok: held.ok && tunnel.ok,
            },
      )
    }
  }

  const fromEvent = (event: TapEvent): HttpLogCall => ({
    id: newId(),
    url: event.url,
    code: event.code,
    codeText: event.codeText,
    durationMs: event.durationMs,
    at: at(event.ts),
    ts: event.ts,
    limited: false,
    pending: false,
    ok: event.ok,
    method: event.method,
    agent: input.agent,
    command: input.command,
    body: event.body,
    result: event.result,
    bytes: event.bytes,
    via: event.tunnel ? 'tunnel' : event.via,
  })

  const enriched = kept.map(row => {
    const bytes = bytesByHost.get(hostOf(row.url))

    return bytes !== undefined && row.bytes === undefined ? { ...row, bytes } : row
  })

  return [...enriched, ...full.map(fromEvent), ...[...loose.values()].map(fromEvent)].sort((a, b) => a.ts - b.ts)
}
