const LEVELS = { debug: 20, info: 30, warn: 40, error: 50 } as const

/**
 * Anor's log: one JSON object per line, the level a number and the time in milliseconds, as pino writes them. A
 * trace goes under its line in plain indented lines, in the same write so nothing comes between them.
 */
export const herald = (level: keyof typeof LEVELS, msg: string, fields: Record<string, unknown> = {}, trace: string[] = []) => {
  const line = JSON.stringify({ level: LEVELS[level], time: Date.now(), msg, ...fields })

  process.stdout.write(`${[line, ...trace.map(frame => `    ${frame}`)].join('\n')}\n`)
}
