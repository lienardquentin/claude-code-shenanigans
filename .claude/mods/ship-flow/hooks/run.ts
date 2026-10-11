/**
 * Where a run stands: `unattended` while a ticket is built, `finishing` while the branch is reviewed and fixed,
 * `paused` when it waits (for quota, or for the person), `ended` once its pull request is open. `attended` is
 * the phase before the checkpoint: the grilling, the spec and the tickets, done with the person.
 */
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
  /** What the run started from: an idea the person typed, or an issue that existed. */
  source?: 'idea' | 'issue'
  /** The GitHub issue the run's pull request closes, when the run has one. */
  issue?: number
  /** What the feature is called where a person reads it: its issue's title, and its pull request's. */
  title?: string
  /** The ticket being built, and the subagent at work (an implementer, or the reviewer), while one is. */
  ticket?: number
  agentId?: string
  /** Which step the attended phase has reached: the grilling, then writing the spec, then writing the tickets. */
  step?: 'grilling' | 'spec' | 'tickets'
  /** The step whose start the main conversation was last compacted at, so that each boundary compacts it once. */
  compactedAt?: 'spec' | 'tickets'
  /** What the run is at while `finishing`: the review of the branch, or the one pass that fixes what it found. */
  stage?: 'review' | 'fix'
  /** The branch the run's branch is reviewed against and its pull request asks to be merged into. */
  base?: string
  /** A shell command the agent at work was refused: an implementer's attempt has failed. */
  refused?: string
  /** How full the implementer's context was, in tokens, when it passed the budget. */
  tooLarge?: number
  /** True once an implementer past its budget was refused a tool call: it was stopped mid-work. */
  isStopped?: boolean
  /** The fullest each ticket's implementer got, in tokens of context, by ticket number: what the budget is tuned on. */
  peak?: Readonly<Record<string, number>>
  /** How many times each ticket was attempted, by ticket number. */
  attempts: Readonly<Record<string, number>>
  /** The commit that holds each ticket built by this run, by ticket number. */
  commits?: Readonly<Record<string, string>>
  /** Why each ticket that could not be built failed, by ticket number. */
  reasons?: Readonly<Record<string, string>>
  /** Why the run is not building now, when it is not. */
  pause?: string
  /** When a run paused for quota goes on by itself, in milliseconds since the epoch. */
  resumeAt?: number
  /** The last ticket that failed, and what the failure said: what its retry is told. */
  failure?: { ticket: number; reason: string; output?: string }
  /** What became of the fix pass, in a sentence, once the review is done with. */
  fixes?: string
  /** The run's pull request, and the commit it was last brought up to. */
  pr?: { url: string; head: string }
  /** The session's figures when the person last started the run, and when the run last looked. */
  startUsage?: UsageReading
  usage?: UsageReading
}

// Where a run keeps its working files, relative to the session's working directory
export const SCRATCH = '.scratch'

export const folderOf = (feature: string): string => `${SCRATCH}/${feature}`
export const specOf = (feature: string): string => `${folderOf(feature)}/spec.md`
export const issuesOf = (feature: string): string => `${folderOf(feature)}/issues`
export const recordOf = (feature: string): string => `${folderOf(feature)}/run.json`
/** What the run started from, as the person typed it or as the issue said it. */
export const sourceOf = (feature: string): string => `${folderOf(feature)}/source.md`
/** The text of the issue the run opens at the checkpoint, when it started from an idea: `# <title>`, then the body. */
export const issueOf = (feature: string): string => `${folderOf(feature)}/issue.md`
/** What the reviewer found, as it reported it. */
export const reviewOf = (feature: string): string => `${folderOf(feature)}/review.md`
/** What the fix pass did about each finding, as it reported it. */
export const fixesOf = (feature: string): string => `${folderOf(feature)}/fixes.md`

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

/** What of a record outlives the agent at work: everything but that agent and what it was doing. */
export const kept = (record: RunRecord) => ({
  feature: record.feature,
  branch: record.branch,
  attempts: record.attempts,
  ...(record.source !== undefined ? { source: record.source } : {}),
  ...(record.issue !== undefined ? { issue: record.issue } : {}),
  ...(record.title !== undefined ? { title: record.title } : {}),
  ...(record.base !== undefined ? { base: record.base } : {}),
  ...(record.peak ? { peak: record.peak } : {}),
  ...(record.commits ? { commits: record.commits } : {}),
  ...(record.reasons ? { reasons: record.reasons } : {}),
  ...(record.failure ? { failure: record.failure } : {}),
  ...(record.fixes !== undefined ? { fixes: record.fixes } : {}),
  ...(record.pr ? { pr: record.pr } : {}),
  ...(record.startUsage ? { startUsage: record.startUsage } : {}),
})
