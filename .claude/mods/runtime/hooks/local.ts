import type { EnvVar, Usage } from '../types'
import { redactVar } from './lines'

// What can be known of an app that is only a log file and a port: the process that listens there, found through
// the machine's own tools, and the env files of its source. Every command line that asks the machine about its
// processes lives here, with its reading of what it prints. Nothing here stops or changes a process.

/** Whether the machine is Windows, told by how it writes the working directory. */
export const isWindows = (cwd: string): boolean => /^[A-Za-z]:/.test(cwd)

type Process = { pid: number; parent: number; cpuSeconds: number; bytes: number }

/** Who listens on which port, and every process with its parent: enough to add up a listener and its children. */
export type Probe = { listeners: { port: number; pid: number }[]; processes: Process[] }

const WINDOWS_SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  '$l = @(Get-NetTCPConnection -State Listen | Select-Object LocalPort, OwningProcess)',
  '$p = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, KernelModeTime, UserModeTime, WorkingSetSize)',
  '@{ listeners = $l; processes = $p } | ConvertTo-Json -Depth 3 -Compress',
].join('; ')

/** One command on Windows: the listeners and the processes, as JSON. */
export const WINDOWS_PROBE_ARGV = ['powershell', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_SCRIPT] as const

/** Two elsewhere: who listens, in the form `lsof` writes for programs, and every process. */
export const LISTENERS_ARGV = ['lsof', '-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn'] as const
export const PROCESSES_ARGV = ['ps', '-axo', 'pid=,ppid=,rss=,time='] as const

const number = (value: unknown): number => (Number.isFinite(Number(value)) ? Number(value) : 0)
const rows = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]) as Record<string, unknown>[]

/** What the Windows command printed. Windows counts processor time in tenths of a microsecond. */
export const readWindowsProbe = (stdout: string): Probe => {
  let whole: { listeners?: unknown; processes?: unknown } = {}

  try {
    whole = JSON.parse(stdout) as typeof whole
  } catch {
    return { listeners: [], processes: [] }
  }

  return {
    listeners: rows(whole.listeners).map(row => ({ port: number(row.LocalPort), pid: number(row.OwningProcess) })),
    processes: rows(whole.processes).map(row => ({
      pid: number(row.ProcessId),
      parent: number(row.ParentProcessId),
      cpuSeconds: (number(row.KernelModeTime) + number(row.UserModeTime)) / 1e7,
      bytes: number(row.WorkingSetSize),
    })),
  }
}

// Processor time as `ps` writes it: `1-02:03:04`, `02:03:04`, or `3:04.56`
const secondsOf = (time: string): number => {
  const [rest = '', days] = time.split('-').reverse()

  return rest.split(':').reduce((sum, part) => sum * 60 + number(part), 0) + number(days) * 86_400
}

/** What `lsof` and `ps` printed. `lsof` names a process on a `p` line, then each of its sockets on an `n` line. */
export const readUnixProbe = (listening: string, processes: string): Probe => {
  const listeners: Probe['listeners'] = []
  let pid = 0

  for (const line of listening.split('\n')) {
    if (line.startsWith('p')) pid = number(line.slice(1))

    const port = line.startsWith('n') ? /:(\d+)$/.exec(line.trim())?.[1] : undefined

    if (port !== undefined && pid > 0) listeners.push({ port: Number(port), pid })
  }

  return {
    listeners,
    processes: processes
      .split('\n')
      .map(line => line.trim().split(/\s+/))
      .filter(cells => cells.length >= 4)
      // `ps` counts memory in kilobytes
      .map(([id, parent, rss, time = '']) => ({ pid: number(id), parent: number(parent), cpuSeconds: secondsOf(time), bytes: number(rss) * 1024 })),
  }
}

/**
 * What the process that listens on the port holds, with the processes it started: a dev server answers from a
 * child of the one that listens. `undefined` when nothing listens there.
 */
export const listenerOf = (probe: Probe, port: number): { cpuSeconds: number; memory: number; processes: number } | undefined => {
  const root = probe.listeners.find(listener => listener.port === port)?.pid

  if (root === undefined) return undefined

  // A process id is used again once its process is gone: nothing is counted twice
  const family = new Set<number>([root])
  let grew = true

  while (grew) {
    grew = false

    for (const { pid, parent } of probe.processes) {
      if (family.has(parent) && !family.has(pid) && pid !== 0) {
        family.add(pid)
        grew = true
      }
    }
  }

  const members = probe.processes.filter(({ pid }) => family.has(pid))

  return {
    cpuSeconds: members.reduce((sum, member) => sum + member.cpuSeconds, 0),
    memory: members.reduce((sum, member) => sum + member.bytes, 0),
    processes: members.length,
  }
}

/**
 * What the app behind the port consumes. Its processor share is what it used since the read before, over the time
 * between the two: the first read has none to measure from, and neither has an app that started again since.
 */
export const localUsage = (probe: Probe, port: number, before: Usage | undefined, now: number): Usage => {
  const held = listenerOf(probe, port)

  if (held === undefined) return { cpu: -1, memory: -1, limit: 0, processes: 0, cpuSeconds: 0, at: now, note: `nothing listens on ${port}` }

  const elapsed = before === undefined ? 0 : (now - before.at) / 1000
  const spent = before === undefined ? -1 : held.cpuSeconds - before.cpuSeconds
  const isMeasured = before !== undefined && before.note === '' && before.cpuSeconds > 0 && elapsed > 0 && spent >= 0

  return { ...held, cpu: isMeasured ? Math.round((spent / elapsed) * 1000) / 10 : -1, limit: 0, at: now, note: '' }
}

/** The env files a local app's source may hold, a later one's value taking the place of an earlier one's. */
export const ENV_FILES = ['.env', '.env.local', '.env.development', '.env.development.local'] as const

export const LOCAL_ENV_NOTE = 'Read from the env files of its source. What the process itself was started with cannot be read from outside it.'

/** An env file's variables: `NAME=value`, `export` or not, quoted or not, a `#` line a comment. */
export const readEnvFile = (text: string, from: string): EnvVar[] =>
  text.split('\n').flatMap(line => {
    const found = /^\s*(?:export\s+)?([A-Za-z_][\w.]*)\s*=\s*(.*)$/.exec(line.replace(/\r$/, ''))

    if (found === null) return []

    const [, name = '', raw = ''] = found
    const quoted = /^(["'])(.*)\1\s*(?:#.*)?$/.exec(raw)
    const value = quoted === null ? raw.replace(/\s+#.*$/, '').trim() : (quoted[2] ?? '')

    return [{ name, value: redactVar(name, value), from }]
  })
