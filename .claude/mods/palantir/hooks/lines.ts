import type { Action, Dom, DomIssue, Level, Line, Render, Request, Signature, Vitals, Watch } from '../types'

// What turns the text an app wrote into lines palantir can sort: its time, its level, its message with the
// secrets taken out. Nothing here reaches outside: text in, values out.

const MAX_LINES = 1000
// A trace keeps its first lines and its last: what raised is at one end or the other, by the language
const TRACE_HEAD = 12
const TRACE_TAIL = 24
const MAX_SIGNATURES = 100
const MAX_MESSAGE = 600
const MAX_RENDERS = 80
const MAX_STEPS = 12
const MAX_WHOLE = 2000
const MAX_ELEMENTS = 300
const MAX_ISSUES = 30
const MAX_ACTIONS = 30
const MAX_REQUESTS = 60

export const EMPTY_WATCH: Watch = {
  cursor: { since: '', seen: [], offset: 0 },
  lines: [],
  signatures: [],
  health: { state: 'unknown', detail: '', restarts: 0 },
  edits: 0,
  editedPath: '',
  error: '',
  renders: [],
}

/**
 * Takes the secrets out of a line before it is kept, drawn or handed to the model: bearer and basic credentials,
 * values named as a key, secret, token or password, the password of a URL, and the tokens known by their shape.
 */
export const redact = (text: string): string =>
  text
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***')
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, '***')
    .replace(/\b(AKIA[0-9A-Z]{16}|gh[pousr]_\w{20,}|xox[abprs]-[\w-]{10,}|sk-[\w-]{20,})\b/g, '***')
    .replace(/((?:api[_-]?key|secret|token|passw(?:or)?d|pwd|authorization|credential)\w*["']?\s*[=:]\s*["']?)(?!\*\*\*)[^\s"',;&}]+/gi, '$1***')
    .replace(/(:\/\/[^\s:/@]+:)[^\s@/]+@/g, '$1***@')

const SECRET_NAME = /key|secret|token|passw|pwd|auth|credential|private|dsn|cookie|session|signature/i

/** A variable's value as it may be shown: gone when its name says it is a secret, and searched for secrets otherwise. */
export const redactVar = (name: string, value: string): string => (value === '' ? '' : SECRET_NAME.test(name) ? '***' : redact(value))

const STAMP =/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:?\d\d)) ?(.*)$/

/** A raw line as a runtime prints it under `--timestamps`: the timestamp it leads with, then the app's own text. */
export const split = (raw: string): { stamp: string; text: string } => {
  const found = STAMP.exec(raw)

  return found === null ? { stamp: '', text: raw } : { stamp: found[1] ?? '', text: found[2] ?? '' }
}

const LEVEL_WORD: Record<string, Level> = {
  error: 'error',
  err: 'error',
  fatal: 'error',
  critical: 'error',
  crit: 'error',
  panic: 'error',
  severe: 'error',
  emerg: 'error',
  alert: 'error',
  warn: 'warn',
  warning: 'warn',
}

// A level as a word (`error`, `WARN`) or as pino and bunyan count it (50 and over an error, 40 a warning)
const levelOf = (value: unknown): Level => {
  if (typeof value === 'number') return value >= 50 ? 'error' : value >= 40 ? 'warn' : 'info'

  return LEVEL_WORD[String(value ?? '').toLowerCase()] ?? 'info'
}

const timeOf = (value: unknown): number | undefined => {
  // Seconds or milliseconds since the epoch, told apart by their size
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e11 ? Math.round(value * 1000) : value

  const at = typeof value === 'string' ? Date.parse(value) : Number.NaN

  return Number.isNaN(at) ? undefined : at
}

const ERROR_LOOK = /\b(ERROR|FATAL|CRITICAL|PANIC|SEVERE)\b|\[(error|err|fatal)\]|\b(error|Error|fatal|panic):|\b\w+(Exception|Error)\b|^Traceback \(most recent call last\)|Unhandled(Promise)?Rejection/
const ERROR_LOOK_ANY_CASE = /\[(error|err|fatal)\]|\b(fatal|panic):/i
const WARN_LOOK = /\bWARN(ING)?\b|\[(warn|warning)\]/i

// A time an app writes at the head of its own line, bracketed or not: `2026-10-13T20:02:26.828Z`, `[2026-10-13 10:00:05,000]`
const OWN_STAMP = /^\[?(\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:[.,]\d+)?(?:Z|[+-]\d\d:?\d\d)?)\]?\s+(?=\S)(.*)$/

const LOGFMT = /(\w+)=("(?:[^"\\]|\\.)*"|\S*)/g

// The keys that are the line's time, level and message, and the ones that say nothing of the event
const HEAD_KEYS = ['level', 'lvl', 'severity', 'msg', 'message', 'time', 'ts', 'timestamp', '@timestamp', 'pid', 'hostname', 'v', 'logger']

type Read = {
  at?: number
  level: Level
  message: string
  /** The line's other fields as `key=value`, a request id among them: shown and searched, never part of what makes two errors one. */
  fields: string
}

const fieldsOf = (fields: Record<string, unknown>): string =>
  Object.entries(fields)
    .filter(([key, value]) => !HEAD_KEYS.includes(key) && ['string', 'number', 'boolean'].includes(typeof value) && value !== '')
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ')

/** One line of an app's own text as a time, a level, a message and its other fields: JSON, logfmt, or plain words. */
export const read = (text: string): Read => {
  const trimmed = text.trim()

  if (trimmed.startsWith('{')) {
    try {
      const fields = JSON.parse(trimmed) as Record<string, unknown>
      const message = fields.msg ?? fields.message ?? fields.error ?? fields.event

      if (typeof fields === 'object' && fields !== null && message !== undefined) {
        return {
          at: timeOf(fields.time ?? fields.ts ?? fields.timestamp ?? fields['@timestamp']),
          level: levelOf(fields.level ?? fields.severity ?? fields.lvl),
          message: typeof message === 'string' ? message : JSON.stringify(message),
          fields: fieldsOf(fields),
        }
      }
    } catch {
      // Not JSON after all: read as plain words below
    }
  }

  if (/\b(level|lvl|severity)=/.test(trimmed) && /\b(msg|message)=/.test(trimmed)) {
    const fields: Record<string, string> = {}

    for (const [, key, value] of trimmed.matchAll(LOGFMT)) {
      if (key !== undefined) fields[key] = (value ?? '').replace(/^"|"$/g, '').replace(/\\"/g, '"')
    }

    return {
      at: timeOf(fields.time ?? fields.ts),
      level: levelOf(fields.level ?? fields.lvl ?? fields.severity),
      message: fields.msg ?? fields.message ?? '',
      fields: fieldsOf(fields),
    }
  }

  // The time a plain line leads with is the line's own: said once, by the timeline
  const [, own = '', rest = trimmed] = OWN_STAMP.exec(trimmed) ?? []

  return {
    at: own === '' ? undefined : timeOf(own.replace(' ', 'T').replace(',', '.')),
    level: ERROR_LOOK.test(trimmed) || ERROR_LOOK_ANY_CASE.test(trimmed) ? 'error' : WARN_LOOK.test(trimmed) ? 'warn' : 'info',
    // The level a plain line leads with is said by the level itself
    message: rest.replace(/^(?:\[?(?:ERROR|WARN(?:ING)?|INFO|DEBUG|FATAL|CRITICAL)\]?:?\s+)(?=\S)/, ''),
    fields: '',
  }
}

/**
 * A render as a frontend reports it in its log: a JSON line that says `"palantir":"render"`, the component, and the
 * chain that led to it, the cause first. Such a line is no line of the timeline: it is counted, chain by chain.
 */
export const renderOf = (text: string): { component: string; chain: string[]; values: string[]; whole: string[]; count: number; inside: number; file: string; at?: number } | undefined => {
  const trimmed = text.trim()

  if (!trimmed.startsWith('{') || !trimmed.includes('"palantir"')) return undefined

  try {
    const fields = JSON.parse(trimmed) as Record<string, unknown>

    if (fields.palantir !== 'render' || typeof fields.component !== 'string' || !Array.isArray(fields.chain)) return undefined

    const chain = fields.chain.slice(0, MAX_STEPS).map(step => redact(String(step)).slice(0, 120))
    const values: unknown[] = Array.isArray(fields.values) ? fields.values : []
    const whole: unknown[] = Array.isArray(fields.whole) ? fields.whole : []
    const inside = typeof fields.inside === 'number' && fields.inside >= 1 ? Math.round(fields.inside) : 0

    return {
      component: redact(fields.component).slice(0, 80),
      chain,
      // A step's value, one for one with the chain, gone when the step's name says it is a secret
      values: chain.map((step, index) => {
        const value = values[index]

        return typeof value === 'string' ? redactVar(step, value).slice(0, 120) : ''
      }),
      // The same value whole, as the JSON text it was sent as: cut, it would be no JSON any more
      whole: chain.map((step, index) => {
        const value = whole[index]

        return typeof value === 'string' && value.length <= MAX_WHOLE && !SECRET_NAME.test(step) ? redact(value) : ''
      }),
      // A chain may be said for what rendered inside its component alone: it then counts no render of the component
      count: typeof fields.count === 'number' && fields.count >= 1 ? Math.round(fields.count) : inside > 0 && fields.count === 0 ? 0 : 1,
      inside,
      file: typeof fields.file === 'string' ? fields.file.replace(/\\/g, '/').slice(0, 300) : '',
      at: timeOf(fields.time ?? fields.ts),
    }
  } catch {
    return undefined
  }
}

/**
 * A page as a frontend reports it in its log: a JSON line that says `"palantir":"dom"`, the page's address and
 * title, and its elements, each `[depth, tag, attributes, text, component]`. Such a line is no line of the
 * timeline: the last one is the page as it stands.
 */
export const domOf = (text: string): Omit<Dom, 'at'> & { at?: number } | undefined => {
  const trimmed = text.trim()

  if (!trimmed.startsWith('{') || !trimmed.includes('"palantir"')) return undefined

  try {
    const fields = JSON.parse(trimmed) as Record<string, unknown>

    if (fields.palantir !== 'dom' || !Array.isArray(fields.elements)) return undefined

    const said = (value: unknown, most: number): string => (typeof value === 'string' ? redact(value).slice(0, most) : '')

    return {
      url: said(fields.url, 200),
      title: said(fields.title, 120),
      elements: fields.elements
        .slice(0, MAX_ELEMENTS)
        .filter((element): element is unknown[] => Array.isArray(element) && typeof element[0] === 'number')
        .map(([depth, tag, attributes, own, component]) => ({ depth: Math.max(0, Math.round(depth as number)), tag: said(tag, 80), attributes: said(attributes, 200), text: said(own, 80), component: said(component, 60) })),
      left: typeof fields.left === 'number' && fields.left > 0 ? Math.round(fields.left) : 0,
      issues: (Array.isArray(fields.issues) ? fields.issues : [])
        .slice(0, MAX_ISSUES)
        .filter((issue): issue is unknown[] => Array.isArray(issue))
        .map(([kind, tag, component]): DomIssue => ({ kind: said(kind, 60), tag: said(tag, 80), component: said(component, 60) })),
      files: Object.fromEntries(
        Object.entries(typeof fields.files === 'object' && fields.files !== null ? fields.files : {})
          .slice(0, 100)
          .flatMap(([name, file]) => (typeof file === 'string' ? [[name.slice(0, 60), file.replace(/\\/g, '/').slice(0, 300)] as const] : [])),
      ),
      at: timeOf(fields.time ?? fields.ts),
    }
  } catch {
    return undefined
  }
}

type Told =
  | { kind: 'action'; action: Action }
  | { kind: 'request'; url: string; status: number; ms: number; at?: number }
  | { kind: 'vitals'; vitals: Vitals }

const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0)

/**
 * What else a page says of itself, a JSON line each, none of them a line of the timeline: `"palantir":"action"`,
 * something the person did and what followed; `"palantir":"request"`, something the page asked for and how long the
 * answer took; `"palantir":"vitals"`, how the page loaded and answers the hand.
 */
export const toldOf = (text: string, now: number): Told | undefined => {
  const trimmed = text.trim()

  if (!trimmed.startsWith('{') || !trimmed.includes('"palantir"')) return undefined

  try {
    const fields = JSON.parse(trimmed) as Record<string, unknown>
    const said = (value: unknown, most: number): string => (typeof value === 'string' ? redact(value).slice(0, most) : '')
    const list = (value: unknown, most: number): string[] => (Array.isArray(value) ? value.slice(0, most).map(item => said(item, 160)).filter(item => item !== '') : [])

    if (fields.palantir === 'action' && typeof fields.kind === 'string') {
      // How many times each component rendered, as `Name ×n`, the busiest first
      const rendered = Object.entries(typeof fields.renders === 'object' && fields.renders !== null ? fields.renders : {})
        .flatMap(([name, times]) => (count(times) > 0 ? [[redact(name).slice(0, 60), count(times)] as const] : []))
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
        .map(([name, times]) => `${name} ×${times}`)

      return {
        kind: 'action',
        action: { at: timeOf(fields.at ?? fields.time) ?? now, kind: said(fields.kind, 20), what: said(fields.what, 120), component: said(fields.component, 60), renders: rendered, requests: list(fields.requests, 12) },
      }
    }

    if (fields.palantir === 'request' && typeof fields.url === 'string') {
      return { kind: 'request', url: said(fields.url, 200), status: fields.status === -1 ? -1 : count(fields.status), ms: count(fields.ms), at: timeOf(fields.at ?? fields.time) }
    }

    if (fields.palantir === 'vitals') {
      return {
        kind: 'vitals',
        vitals: {
          loadedAt: count(fields.loadedAt),
          ttfb: count(fields.ttfb),
          lcp: count(fields.lcp),
          load: count(fields.load),
          cls: typeof fields.cls === 'number' && fields.cls > 0 ? Math.round(fields.cls * 1000) / 1000 : 0,
          inp: count(fields.inp),
          longTasks: count(fields.longTasks),
          longMs: count(fields.longMs),
        },
      }
    }

    return undefined
  } catch {
    return undefined
  }
}

const WAS = /^(.*) \(was (.*)\)$/

/**
 * Whether a report's renders came with nothing changed: every value that says what it was before says the same on
 * both sides, and where none does, the values are those of the report before. A chain that says no value says
 * nothing either way.
 */
export const isUnchanged = (values: readonly string[], before: string | undefined): boolean => {
  const told = values.filter(value => value !== '')
  const changes = told.flatMap(value => {
    const [, to, from] = WAS.exec(value) ?? []

    return to === undefined ? [] : [to === from]
  })

  if (told.length === 0) return false

  return changes.length > 0 ? changes.every(Boolean) : told.join('\n') === before
}

// A line that leads with its level, however far it is set in: Nuxt and consola write ` ERROR  Cannot find …`
const LEADS_WITH_LEVEL = /^\s*\[?(ERROR|WARN(ING)?|FATAL|CRITICAL)\]?:?\s+\S/

// A stack trace's frames, and the causes chained under it: lines that belong to the line above. Node says what
// required a module that is not found as a list under `Require stack:`
const isContinuation = (text: string): boolean =>
  !LEADS_WITH_LEVEL.test(text) &&
  (/^\s+\S/.test(text) || /^(Caused by:|\.\.\. \d+ more|During handling of the above exception|The above exception was the direct cause|Require stack:|- \S+$)/.test(text))

const PYTHON_TRACE = /^Traceback \(most recent call last\)/

/** What makes two errors the same error: the message with its ids, addresses and numbers taken out. */
export const signatureOf = (message: string): string =>
  message
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
    .replace(/\b0x[0-9a-f]+\b|\b[0-9a-f]{12,}\b/gi, '<id>')
    .replace(/\d+/g, '<n>')
    .slice(0, 120)

// A line taken in by this read, until the read is over: a trace under it may still name what raised it
type Draft = { at: number; level: Level; message: string; fields: string; cause: string; more: number; trace: string[] }

// A trace with one more line under it, the middle of a long one left out and counted
const grown = (trace: readonly string[], text: string): string[] => {
  const line = redact(text.trimEnd()).slice(0, 300)

  if (trace.length < TRACE_HEAD + TRACE_TAIL) return [...trace, line]

  const left = /^… (\d+) more lines? …$/.exec(trace[TRACE_HEAD] ?? '')
  const tail = [...trace.slice(left === null ? TRACE_HEAD : TRACE_HEAD + 1), line]
  const out = Number(left?.[1] ?? 0) + tail.length - TRACE_TAIL

  return [...trace.slice(0, TRACE_HEAD), `… ${out} more line${out === 1 ? '' : 's'} …`, ...tail.slice(-TRACE_TAIL)]
}

/**
 * The watch once it has taken in new raw lines: each read, redacted and added, a trace folded under its first line,
 * and every error counted under its signature. A Python traceback ends on the exception that was raised: that line
 * is said with the line the trace hangs under, which is an error whatever it called itself. A signature first seen
 * now is stamped with the watch's edit count, which is what makes it new since the last edit.
 */
export const absorb = (watch: Watch, raws: readonly string[], now: number): Watch => {
  const held = [...watch.lines]
  const drafts: Draft[] = []
  // A watch held from before palantir counted renders has none
  const renders: Render[] = (watch.renders ?? []).map(render => ({ ...render }))
  let dom = watch.dom
  let actions = watch.actions ?? []
  const requests: Request[] = (watch.requests ?? []).map(request => ({ ...request }))
  let vitals = watch.vitals
  let isInPythonTrace = false

  // Onto the line a trace hangs under: one of this read, or the last of an earlier one
  const fold = (text: string, cause = '') => {
    const draft = drafts[drafts.length - 1]
    const last = held[held.length - 1]

    if (draft !== undefined) Object.assign(draft, { more: draft.more + 1, trace: grown(draft.trace, text), ...(cause === '' ? {} : { cause, level: 'error' }) })
    else if (last !== undefined) held[held.length - 1] = { ...last, more: last.more + 1, trace: grown(last.trace ?? [], text), ...(cause === '' ? {} : { level: 'error' as const }) }
  }

  for (const raw of raws) {
    const { stamp, text } = split(raw.replace(/\r$/, ''))

    if (text.trim() === '') continue

    const render = renderOf(text)

    if (render !== undefined) {
      const known = renders.find(({ component, chain }) => component === render.component && chain.join('\n') === render.chain.join('\n'))
      const at = render.at ?? now

      const same = isUnchanged(render.values, known?.valuesKey) ? render.count : 0
      const valuesKey = render.values.filter(value => value !== '').join('\n')

      if (known === undefined) {
        renders.push({ component: render.component, chain: render.chain, values: render.values, whole: render.whole, count: render.count, inside: render.inside, lastAt: at, firstAt: at, same, valuesKey, edit: watch.edits, countAtEdit: 0, file: render.file })
      }
      // The values kept are the last said: a line that says none for a step leaves the one held, short and whole
      else {
        Object.assign(known, {
          same: (known.same ?? 0) + same,
          valuesKey: valuesKey === '' ? known.valuesKey : valuesKey,
          file: render.file === '' ? known.file : render.file,
          count: known.count + render.count,
          inside: (known.inside ?? 0) + render.inside,
          lastAt: Math.max(known.lastAt, at),
          values: render.values.map((value, index) => value || (known.values?.[index] ?? '')),
          whole: render.values.map((value, index) => (value === '' ? (known.whole?.[index] ?? '') : (render.whole[index] ?? ''))),
        })
      }

      isInPythonTrace = false
      continue
    }

    const page = domOf(text)

    if (page !== undefined) {
      dom = { ...page, at: page.at ?? now }
      isInPythonTrace = false
      continue
    }

    const told = toldOf(text, now)

    if (told !== undefined) {
      if (told.kind === 'action') actions = [...actions, told.action]
      if (told.kind === 'vitals') vitals = told.vitals

      if (told.kind === 'request') {
        const known = requests.find(({ url }) => url === told.url)
        const failed = told.status === 0 || told.status >= 400 ? 1 : 0
        const at = told.at ?? now

        if (known === undefined) requests.push({ url: told.url, count: 1, failed, totalMs: told.ms, maxMs: told.ms, lastStatus: told.status, lastAt: at, countAtEdit: 0, totalMsAtEdit: 0 })
        else Object.assign(known, { count: known.count + 1, failed: known.failed + failed, totalMs: known.totalMs + told.ms, maxMs: Math.max(known.maxMs, told.ms), lastStatus: told.status, lastAt: Math.max(known.lastAt, at) })
      }

      isInPythonTrace = false
      continue
    }

    const hasHead = drafts.length > 0 || held.length > 0

    if (hasHead && PYTHON_TRACE.test(text)) {
      isInPythonTrace = true
      fold(text)
      continue
    }

    if (hasHead && isContinuation(text)) {
      fold(text)
      continue
    }

    // The first line of a traceback that is not a frame is the exception itself
    if (hasHead && isInPythonTrace) {
      isInPythonTrace = false
      fold(text, redact(text.trim()))
      continue
    }

    const line = read(text)

    drafts.push({
      at: (stamp === '' ? undefined : timeOf(stamp)) ?? line.at ?? now,
      level: line.level,
      message: redact(line.message),
      fields: redact(line.fields),
      cause: '',
      more: 0,
      trace: [],
    })
    isInPythonTrace = PYTHON_TRACE.test(text)
  }

  const signatures = watch.signatures.map(signature => ({ ...signature }))

  for (const { at, level, message, fields, cause, more, trace } of drafts) {
    const said = cause === '' ? message : `${message.replace(/:$/, '')}: ${cause}`

    held.push({ at, level, message: [said, fields].filter(part => part !== '').join(' ').slice(0, MAX_MESSAGE), more, ...(trace.length === 0 ? {} : { trace }) })

    if (level !== 'error') continue

    const key = signatureOf(said)
    const known = signatures.find(signature => signature.key === key)

    if (known === undefined) signatures.push({ key, sample: said.slice(0, MAX_MESSAGE), count: 1, lastAt: at, firstAt: at, edit: watch.edits, isAnnounced: false, ...(trace.length === 0 ? {} : { trace }) })
    else Object.assign(known, { count: known.count + 1, lastAt: Math.max(known.lastAt, at), ...(trace.length === 0 ? {} : { trace }) })
  }

  return {
    ...watch,
    lines: held.slice(-MAX_LINES),
    ...(dom === undefined ? {} : { dom }),
    actions: [...actions].sort((a, b) => a.at - b.at).slice(-MAX_ACTIONS),
    requests: requests.length > MAX_REQUESTS ? [...requests].sort((a, b) => b.lastAt - a.lastAt).slice(0, MAX_REQUESTS) : requests,
    ...(vitals === undefined ? {} : { vitals }),
    renders: renders.length > MAX_RENDERS ? [...renders].sort((a, b) => b.lastAt - a.lastAt).slice(0, MAX_RENDERS) : renders,
    // Past the limit the ones not seen for longest go
    signatures: signatures.length > MAX_SIGNATURES ? [...signatures].sort((a, b) => b.lastAt - a.lastAt).slice(0, MAX_SIGNATURES) : signatures,
  }
}

/** The errors that first showed after the last edit routed to the watch; none before any edit. */
export const fresh = (watch: Watch): Signature[] => (watch.edits === 0 ? [] : watch.signatures.filter(signature => signature.edit === watch.edits))

// The id a line says its request goes by, under the names apps give it
const REQUEST_ID = /\b(?:rid|request_?id|req_?id|trace_?id|correlation_?id)[=:]\s*"?([\w.-]{4,64})/gi

/** The request ids a line names, each once. */
export const requestIds = (message: string): string[] => [...new Set([...message.matchAll(REQUEST_ID)].flatMap(([, id]) => (id === undefined ? [] : [id])))]

// What asks an app whether it lives: written every few seconds, and nobody's doing
const NOISE = /(?:^|[\s"])(?:GET|HEAD) \S*\/(?:healthz?|livez?|readyz?|ready|live|liveness|readiness|ping|metrics|favicon\.ico)(?:[\s?"]|$)|\bkube-probe\b|\bELB-HealthChecker\b/i

/** Whether a line is a health check or the like: left out of the timeline unless asked for, never an error. */
export const isNoise = ({ level, message }: Line): boolean => level !== 'error' && NOISE.test(message)

/** `HH:MM:SS`, in the machine's own time zone. */
export const clockTime = (at: number): string => new Date(at).toTimeString().slice(0, 8)

export const describeLine = (label: string, line: Line): string =>
  `${clockTime(line.at)} [${label}] ${line.level.toUpperCase().padEnd(5)} ${line.message}${line.more > 0 ? ` (+${line.more} lines)` : ''}`

/** A trace as the lines said under what it hangs from, each set in. */
export const traceLines = (trace: readonly string[] | undefined, indent = '      '): string[] => (trace ?? []).map(line => `${indent}${line}`)

/** A line with the trace folded under it, where it has one: an error with where it was raised. */
export const describeWhole = (label: string, line: Line): string[] =>
  line.trace === undefined || line.trace.length === 0 ? [describeLine(label, line)] : [`${clockTime(line.at)} [${label}] ${line.level.toUpperCase().padEnd(5)} ${line.message}`, ...traceLines(line.trace)]
