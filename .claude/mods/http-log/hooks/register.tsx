import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface } from 'claude-code'

import type { HttpLogCall, HttpLogRule } from '../types'
import { actionLabel } from './kit/action-label'
import { badge } from './kit/badge'
import { card } from './kit/card'
import { code } from './kit/code'
import { divider } from './kit/divider'
import { field } from './kit/field'
import { json } from './kit/json'
import { paneView } from './kit/pane-text'
import { yaml } from './kit/yaml'
import { table } from './kit/table'
import type { CellTone } from './kit/table'
import { NETWORK_HINT, bashPrelude, mergeTap, parseEvents, powershellPrelude } from './tap'
import type { TapEvent } from './tap'

const PANE = 'http-log'
const MAX_CALLS = 200
const WINDOW_MS = 60_000
const STARTER_LIMIT = 10
const REFRESH_MS = 5_000

// The rules and the calls live in the plugin's `$.store`: kept between sessions and shared by every session that
// loads this mod, so a limit holds across them. The atoms below are the pane's copy of it, which a `ui.render`
// hook can subscribe to; they are re-read from the store on each call, command and refresh tick.
const STORE_RULES = 'rules'
const STORE_CALLS = 'calls'

const calls = atom({ plugin: 'http-log', key: 'calls' } as const, [] as HttpLogCall[])
const rules = atom({ plugin: 'http-log', key: 'regexRules' } as const, [] as HttpLogRule[])
// The pane's filter: the viewer's own, kept in this session and not shared through the store
const search = atom({ plugin: 'http-log', key: 'search' } as const, '')
// The call whose details the pane shows under the table: the viewer's own too
const selected = atom({ plugin: 'http-log', key: 'selected' } as const, '')
// What the last Copy button copied (the call's id and the field), so that button can say `Copied`
const copied = atom({ plugin: 'http-log', key: 'copied' } as const, '')
// What the taps are doing, for the pane to say
const capture = atom({ plugin: 'http-log', key: 'capture' } as const, '')
// The period the table is limited to: `all`, or the key of one of the configured periods (`10m`, `1h`)
const range = atom({ plugin: 'http-log', key: 'range' } as const, 'all')
// The time of the last redraw a period asked for: touched while one is in force, so calls age out of the table
const tick = atom({ plugin: 'http-log', key: 'now' } as const, 0)

// What the pane last drew, for the model to read
const view = paneView({ id: PANE, title: 'HTTP calls', command: '/http-log' })

const DEFAULT_PERIODS = '10m,30m,1h'
const MAX_PERIODS = 6
const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const
const UNIT_NAME = { s: 'sec', m: 'min', h: 'hour', d: 'day' } as const

type Period = { key: string; label: string; ms: number }

// "10m,30m,1h" as periods: a number and s, m, h or d (minutes when it has no unit). Anything else in the list is left
// out, and a list with nothing usable is the default one.
const parsePeriods = (text: unknown): Period[] => {
  const listOf = (source: string): Period[] =>
    source
      .split(/[,;\s]+/)
      .flatMap((item): Period[] => {
        const match = /^(\d{1,4})\s*([smhd])?$/i.exec(item.trim())
        if (match === null) return []

        const amount = Number(match[1])
        const unit = (match[2]?.toLowerCase() ?? 'm') as keyof typeof UNIT_MS
        const noun = UNIT_NAME[unit]

        return amount > 0
          ? [
              {
                key: `${amount}${unit}`,
                label: unit === 'h' || unit === 'd' ? `${amount} ${noun}${amount === 1 ? '' : 's'}` : `${amount} ${noun}`,
                ms: amount * UNIT_MS[unit],
              },
            ]
          : []
      })
      .filter((period, index, all) => all.findIndex(other => other.key === period.key) === index)
      .sort((a, b) => a.ms - b.ms)
      .slice(0, MAX_PERIODS)

  const given = typeof text === 'string' ? listOf(text) : []

  return given.length > 0 ? given : listOf(DEFAULT_PERIODS)
}
// A result is kept whole enough to parse as JSON; only the newest calls carry theirs, so the store stays small
const RESULT_PREVIEW = 20_000
const RESULT_KEPT = 20

// The end of the first balanced `{...}` or `[...]` in the text, past strings and escapes; -1 when it never closes
const endOfJson = (text: string, start: number): number => {
  let depth = 0
  let inString = false

  for (let at = start; at < text.length; at += 1) {
    const char = text[at]

    if (inString) {
      if (char === '\\') at += 1
      else if (char === '"') inString = false
    } else if (char === '"') inString = true
    else if (char === '{' || char === '[') depth += 1
    else if (char === '}' || char === ']') {
      depth -= 1
      if (depth === 0) return at + 1
    }
  }

  return -1
}

// The JSON in a result, formatted, with whatever text came around it (a code fence, WebFetch's own note).
// Without a JSON value in it the result is drawn as it came.
const formatResult = (raw: string): { source: string; language?: string; rest: string } => {
  // Text and Code take no control character but tab and newline: a Windows command's \r\n or a progress meter's
  // escapes would make the whole tree refused, so they are taken out before anything is drawn or copied
  // eslint-disable-next-line no-control-regex
  const text = raw.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
  const start = text.search(/[{[]/)
  const end = start === -1 ? -1 : endOfJson(text, start)

  if (end !== -1) {
    try {
      const around = `${text.slice(0, start)}${text.slice(end)}`.replace(/```(?:json)?/gi, '').trim()

      return { source: json(JSON.parse(text.slice(start, end))), language: 'json', rest: around }
    } catch {
      // Not JSON after all: fall through to the plain text
    }
  }

  return { source: text, rest: '' }
}

type Engine = EngineInterface

const newId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

const loadRules = async ($: Engine): Promise<HttpLogRule[]> => {
  const value = await $.store.get(STORE_RULES)

  return Array.isArray(value) ? (value as HttpLogRule[]) : []
}

// How long a call is kept: the mod's `retention` setting, an hour unless it says otherwise. Set by `register`.
let retentionMs = 3_600_000

const isKept = (call: HttpLogCall, now: number): boolean => now - call.ts <= retentionMs

// Every read of the calls leaves out the ones older than the retention, so nothing older is shown, counted or written
// back; `refresh` also takes them out of the store itself, for a session nobody is calling from.
const loadCalls = async ($: Engine): Promise<HttpLogCall[]> => {
  const value = await $.store.get(STORE_CALLS)
  const now = Date.now()

  return Array.isArray(value) ? (value as HttpLogCall[]).filter(call => isKept(call, now)) : []
}

// Reads and writes of the store run one after another in this session, so calls made together are counted
// together. Two sessions can still interleave between a read and a write: the limit then is best effort.
let queue: Promise<unknown> = Promise.resolve()

const exclusive = <T,>(work: () => Promise<T>): Promise<T> => {
  const run = queue.then(work, work)
  queue = run.then(
    () => undefined,
    () => undefined,
  )

  return run
}

// Brings the pane's copy up to the store, drawing again only when it differs
const refresh = async ($: Engine): Promise<void> => {
  // Calls past the retention are removed from the store, where every session shares them
  const raw = await $.store.get(STORE_CALLS)
  const now = Date.now()

  if (Array.isArray(raw) && (raw as HttpLogCall[]).some(call => !isKept(call, now))) {
    await exclusive(async () => $.store.set(STORE_CALLS, await loadCalls($)))
  }

  const [storedRules, storedCalls] = await Promise.all([loadRules($), loadCalls($)])

  if (JSON.stringify(await read($, rules)) !== JSON.stringify(storedRules)) await update($, rules, () => storedRules)
  if (JSON.stringify(await read($, calls)) !== JSON.stringify(storedCalls)) await update($, calls, () => storedCalls)
}

// The pane shows the change at once, the store takes it from the rules as they stand there
const changeRules = async ($: Engine, change: (list: HttpLogRule[]) => HttpLogRule[]): Promise<void> => {
  await update($, rules, change)
  await exclusive(async () => $.store.set(STORE_RULES, change(await loadRules($))))
}

// The id is made once, so the pane's copy and the store's hold the same rule
const addRule = (($: Engine, pattern: string): Promise<void> => {
  const rule: HttpLogRule = { id: newId(), pattern, limit: STARTER_LIMIT }

  return changeRules($, current => [...current, rule])
})

const clearCalls = async ($: Engine): Promise<void> => {
  await update($, calls, () => [])
  await exclusive(async () => $.store.set(STORE_CALLS, []))
}

const compile = (pattern: string): RegExp | undefined => {
  if (pattern === '') return undefined

  try {
    return new RegExp(pattern)
  } catch {
    return undefined
  }
}

// The first rule in force whose regex matches the url
const ruleFor = (url: string, list: readonly HttpLogRule[]): HttpLogRule | undefined =>
  list.find(rule => rule.limit > 0 && compile(rule.pattern)?.test(url) === true)

// A regex that matches this url and its query variants, for a rule made from a row
const patternFor = (url: string): string =>
  `^${url.replace(/[?#].*$/, '').replace(/\/+$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/?(\\?.*)?$`

const toneOf = (code: number): CellTone =>
  code >= 200 && code < 300 ? 'success' : code >= 300 && code < 400 ? 'info' : code >= 400 && code < 500 ? 'warning' : 'danger'

const clock = (date: Date) => date.toTimeString().slice(0, 8)

const toCount = (text: string) => Math.min(Number.parseInt(text.replace(/\D/g, ''), 10) || 0, 100_000)

// What a request is made of, whichever tool made it. WebFetch is always a GET with a prompt; a shell command has a
// method, and a body when it sends one.
type Request = { url: string; method?: string; body?: string; prompt?: string; agent?: string; command?: string }
// What a tool's result says about the response. `code` is 0 when it carried none.
type Outcome = { code: number; codeText: string; ok: boolean; bytes?: number; finalUrl?: string; result?: string }
type Ran = { deny?: string; isError?: boolean; result?: unknown }

const resultOf = (ran: Ran): Record<string, unknown> | undefined =>
  ran.deny === undefined && ran.isError !== true && typeof ran.result === 'object' && ran.result !== null
    ? (ran.result as Record<string, unknown>)
    : undefined

const fetchOutcome = (ran: Ran): Outcome => {
  const result = resultOf(ran) as { code?: number; codeText?: string; bytes?: number; url?: string; result?: string } | undefined

  return {
    code: result?.code ?? 0,
    codeText: result?.codeText ?? '',
    ok: result !== undefined,
    bytes: result?.bytes,
    finalUrl: result?.url,
    result: typeof result?.result === 'string' ? result.result : undefined,
  }
}

// A shell command has no response code of its own: it is read from the status line the command printed (curl -i),
// the last one when redirects were followed
const shellOutcome = (ran: Ran): Outcome => {
  const result = resultOf(ran) as { stdout?: string; interrupted?: boolean } | undefined
  const stdout = typeof result?.stdout === 'string' ? result.stdout : ''
  // (a proxy's own "200 Connection established" for a tunnel is not the response)
  const statuses = [...stdout.matchAll(/^HTTP\/[\d.]+ (\d{3})[ \t]*(.*)$/gm)].filter(
    match => !/^connection established\s*$/i.test(match[2] ?? ''),
  )
  const last = statuses[statuses.length - 1]

  return {
    code: last === undefined ? 0 : Number(last[1]),
    codeText: (last?.[2] ?? '').trim(),
    ok: result !== undefined && result.interrupted !== true,
    result: stdout === '' ? undefined : stdout,
  }
}

// A number in a query is shown as one, unquoted, when that does not change it ("5", not "007" or "1e3")
const shown = (value: string): string | number => (value !== '' && String(Number(value)) === value ? Number(value) : value)

// The query string of a url as name and value, decoded; a name that comes more than once holds a list. Undefined when
// the url has none.
const queryOf = (url: string): Record<string, string | number | (string | number)[]> | undefined => {
  const start = url.indexOf('?')
  if (start === -1) return undefined

  const decode = (text: string): string => {
    try {
      return decodeURIComponent(text.replace(/\+/g, ' '))
    } catch {
      return text
    }
  }

  const params: Record<string, string | number | (string | number)[]> = {}

  for (const pair of url.slice(start + 1).replace(/#.*$/, '').split('&')) {
    if (pair === '') continue

    const at = pair.indexOf('=')
    const name = decode(at === -1 ? pair : pair.slice(0, at))
    const value = shown(at === -1 ? '' : decode(pair.slice(at + 1)))
    const held = params[name]

    params[name] = held === undefined ? value : Array.isArray(held) ? [...held, value] : [held, value]
  }

  return Object.keys(params).length === 0 ? undefined : params
}

// The query string as it is in the url, without the `?` and the fragment
const rawQueryOf = (url: string): string => {
  const start = url.indexOf('?')

  return start === -1 ? '' : url.slice(start + 1).replace(/#.*$/, '')
}

// Puts `text` on the clipboard of the surface the press came from; `key` is remembered while it is the last copy, so
// its button can say `Copied`
const copyText = async ($: Engine, key: string, text: string, surface: RenderSurface | undefined): Promise<void> => {
  const result = await $.ui.copy({ text, surface })
  await update($, copied, () => (result.isCopied ? key : ''))
}

// Who made a call: a subagent or teammate by its name, else its type; undefined for the main loop. An agent the
// engine no longer lists is still a subagent.
const agentName = async ($: Engine, agentId: string | undefined): Promise<string | undefined> => {
  if (agentId === undefined) return undefined

  try {
    const found = (await $.agent.list()).find(agent => agent.id === agentId)

    return found === undefined ? 'subagent' : (found.name ?? found.type)
  } catch {
    return 'subagent'
  }
}

// A command line as its words: quoted text stays whole, and a backslash or backtick escapes a quote inside double quotes
const wordsOf = (command: string): string[] => {
  const out: string[] = []
  let current = ''
  let started = false
  let quote: string | undefined

  for (let at = 0; at < command.length; at += 1) {
    const char = command[at] ?? ''

    if (quote === "'") {
      if (char === "'") quote = undefined
      else current += char
    } else if (quote === '"') {
      const escaped = command[at + 1] ?? ''

      if ((char === '\\' || char === '`') && /["\\`$]/.test(escaped)) {
        current += escaped
        at += 1
      } else if (char === '"') quote = undefined
      else current += char
    } else if (char === "'" || char === '"') {
      quote = char
      started = true
    } else if (/\s/.test(char)) {
      if (current !== '' || started) out.push(current)
      current = ''
      started = false
    } else current += char
  }

  if (current !== '' || started) out.push(current)

  return out
}

const CURL_BODY = /^(?:-d|--data|--data-raw|--data-binary|--data-ascii|--data-urlencode|--json)$/

// Most requests a command is logged as: a loop over a long list is cut here
const MAX_REQUESTS = 20

// `text` with every `$name` the command assigned replaced by its value: one result for each value of a name that
// holds a list (a `foreach` variable), so `"$base/$p"` over three `$p` is three urls. A name it knows nothing of
// stays as written.
const expandVariables = (text: string, vars: ReadonlyMap<string, readonly string[]>, depth = 0): string[] => {
  const found = [...text.matchAll(/\$\{?(\w+)\}?/g)].find(match => vars.has(match[1] ?? ''))
  if (found === undefined || depth > 5) return [text]

  const name = found[1] ?? ''
  const pattern = new RegExp(`\\$\\{?${name}\\}?`, 'g')

  return (vars.get(name) ?? [])
    .flatMap(value => expandVariables(text.replace(pattern, () => value), vars, depth + 1))
    .slice(0, MAX_REQUESTS)
}

// The items of a `foreach` list written out in the command: quoted strings, bare words, a `1..5` range. Undefined
// when it holds anything computed.
const listItems = (source: string): string[] | undefined => {
  const body = source.trim().replace(/^@\(/, '').replace(/\)$/, '').trim()
  const range = /^(\d+)\.\.(\d+)$/.exec(body)

  if (range !== null) {
    const from = Number(range[1])
    const to = Number(range[2])

    return to >= from && to - from < MAX_REQUESTS ? Array.from({ length: to - from + 1 }, (_, index) => String(from + index)) : undefined
  }

  const items = body.split(',').map(item => item.trim().replace(/^(['"])(.*)\1$/, '$2'))

  return items.length > 0 && items.every(item => item !== '' && !/[$()@{}]/.test(item)) ? items : undefined
}

// The string variables a command sets (`$base = 'https://...'`) and the lists a `foreach` walks, by name
const variablesIn = (command: string): Map<string, string[]> => {
  const vars = new Map<string, string[]>()

  for (const match of command.matchAll(/\$(\w+)\s*=\s*(?:'([^']*)'|"([^"]*)")/g)) {
    vars.set(match[1] ?? '', expandVariables(match[2] ?? match[3] ?? '', vars))
  }

  for (const match of command.matchAll(/foreach\s*\(\s*\$(\w+)\s+in\s+([^)]*\)?)\s*\)/gi)) {
    const items = listItems(match[2] ?? '')
    if (items !== undefined) vars.set(match[1] ?? '', items)
  }

  return vars
}

// The HTTP requests of a shell command's first curl, Invoke-RestMethod or Invoke-WebRequest: its method and body, and
// a url for each value its variables and loops give the address (up to MAX_REQUESTS). A command that makes none is
// undefined, and is left alone.
const parseRequests = (command: string): Request[] | undefined => {
  const tokens = wordsOf(command)
  const start = tokens.findIndex(token =>
    /^(?:curl(?:\.exe)?|invoke-restmethod|invoke-webrequest|irm|iwr)$/i.test(token.replace(/^.*[\\/]/, '')),
  )
  if (start === -1) return undefined

  const isCurl = /^curl/i.test((tokens[start] ?? '').replace(/^.*[\\/]/, ''))
  const args = tokens.slice(start + 1)
  const vars = variablesIn(command)
  const candidates: string[] = []
  let method: string | undefined
  let body: string | undefined

  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at] ?? ''
    const value = args[at + 1]

    if (isCurl && /^(?:-X|--request)$/.test(arg) && value !== undefined) {
      method = value
      at += 1
    } else if (isCurl && /^-X./.test(arg)) method = arg.slice(2)
    else if (isCurl && CURL_BODY.test(arg) && value !== undefined) {
      // Windows PowerShell 5.1 needs the quotes of a body escaped as \" for a native program: the body is without them
      const unescaped = value.replace(/\\"/g, '"')
      body = body === undefined ? unescaped : `${body}&${unescaped}`
      at += 1
    } else if (isCurl && /^(?:-I|--head)$/.test(arg)) method = 'HEAD'
    else if (/^(?:--url|-uri)$/i.test(arg) && value !== undefined) {
      candidates.push(value)
      at += 1
    } else if (!isCurl && /^-method$/i.test(arg) && value !== undefined) {
      method = value
      at += 1
    } else if (!isCurl && /^-body$/i.test(arg) && value !== undefined) {
      body = value
      at += 1
    } else if (!arg.startsWith('-') && (/^https?:\/\//i.test(arg) || (!isCurl && arg.includes('$')))) candidates.push(arg)
  }

  // The first candidate that is an address once its variables are filled in: `"$base/$p"`, `$url`, a literal
  // (a `;` `,` `)` or `|` that ends the statement, written against the address, is not part of it)
  let urls = candidates
    .map(candidate => expandVariables(candidate.replace(/[;,)|]+$/, ''), vars))
    .find(list => /^https?:\/\//i.test(list[0] ?? ''))

  // Else the first literal address anywhere in the command, so a request built some other way is still on the list
  if (urls === undefined) {
    const literal = /https?:\/\/[^\s'"`)|;,]+/i.exec(command)
    urls = literal === null ? undefined : [literal[0]]
  }

  if (urls === undefined) return undefined

  const verb = (method ?? (body === undefined ? 'GET' : 'POST')).toUpperCase()

  return urls.slice(0, MAX_REQUESTS).map(url => ({ url, method: verb, body }))
}

const statusCell = (call: HttpLogCall): { text: string; tone: CellTone } =>
  call.limited
    ? { text: 'limited', tone: 'warning' }
    : call.pending
      ? { text: '...', tone: 'neutral' }
      : call.code === 0
        ? call.ok === true && call.prompt === undefined
          ? // A shell command (WebFetch always has a prompt) that ran but printed no status line: no code to show
            { text: 'done', tone: 'neutral' }
          : { text: 'failed', tone: 'danger' }
        : { text: `${call.code} ${call.codeText}`.trim(), tone: toneOf(call.code) }

// --- the taps ------------------------------------------------------------------------------------------------------
// Reading what a command's text says leaves out what a script builds or does inside itself. So a shell command that
// may reach the network is given a short line before it (see tap.ts): in PowerShell it loads a wrapper that logs
// Invoke-RestMethod and Invoke-WebRequest with everything, and in either shell it points proxy-aware programs
// (curl, python, node, git) at a local logging proxy. After the command, what they wrote is merged into its rows.

// Module state, set again by `prepareTaps` and `startProxy` each time the module loads
let isWindows = false
let tapBase: string | undefined
let tapDir: string | undefined
let tapScript: string | undefined
let proxyPort: number | undefined
let proxyLog: string | undefined
let isPrepared = false
let isProxyStarted = false

// The retention setting as milliseconds: one period (`1h`, `30m`, `2d`; the shortest, if it lists several), an hour
// when it lists none
const parseRetention = (text: unknown): number => parsePeriods(typeof text === 'string' && text.trim() !== '' ? text : '1h')[0]?.ms ?? 3_600_000

// Python 3 as an argument vector, in the order tried: the Windows launcher, then the usual Unix names
const PYTHONS: readonly (readonly string[])[] = [['py', '-3'], ['python3'], ['python']]

// Windows looks for a program in the current directory before PATH unless told not to. The interpreter is started
// from the mod's own folder and with that switched off, so a `python.exe` or `py.exe` in the project the session was
// opened in is never what runs.
const SPAWN_ENV = { NoDefaultCurrentDirectoryInExePath: '1' }

const readText = async ($: Engine, path: string): Promise<string> => {
  try {
    const value = await $.fs.read(path)

    return typeof value === 'string' ? value : ''
  } catch {
    return ''
  }
}

// Where the taps write, and the wrapper's path: quick, so a command can be tapped from the first one on.
// On Windows that is a folder of the user's own temp folder, which is theirs alone. Elsewhere the temp area is shared,
// so no name there is trusted: the proxy makes a folder for this user, checks it and reports it (`startProxy`), and
// nothing is tapped before it has.
const prepareTaps = async ($: Engine): Promise<void> => {
  if (isPrepared) return
  isPrepared = true

  try {
    isWindows = (await $.env.get('OS')) === 'Windows_NT'
    const base = isWindows
      ? ((await $.env.get('TEMP')) ?? (await $.env.get('TMP')))
      : ((await $.env.get('XDG_RUNTIME_DIR')) ?? (await $.env.get('TMPDIR')) ?? '/tmp')
    if (base === undefined || base === '') return

    tapBase = base.replace(/[\\/]+$/, '')
    tapScript = `${$.plugin.root.replace(/\\/g, '/')}/tap/http-log-tap.ps1`

    if (isWindows) {
      tapDir = `${tapBase.replace(/\\/g, '/')}/http-log-tap`
      proxyLog = `${tapDir}/proxy.jsonl`
      await update($, capture, () => 'PowerShell wrapper on')
    }
  } catch {
    tapBase = undefined
  }
}

// Finds Python 3 and starts the proxy for the life of this module, then says what is on. Without Python the wrapper
// still works; a failure here is never the session's. It takes a moment, so nothing waits for it: a command run
// before the proxy is up gets the wrapper alone.
const startProxy = async ($: Engine): Promise<void> => {
  if (isProxyStarted || tapBase === undefined) return
  isProxyStarted = true

  const base = tapBase
  const prefix = isWindows ? 'PowerShell wrapper on · ' : ''

  try {
    const root = $.plugin.root
    const script = `${root.replace(/\\/g, '/')}/tap/http_log_proxy.py`
    let python: readonly string[] | undefined

    for (const argv of PYTHONS) {
      try {
        const found = await $.process.run([...argv, '--version'], { cwd: root, env: SPAWN_ENV, timeoutMs: 5_000 })

        if (found.exitCode === 0 && /Python 3/.test(`${found.stdout}${found.stderr}`)) {
          python = argv
          break
        }
      } catch {
        // not there: the next name
      }
    }

    if (python === undefined) {
      await update($, capture, () => `${prefix}proxy off (no Python 3 found)`)

      return
    }

    // The child lives as long as this loop and this module: it ends with either
    void (async () => {
      let refusal = ''

      try {
        let seen = ''
        // The proxy removes the taps' files older than the retention itself, which this API cannot do
        const seconds = String(Math.round(retentionMs / 1000))

        for await (const { stream, text } of $.process.spawn({
          argv: [...python, script, base, seconds],
          cwd: root,
          env: SPAWN_ENV,
        })) {
          if (stream === 'stderr') {
            refusal += text
          } else if (proxyPort === undefined) {
            seen += text
            const dir = /^DIR (.+)$/m.exec(seen)
            const port = /^PORT (\d+)$/m.exec(seen)

            // The folder the proxy made and checked comes first, the port after it: the taps use both
            if (dir !== null && port !== null) {
              tapDir = (dir[1] ?? '').trim()
              proxyLog = `${tapDir}/proxy.jsonl`
              proxyPort = Number(port[1])
              await update($, capture, () => `${prefix}proxy on 127.0.0.1:${proxyPort}`)
            }
          }
        }
      } catch {
        // the proxy could not start or was stopped
      }

      proxyPort = undefined
      await update($, capture, () =>
        /REFUSED/.test(refusal)
          ? `${prefix}proxy off (its folder in ${base} is not private to you)`
          : `${prefix}proxy off`,
      )
    })()
  } catch {
    // no proxy: the wrapper and the text are what there is
  }
}

type Tap = { prelude: string; collect: (from: number, to: number) => Promise<TapEvent[]> }

// The tap for one shell command, or undefined when it should run as written: no tap set up, a command that cannot
// reach the network, or a PowerShell script whose first line must stay first
const tapFor = async ($: Engine, shell: 'powershell' | 'bash', command: string, hasRequests: boolean): Promise<Tap | undefined> => {
  if (!hasRequests && !NETWORK_HINT.test(command)) return undefined

  // Set up by the first command that wants it, if the session start did not
  await prepareTaps($)
  void startProxy($)
  // Off Windows there is no folder until the proxy has made and reported its private one
  if (tapDir === undefined || tapScript === undefined || proxyLog === undefined) return undefined
  if (shell === 'powershell' && /^\s*(?:using\s|#requires)/i.test(command)) return undefined

  const id = newId()
  const file = `${tapDir}/${id}.jsonl`
  const log = proxyLog
  // The token is the user name; the password is a placeholder, because git (and others) ask for one when a proxy
  // address has a user name and none, which a command cannot answer
  const proxy = proxyPort === undefined ? undefined : `http://${id}:x@127.0.0.1:${proxyPort}`
  // bash has only the proxy to offer
  if (shell === 'bash' && proxy === undefined) return undefined

  const prelude =
    shell === 'powershell'
      ? powershellPrelude({ file, proxy, script: tapScript })
      : bashPrelude({ proxy: proxy ?? '' })

  return {
    prelude,
    collect: async (from, to) => {
      const wrapped = shell === 'powershell' ? parseEvents(await readText($, file)) : []
      // The proxy's own: marked with this command's token, or, for a client that does not send it (Python's
      // urllib), made while this command ran
      const proxied = parseEvents(await readText($, log)).filter(
        event => event.token === id || (event.token === '' && event.ts >= from - 250 && event.ts <= to + 250),
      )

      return [...wrapped, ...proxied]
    },
  }
}

// Logs requests, holds them to the rules, lets the tool call run and records what came back. Every request goes
// through here, whatever tool made it: `outcome` reads that tool's result. A shell command can make several (a
// loop): they are listed together and share the one result, and one a rule refuses refuses the whole command.
// `tap` is a shell command's: what it saw is merged in after the run, in place of what the text only suggested.
const track = async <R extends Ran>(
  $: Engine,
  requests: readonly Request[],
  run: () => Promise<R>,
  outcome: (ran: Ran) => Outcome,
  tap?: { source: Tap; agent: string | undefined; command: string },
): Promise<R | { deny: string }> => {
  const started = Date.now()
  const ids = requests.map(() => newId())

  // The rules, the count and the new rows are read and written together: calls made at once are counted at once
  const { refusal } = await exclusive(async () => {
    const ruled = await loadRules($)
    const stored = await loadCalls($)
    const batch: HttpLogCall[] = []
    let refused: string | undefined

    requests.forEach((request, index) => {
      // A call a rule matches is counted with the other calls of that rule; a call no rule matches is never held
      const matched = ruleFor(request.url, ruled)
      const recent =
        matched === undefined
          ? 0
          : [...batch, ...stored].filter(
              call => !call.limited && started - call.ts < WINDOW_MS && ruleFor(call.url, ruled)?.id === matched.id,
            ).length

      if (matched !== undefined && recent >= matched.limit && refused === undefined) {
        refused = `http-log: rate limit of ${matched.limit} calls per minute for ${matched.pattern} reached; try again shortly.`
      }

      batch.push({
        id: ids[index] ?? newId(),
        url: request.url,
        code: 0,
        codeText: '',
        durationMs: 0,
        at: clock(new Date(started)),
        ts: started,
        limited: false,
        pending: true,
        prompt: request.prompt,
        agent: request.agent,
        // WebFetch only ever sends a GET
        method: request.method ?? 'GET',
        body: request.body === undefined ? undefined : request.body.slice(0, RESULT_PREVIEW),
        command: request.command === undefined ? undefined : request.command.slice(0, RESULT_PREVIEW),
      })
    })

    // A refused command runs none of its requests: every row of it says so
    const rows = refused === undefined ? batch : batch.map(row => ({ ...row, limited: true, pending: false }))
    const logged = [...rows, ...stored]
      .slice(0, MAX_CALLS)
      .map((call, index) => (index < RESULT_KEPT || call.result === undefined ? call : { ...call, result: undefined }))
    await $.store.set(STORE_CALLS, logged)
    await update($, rules, () => ruled)
    await update($, calls, () => logged)

    return { refusal: refused }
  })

  if (refusal !== undefined) return { deny: refusal }

  const ran = await run()
  const result = outcome(ran)
  const finished = Date.now()
  // What the taps saw while it ran; nothing, if they could not be read
  const seen = tap === undefined ? [] : await tap.source.collect(started, finished).catch((): TapEvent[] => [])

  await exclusive(async () => {
    const stored = await loadCalls($)
    const done = stored.map(call =>
      ids.includes(call.id)
        ? {
            ...call,
            code: result.code,
            codeText: result.codeText,
            durationMs: finished - started,
            pending: false,
            ok: result.ok,
            bytes: result.bytes,
            finalUrl: result.finalUrl !== undefined && result.finalUrl !== call.url ? result.finalUrl : undefined,
            result: result.result === undefined ? undefined : result.result.slice(0, RESULT_PREVIEW),
          }
        : call,
    )

    let next = done

    if (tap !== undefined && seen.length > 0) {
      const mine = done.filter(call => ids.includes(call.id))
      const merged = mergeTap({
        rows: mine,
        events: seen,
        agent: tap.agent,
        command: tap.command.slice(0, RESULT_PREVIEW),
        newId,
        at: ts => clock(new Date(ts)),
      }).map(call => ({
        ...call,
        result: call.result === undefined ? undefined : call.result.slice(0, RESULT_PREVIEW),
        body: call.body === undefined ? undefined : call.body.slice(0, RESULT_PREVIEW),
      }))
      const at = done.findIndex(call => ids.includes(call.id))
      const rest = done.filter(call => !ids.includes(call.id))

      next = [...rest.slice(0, Math.max(at, 0)), ...merged, ...rest.slice(Math.max(at, 0))].slice(0, MAX_CALLS)
    }

    await $.store.set(STORE_CALLS, next)
    await update($, calls, () => next)
  })

  return ran
}

// While a period is in force the table is redrawn every few seconds, so calls leave it as they age
const ageOut = async ($: Engine): Promise<void> => {
  if ((await read($, range)) !== 'all') await update($, tick, () => Date.now())
}

// Everything styled comes from hooks/kit/: card, table, field, badge, actionLabel. No colors or borders of your own.
export const register: Register = (on, options) => {
  // The periods the pane offers: the mod's `timeRanges` setting, `10m,30m,1h` unless it says otherwise
  const periods = parsePeriods((options as { timeRanges?: unknown } | undefined)?.timeRanges)
  retentionMs = parseRetention((options as { retention?: unknown } | undefined)?.retention)

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'http-log', description: 'Open the table of HTTP calls (url, response code) and the rate limits' })
    // A host that registers no tools still starts the session
    await $.tool.register(view.tool).catch(() => undefined)
    await refresh($)
    // Other sessions write to the same store: pick up their rules and calls
    $.clock.every(REFRESH_MS, async () => {
      await refresh($)
      await ageOut($)
    })
    // The taps start on their own: a command run before they are up is read from its text, as before
    await prepareTaps($)
    void startProxy($)

    return next(e)
  })

  on('command.run', { command: 'http-log' }, async $ => {
    await refresh($)
    await $.ui.open({ id: PANE, title: 'HTTP calls' })

    return { text: 'HTTP calls pane opened.' }
  })

  // WebFetch (always a GET): its result carries the response code
  on('tool.call', { tool: 'WebFetch' }, async ($, e, next) =>
    track($, [{ url: e.url, prompt: e.prompt, agent: await agentName($, e.agentId) }], () => next(e), fetchOutcome),
  )

  // A request made from the shell (curl, Invoke-RestMethod, Invoke-WebRequest): method and body come from the
  // command line; the status comes from the response headers when the command printed them (curl -i)
  on('tool.call', { tool: 'PowerShell' }, async ($, e, next) => {
    const requests = parseRequests(e.command) ?? []
    const source = await tapFor($, 'powershell', e.command, requests.length > 0)
    // Neither the text nor a tap has anything to say about it: it runs as written, untouched
    if (requests.length === 0 && source === undefined) return next(e)

    const agent = await agentName($, e.agentId)
    // The tap's line goes before the command the model wrote; the rows keep the command as it was written
    const input = source === undefined ? e : { ...e, command: `${source.prelude}${e.command}` }

    return track(
      $,
      requests.map(request => ({ ...request, agent, command: e.command })),
      () => next(input),
      shellOutcome,
      source === undefined ? undefined : { source, agent, command: e.command },
    )
  })

  // The same for a bash command (the shell tool on Linux and macOS): there only the proxy is available
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const requests = parseRequests(e.command) ?? []
    const source = await tapFor($, 'bash', e.command, requests.length > 0)
    if (requests.length === 0 && source === undefined) return next(e)

    const agent = await agentName($, e.agentId)
    const input = source === undefined ? e : { ...e, command: `${source.prelude}${e.command}` }

    return track(
      $,
      requests.map(request => ({ ...request, agent, command: e.command })),
      () => next(input),
      shellOutcome,
      source === undefined ? undefined : { source, agent, command: e.command },
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Input, Button } = $.ui.resolve(e)
    const list = await read($, calls)
    const ruled = await read($, rules)
    const query = await read($, search)
    const selectedId = await read($, selected)
    const copiedKey = await read($, copied)
    const captureText = await read($, capture)
    const rangeKey = await read($, range)
    // Read for its redraw: it is touched every few seconds while a period is in force, so the window moves
    await read($, tick)
    const nowMs = Date.now()
    const chosen = list.find(call => call.id === selectedId)

    // The terminal highlights; another surface (the desktop) is given plain lines, which every surface draws
    const codeBlock = (props: { source: string; language?: string }) =>
      code({ ...props, plain: e.surface !== 'terminal' })

    // A body or a result: the JSON in it formatted, with whatever text came around it below. What is copied is the
    // formatted JSON, or the text as it came when it holds none.
    const payloadChildren = (call: HttpLogCall, name: string, text: string) => {
      const { rest, ...shown } = formatResult(text)

      return [
        labelRow(call, name.toLowerCase(), name, shown.source),
        codeBlock(shown),
        ...(rest !== '' ? [<Text key={`detail-${name}-note`} color="subtle" wrap="wrap">{rest}</Text>] : []),
      ]
    }

    // A label with the button that copies `text` to the clipboard, exactly as it is. The key names what was copied,
    // for this call, so the button says `Copied` until the person copies something else or picks another call.
    const labelRow = (call: HttpLogCall, key: string, label: string, text: string) => (
      <Box key={`detail-${key}-label`} flexDirection="row" gap={2} alignItems="center">
        <Text color="subtle">{label}</Text>
        <Button key={`copy-${key}`} onPress={press => copyText($, `${call.id}:${key}`, text, press.surface)}>
          {actionLabel({ text: copiedKey === `${call.id}:${key}` ? 'Copied' : 'Copy' })}
        </Button>
      </Box>
    )

    // A value shown as plain text on lines of its own, never cut or quoted, so it can also be selected and pasted
    const textBlock = (call: HttpLogCall, key: string, label: string, text: string) => [
      labelRow(call, key, label, text),
      <Text key={`detail-${key}-text`} wrap="wrap">{text}</Text>,
    ]

    // The selected call's details, under the table: its fields as YAML, then the start of what came back
    const detailChildren = (call: HttpLogCall) => {
      const rule = ruleFor(call.url, ruled)
      const params = queryOf(call.url)
      const status = statusCell(call)
      const fields: Record<string, string | number | boolean> = {
        method: call.method ?? 'GET',
        time: call.at,
        agent: call.agent ?? 'main',
        ...(call.via !== undefined ? { seenBy: call.via } : {}),
        status: status.text,
        ...(call.pending || call.limited ? {} : { durationMs: call.durationMs }),
        ...(call.bytes !== undefined ? { bytes: call.bytes } : {}),
        limited: call.limited,
        ...(rule !== undefined ? { rule: `${rule.pattern} (${rule.limit}/min)` } : {}),
        ...(call.prompt !== undefined ? { prompt: call.prompt } : {}),
      }

      return [
        <Box key="detail-head" flexDirection="row" gap={2} alignItems="center">
          <Text bold>Call details</Text>
          {badge({ label: status.text, tone: status.tone })}
          <Button key="detail-close" onPress={() => update($, selected, () => '')}>
            {actionLabel({ text: 'Close' })}
          </Button>
        </Box>,
        ...textBlock(call, 'url', 'URL', call.url),
        ...(call.finalUrl !== undefined ? textBlock(call, 'final-url', 'Final URL', call.finalUrl) : []),
        codeBlock({ source: yaml(fields), language: 'yaml' }),
        ...(call.via === 'tunnel'
          ? [
              <Text key="detail-tunnel-note" color="subtle" wrap="wrap">
                An HTTPS connection seen by the proxy: only the host, the bytes and the time are visible, not the path,
                the body or the response.
              </Text>,
            ]
          : []),
        // What is copied is the query string as it is in the url, to paste back into one
        ...(params !== undefined
          ? [
              labelRow(call, 'query', 'Query', rawQueryOf(call.url)),
              codeBlock({ source: yaml(params), language: 'yaml' }),
            ]
          : []),
        // The shell command that made the request: a command may print only a summary of the response, so the
        // Result below is what it printed, and this is what it was
        ...(call.command !== undefined && call.command !== ''
          ? [
              labelRow(call, 'command', 'Command', call.command),
              codeBlock({ source: call.command, language: 'powershell' }),
            ]
          : []),
        ...(call.body !== undefined && call.body !== '' ? payloadChildren(call, 'Body', call.body) : []),
        ...(call.result !== undefined && call.result !== '' ? payloadChildren(call, 'Result', call.result) : []),
      ]
    }

    // The period: only the calls made within it. `now` is read so the drawing is redrawn as the window moves.
    const period = periods.find(item => item.key === rangeKey)
    const isRanged = period !== undefined
    const inPeriod = period === undefined ? list : list.filter(call => nowMs - call.ts <= period.ms)

    // Every space-separated word must appear in the row's time, url or status, whatever the case
    const words = query.toLowerCase().split(/\s+/).filter(word => word !== '')
    const shown =
      words.length === 0
        ? inPeriod
        : inPeriod.filter(call => {
            const haystack =
              `${call.at} ${call.method ?? 'GET'} ${call.agent ?? 'main'} ${call.url} ${statusCell(call).text}`.toLowerCase()

            return words.every(word => haystack.includes(word))
          })

    const patchRule = (id: string, patch: Partial<HttpLogRule>) =>
      changeRules($, current => current.map(rule => (rule.id === id ? { ...rule, ...patch } : rule)))

    // A rule per row, above the table: its regex, its calls per minute and a way to drop it
    const ruleRows = ruled.map((rule, index) => (
      <Box key={`rule-${index}`} flexDirection="row" gap={2} alignItems="flex-end">
        <Box flexGrow={1} flexShrink={1}>
          {field(
            { Box, Text, Input },
            {
              key: `rule-pattern-${index}`,
              label: 'URL regex',
              value: rule.pattern,
              placeholder: 'e.g. /pokemon/\\d+',
              onInput: value => patchRule(rule.id, { pattern: value.slice(0, 300) }),
              onSubmit: () => {},
            },
          )}
        </Box>
        <Box width={14} flexShrink={0}>
          {field(
            { Box, Text, Input },
            {
              key: `rule-limit-${index}`,
              label: 'Calls/min',
              value: rule.limit > 0 ? String(rule.limit) : '',
              placeholder: 'off',
              onInput: value => patchRule(rule.id, { limit: toCount(value) }),
              onSubmit: () => {},
            },
          )}
        </Box>
        {rule.pattern !== '' && compile(rule.pattern) === undefined ? badge({ label: 'invalid regex', tone: 'danger' }) : null}
        <Button key={`rule-remove-${index}`} onPress={() => changeRules($, current => current.filter(r => r.id !== rule.id))}>
          {actionLabel({ text: 'Remove' })}
        </Button>
      </Box>
    ))

    return view.keep(card({
      width: e.props.bodyColumns ?? 80,
      title: 'HTTP calls',
      meta:
        words.length === 0 && !isRanged
          ? `${list.length} ${list.length === 1 ? 'call' : 'calls'}`
          : `${shown.length} of ${list.length} ${list.length === 1 ? 'call' : 'calls'}`,
      children: [
        <Box key="rules" flexDirection="column" gap={1}>
          {ruleRows}
          <Button
            key="add-rule"
            onPress={() => addRule($, '')}
          >
            {actionLabel({ text: 'Add rule', primary: true })}
          </Button>
        </Box>,
        field(
          { Box, Text, Input },
          {
            key: 'search',
            label: 'Search calls (url, status, time)',
            value: query,
            placeholder: 'e.g. charizard limited',
            onInput: value => update($, search, () => value.slice(0, 200)),
            onSubmit: () => {},
          },
        ),
        // The periods: All, then each of the configured ones. The one in force is filled, as a selected row is.
        <Box key="periods" flexDirection="row" gap={1} alignItems="center">
          <Text color="subtle">Period</Text>
          <Button key="range-all" onPress={() => update($, range, () => 'all')}>
            {actionLabel({ text: 'All', primary: !isRanged })}
          </Button>
          {periods.map(item => (
            <Button key={`range-${item.key}`} onPress={() => update($, range, () => item.key)}>
              {actionLabel({ text: item.label, primary: item.key === period?.key })}
            </Button>
          ))}
        </Box>,
        ...(captureText === ''
          ? []
          : [<Text key="capture" color="subtle" wrap="wrap">{`Capture: ${captureText}`}</Text>]),
        table({
          columns: [
            // Wide enough for the button's own brackets and the `▸ ` marker around the 8-character time
            { header: 'Time', width: 16 },
            { header: 'Method', width: 7 },
            { header: 'URL' },
            { header: 'Agent', width: 10 },
            { header: 'Code', width: 12 },
            { header: 'ms', width: 6 },
            { header: 'Limit', width: 14 },
          ],
          rows: shown.map((call, index) => {
            const rule = ruleFor(call.url, ruled)
            // The selected call is shown by color: its time is filled and its text takes the accent color
            const isSelected = call.id === selectedId
            const plain = (text: string) => (isSelected ? { text, tone: 'accent' as CellTone } : text)

            return [
              // The time is the row's handle: pressing it shows the call's details under the table
              <Button key={`select-${index}`} onPress={() => update($, selected, () => call.id)}>
                {actionLabel({ text: call.at, primary: isSelected, compact: true })}
              </Button>,
              // WebFetch only ever sends a GET, so a row with no method is one
              plain(call.method ?? 'GET'),
              plain(call.url),
              // The agent that made the call; the main loop is `main`
              plain(call.agent ?? 'main'),
              statusCell(call),
              call.pending || call.limited ? '' : String(call.durationMs),
              // A row makes a rule for exactly its endpoint; the rule is then edited, loosened or removed above
              <Button key={`limit-${index}`} onPress={() => addRule($, patternFor(call.url))}>
                {actionLabel({ text: rule !== undefined ? `${rule.limit}/min` : 'Rate limit' })}
              </Button>,
            ]
          }),
          empty:
            list.length === 0
              ? 'No HTTP calls yet.'
              : words.length === 0 && period !== undefined
                ? `No call in the last ${period.label}.`
                : 'No call matches the search.',
        }),
        divider(),
        <Box key="details" flexDirection="column" gap={1}>
          {chosen !== undefined ? (
            detailChildren(chosen)
          ) : (
            <Text color="subtle">Press a time in the table to see that call's details.</Text>
          )}
        </Box>,
        <Button key="clear" onPress={() => clearCalls($)}>
          {actionLabel({ text: 'Clear' })}
        </Button>,
      ],
    }))
  })

  // The pane as text, for the model: it sees nothing of what is drawn otherwise
  on('tool.call', { tool: 'mcp__http-log__pane' }, $ => view.answer(() => $.ui.panes()))
}
