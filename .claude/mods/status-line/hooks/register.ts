import type { EngineInterface, Register } from 'claude-code'

const SEPARATOR = ' · '
const INTERVAL_MS = 10_000

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

// The line: folder, model and context fill, each left out with its separator when it has nothing to say
const lineOf = (segments: readonly (string | undefined)[]): string | undefined => {
  const line = segments.filter(segment => segment !== undefined && segment !== '').join(SEPARATOR)

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

    $.ui.status(lineOf([folderOf(cwd), model, fillOf(usage?.context.percent)]))
  } catch {
    // The line stays as it was until the next redraw
  } finally {
    isDrawing = false
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)

    await redraw($)
    $.clock.every(INTERVAL_MS, () => void redraw($))

    return started
  })

  on('tool.call', async ($, e, next) => {
    const called = await next(e)

    await redraw($)

    return called
  })

  on('turn.complete', async ($, e, next) => {
    const completed = await next(e)

    await redraw($)

    return completed
  })
}
