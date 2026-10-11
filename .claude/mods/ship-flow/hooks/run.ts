/** Where a run stands. Only `unattended` and `paused` are reached so far. */
export type Phase = 'attended' | 'unattended' | 'paused' | 'finishing' | 'ended'

/** One quota window as the session last read it. */
export type QuotaReading = { kind: string; percentUsed: number; resetsAt?: string }

/** The session's own figures when the run last looked: the main window's fill and each quota window. */
export type UsageReading = { at: number; contextPercent?: number; quota: readonly QuotaReading[] }

/**
 * The record of a run, kept beside its spec. With the ticket files it is the whole state of the run: nothing
 * needed to go on lives in the module's memory, which a reload empties.
 */
export type RunRecord = {
  feature: string
  branch: string
  phase: Phase
  /** The ticket being built, and the subagent building it, while one is. */
  ticket?: number
  agentId?: string
  /** A shell command the implementer was refused during this attempt: the attempt has failed. */
  refused?: string
  /** How full the implementer's context was, in tokens, when it passed the budget and was stopped. */
  tooLarge?: number
  /** How many times each ticket was attempted, by ticket number. */
  attempts: Readonly<Record<string, number>>
  /** Why the run is not building now, when it is not. */
  pause?: string
  /** When a run paused for quota goes on by itself, in milliseconds since the epoch. */
  resumeAt?: number
  /** The last ticket that failed, and what the failure said. */
  failure?: { ticket: number; reason: string; output?: string }
  usage?: UsageReading
}

// Where a run keeps its working files, relative to the session's working directory
export const SCRATCH = '.scratch'

export const folderOf = (feature: string): string => `${SCRATCH}/${feature}`
export const specOf = (feature: string): string => `${folderOf(feature)}/spec.md`
export const issuesOf = (feature: string): string => `${folderOf(feature)}/issues`
export const recordOf = (feature: string): string => `${folderOf(feature)}/run.json`

/** A run record as its file holds it. */
export const recordText = (record: RunRecord): string => `${JSON.stringify(record, null, 2)}\n`

/** A run record read from its file's text, or undefined when the text is not one. */
export const parseRecord = (text: string): RunRecord | undefined => {
  try {
    const read = JSON.parse(text) as Partial<RunRecord> | null

    return read && typeof read.feature === 'string' && typeof read.phase === 'string'
      ? { branch: '', attempts: {}, ...read, feature: read.feature, phase: read.phase }
      : undefined
  } catch {
    return undefined
  }
}
