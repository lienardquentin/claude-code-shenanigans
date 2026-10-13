import type { Dom, Level, Line, Render, Signature, Watch } from '../types'

// What turns the text an app wrote into lines palantir can sort: its time, its level, its message with the
// secrets taken out. Nothing here reaches outside: text in, values out.

const MAX_LINES = 300
const MAX_SIGNATURES = 100
const MAX_MESSAGE = 600
const MAX_RENDERS = 80
const MAX_STEPS = 12
const MAX_WHOLE = 2000
const MAX_ELEMENTS = 300

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

  return {
    level: ERROR_LOOK.test(trimmed) || ERROR_LOOK_ANY_CASE.test(trimmed) ? 'error' : WARN_LOOK.test(trimmed) ? 'warn' : 'info',
    // The level a plain line leads with is said by the level itself
    message: trimmed.replace(/^(?:\[?(?:ERROR|WARN(?:ING)?|INFO|DEBUG|FATAL|CRITICAL)\]?:?\s+)(?=\S)/, ''),
    fields: '',
  }
}

/**
 * A render as a frontend reports it in its log: a JSON line that says `"palantir":"render"`, the component, and the
 * chain that led to it, the cause first. Such a line is no line of the timeline: it is counted, chain by chain.
 */
export const renderOf = (text: string): { component: string; chain: string[]; values: string[]; whole: string[]; count: number; at?: number } | undefined => {
  const trimmed = text.trim()

  if (!trimmed.startsWith('{') || !trimmed.includes('"palantir"')) return undefined

  try {
    const fields = JSON.parse(trimmed) as Record<string, unknown>

    if (fields.palantir !== 'render' || typeof fields.component !== 'string' || !Array.isArray(fields.chain)) return undefined

    const chain = fields.chain.slice(0, MAX_STEPS).map(step => redact(String(step)).slice(0, 120))
    const values: unknown[] = Array.isArray(fields.values) ? fields.values : []
    const whole: unknown[] = Array.isArray(fields.whole) ? fields.whole : []

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
      count: typeof fields.count === 'number' && fields.count >= 1 ? Math.round(fields.count) : 1,
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
      at: timeOf(fields.time ?? fields.ts),
    }
  } catch {
    return undefined
  }
}

// A stack trace's frames, and the causes chained under it: lines that belong to the line above
const isContinuation = (text: string): boolean =>
  /^\s+\S/.test(text) || /^(Caused by:|\.\.\. \d+ more|During handling of the above exception|The above exception was the direct cause)/.test(text)

const PYTHON_TRACE = /^Traceback \(most recent call last\)/

/** What makes two errors the same error: the message with its ids, addresses and numbers taken out. */
export const signatureOf = (message: string): string =>
  message
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
    .replace(/\b0x[0-9a-f]+\b|\b[0-9a-f]{12,}\b/gi, '<id>')
    .replace(/\d+/g, '<n>')
    .slice(0, 120)

// A line taken in by this read, until the read is over: a trace under it may still name what raised it
type Draft = { at: number; level: Level; message: string; fields: string; cause: string; more: number }

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
  let isInPythonTrace = false

  // Onto the line a trace hangs under: one of this read, or the last of an earlier one
  const fold = (cause = '') => {
    const draft = drafts[drafts.length - 1]
    const last = held[held.length - 1]

    if (draft !== undefined) Object.assign(draft, { more: draft.more + 1, ...(cause === '' ? {} : { cause, level: 'error' }) })
    else if (last !== undefined) held[held.length - 1] = { ...last, more: last.more + 1, ...(cause === '' ? {} : { level: 'error' as const }) }
  }

  for (const raw of raws) {
    const { stamp, text } = split(raw.replace(/\r$/, ''))

    if (text.trim() === '') continue

    const render = renderOf(text)

    if (render !== undefined) {
      const known = renders.find(({ component, chain }) => component === render.component && chain.join('\n') === render.chain.join('\n'))
      const at = render.at ?? now

      if (known === undefined) renders.push({ component: render.component, chain: render.chain, values: render.values, whole: render.whole, count: render.count, lastAt: at })
      // The values kept are the last said: a line that says none for a step leaves the one held, short and whole
      else {
        Object.assign(known, {
          count: known.count + render.count,
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

    const hasHead = drafts.length > 0 || held.length > 0

    if (hasHead && PYTHON_TRACE.test(text)) {
      isInPythonTrace = true
      fold()
      continue
    }

    if (hasHead && isContinuation(text)) {
      fold()
      continue
    }

    // The first line of a traceback that is not a frame is the exception itself
    if (hasHead && isInPythonTrace) {
      isInPythonTrace = false
      fold(redact(text.trim()))
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
    })
    isInPythonTrace = PYTHON_TRACE.test(text)
  }

  const signatures = watch.signatures.map(signature => ({ ...signature }))

  for (const { at, level, message, fields, cause, more } of drafts) {
    const said = cause === '' ? message : `${message.replace(/:$/, '')}: ${cause}`

    held.push({ at, level, message: [said, fields].filter(part => part !== '').join(' ').slice(0, MAX_MESSAGE), more })

    if (level !== 'error') continue

    const key = signatureOf(said)
    const known = signatures.find(signature => signature.key === key)

    if (known === undefined) signatures.push({ key, sample: said.slice(0, MAX_MESSAGE), count: 1, lastAt: at, edit: watch.edits, isAnnounced: false })
    else Object.assign(known, { count: known.count + 1, lastAt: Math.max(known.lastAt, at) })
  }

  return {
    ...watch,
    lines: held.slice(-MAX_LINES),
    ...(dom === undefined ? {} : { dom }),
    renders: renders.length > MAX_RENDERS ? [...renders].sort((a, b) => b.lastAt - a.lastAt).slice(0, MAX_RENDERS) : renders,
    // Past the limit the ones not seen for longest go
    signatures: signatures.length > MAX_SIGNATURES ? [...signatures].sort((a, b) => b.lastAt - a.lastAt).slice(0, MAX_SIGNATURES) : signatures,
  }
}

/** The errors that first showed after the last edit routed to the watch; none before any edit. */
export const fresh = (watch: Watch): Signature[] => (watch.edits === 0 ? [] : watch.signatures.filter(signature => signature.edit === watch.edits))

/** `HH:MM:SS`, in the machine's own time zone. */
export const clockTime = (at: number): string => new Date(at).toTimeString().slice(0, 8)

export const describeLine = (label: string, line: Line): string =>
  `${clockTime(line.at)} [${label}] ${line.level.toUpperCase().padEnd(5)} ${line.message}${line.more > 0 ? ` (+${line.more} lines)` : ''}`
