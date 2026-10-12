import type { EngineInterface, Register } from 'claude-code'

const SEPARATOR = ' · '
const INTERVAL_MS = 10_000
const GIT_TIMEOUT_MS = 2_000
const NAME_LIMIT = 32

// A redraw that would start while another is still running is skipped
let isDrawing = false

// The last component of a path, whichever way it is written
const folderOf = (cwd: string): string => cwd.split(/[\\/]/).filter(part => part !== '').at(-1) ?? ''

// The whole percentage, marked from 60 and again from 85; nothing before the engine has a figure
const fillOf = (percent: number | undefined): string => {
  if (percent === undefined || !Number.isFinite(percent)) return ''

  const whole = Math.round(percent)

  return `${whole}%${whole >= 85 ? '!!' : whole >= 60 ? '!' : ''}`
}

// The name in full up to 32 characters; past that its first 16, an ellipsis and its last 15
const shortened = (name: string): string => {
  const chars = Array.from(name)

  return chars.length <= NAME_LIMIT ? name : `${chars.slice(0, 16).join('')}…${chars.slice(-15).join('')}`
}

// The branch of `git status --porcelain=v2 --branch` output: the name, or the short commit on a detached HEAD,
// then `*` when any entry line follows the headers; undefined when there is no `branch.head` header
const branchOf = (output: string): string | undefined => {
  const lines = output.split(/\r?\n/)
  const head = lines.find(line => line.startsWith('# branch.head '))?.slice('# branch.head '.length).trim()

  if (head === undefined || head === '') return undefined

  const oid = lines.find(line => line.startsWith('# branch.oid '))?.slice('# branch.oid '.length).trim() ?? ''
  const name = head === '(detached)' ? oid.slice(0, 7) : shortened(head)

  if (name === '') return undefined

  return lines.some(line => line !== '' && !line.startsWith('#')) ? `${name}*` : name
}

// One git call in the session's folder; any failure means no branch segment for this redraw
const branchIn = async ($: EngineInterface, cwd: string): Promise<string | undefined> => {
  try {
    const run = await $.process.run(['git', 'status', '--porcelain=v2', '--branch'], {
      ...(cwd !== '' ? { cwd } : {}),
      timeoutMs: GIT_TIMEOUT_MS,
    })

    return run.exitCode === 0 ? branchOf(run.stdout) : undefined
  } catch {
    return undefined
  }
}

// The terminal's width in columns as the last render event gave it, or undefined while none has.
//
// The plugin typings give a hook no width where the line is composed: `viewport.columns` rides only on render
// events, and `session.start`, `tool.call`, `turn.complete` and the clock carry none. So the width is remembered
// from the render of an assistant message, which costs no process. Until one has rendered the width stays
// unknown: the full line is pinned and the engine cuts it.
let columns: number | undefined

const columnsOf = (): number | undefined => columns

// The line: folder, branch, model and context fill, each left out with its separator when it has nothing to say.
// Given a width, whole segments are dropped until it fits: model, then branch, then folder; the fill stays.
const lineOf = (segments: readonly (string | undefined)[], columns?: number): string | undefined => {
  const [folder, branch, model, fill] = segments
  const kept = { folder, branch, model }
  const joined = () =>
    [kept.folder, kept.branch, kept.model, fill].filter(segment => segment !== undefined && segment !== '').join(SEPARATOR)

  if (columns !== undefined) {
    for (const name of ['model', 'branch', 'folder'] as const) {
      if (Array.from(joined()).length <= columns) break
      kept[name] = undefined
    }
  }

  const line = joined()

  return line === '' ? undefined : line
}

// Reads the session and pins the line; a figure that cannot be read leaves its segment out, and nothing is ever thrown
const redraw = async ($: EngineInterface): Promise<void> => {
  if (isDrawing) return
  isDrawing = true

  try {
    const [cwd, model, usage] = await Promise.all([
      $.session.cwd().catch(() => ''),
      $.session.model().catch(() => ''),
      $.session.usage().catch(() => undefined),
    ])

    const branch = await branchIn($, cwd)

    $.ui.status(lineOf([folderOf(cwd), branch, model, fillOf(usage?.context.percent)], columnsOf()))
  } catch {
    // The line stays as it was until the next redraw
  } finally {
    isDrawing = false
  }
}

export const register: Register = on => {
  on('ui.render', { component: 'AssistantMessage' }, async (_, e, next) => {
    const width = e.viewport?.columns

    columns = typeof width === 'number' && Number.isInteger(width) && width > 0 ? width : columns

    return next(e)
  })

  on('session.start', async ($, e, next) => {
    const started = await next(e)

    await redraw($)
    $.clock.every(INTERVAL_MS, () => void redraw($))

    return started
  })

  on('tool.call', async ($, e, next) => {
    const called = await next(e)

    void redraw($)

    return called
  })

  on('turn.complete', async ($, e, next) => {
    const completed = await next(e)

    void redraw($)

    return completed
  })
}
