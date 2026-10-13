// @ui-kit
// ui-kit part: logLines. Copy this file to a mod's `hooks/kit/log-lines.ts`, then
// `import { logLines } from './kit/log-lines'`. Self-contained: its only import is a type.
import type { RenderElement } from 'claude-code'

export type LogLevel = 'info' | 'warn' | 'error'

export type LogEntry = { at: string; level: LogLevel; message: string }

const LEVEL_COLOR: Record<LogLevel, string> = {
  info: 'suggestion',
  warn: 'warning',
  error: 'error',
}

// A log line's head is the time and the level padded to 5, two cells apart, then two cells before the message
const HEAD_WIDTH = 17

const node = (type: string, props: Record<string, unknown>, children: readonly (RenderElement | string)[] = []): RenderElement =>
  (children.length > 0 ? { type, props, children } : { type, props }) as unknown as RenderElement

const text = (props: Record<string, string | number | boolean>, ...children: string[]): RenderElement =>
  node('Text', props, children)

/** Log lines: time, level (colored), message; a long message wraps by words under the message column. */
export const logLines = ({ entries }: { entries: readonly LogEntry[] }): RenderElement => {
  if (entries.length === 0) return text({ color: 'subtle' }, 'No events yet.')

  return node(
    'Box',
    { flexDirection: 'column' },
    entries.map(({ at, level, message }) =>
      node('Box', { flexDirection: 'row' }, [
        node('Box', { width: HEAD_WIDTH, flexShrink: 0, flexDirection: 'row', gap: 2 }, [
          text({ color: 'subtle' }, at),
          text({ color: LEVEL_COLOR[level] }, level.toUpperCase().padEnd(5)),
        ]),
        node('Box', { flexGrow: 1, flexShrink: 1 }, [text({}, message)]),
      ]),
    ),
  )
}
