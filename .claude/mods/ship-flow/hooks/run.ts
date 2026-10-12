/**
 * Where a run stands: `unattended` while its tickets are built, `finishing` while the branch is reviewed and fixed,
 * `paused` when it waits (for quota, or for the person), `ended` once its pull request is open. `attended` is
 * the phase before the checkpoint: the grilling, the spec and the tickets, done with the person.
 */
export type Phase = 'attended' | 'unattended' | 'paused' | 'finishing' | 'ended'

/** One quota window as the session last read it. */
export type QuotaReading = { kind: string; percentUsed: number; resetsAt?: string }

/** The session's own figures when the run last looked: the main window's fill and each quota window. */
export type UsageReading = { at: number; contextPercent?: number; quota: readonly QuotaReading[] }

/**
 * One ticket being built: its implementer, and the git worktree and the branch it builds in, apart from every other
 * ticket's. The work lands on the run's branch once the run has verified it.
 */
export type Flight = {
  ticket: number
  /** The implementer at work; absent while the worktree is being made ready for it. */
  agentId?: string
  /** The worktree, relative to the repo's root, and the branch checked out in it. */
  tree: string
  branch: string
  /** How full the implementer's context was, in tokens, when it passed the budget. */
  tooLarge?: number
  /** True once an implementer past its budget was refused a tool call: it was stopped mid-work. */
  isStopped?: boolean
  /** When the ticket was taken, in milliseconds since the epoch: what its building took is counted from here. */
  startedAt?: number
}

/** A failed attempt of a ticket, and what the failure said. */
export type Failure = {
  reason: string
  output?: string
  /** True when the attempt's work is still in its worktree, for the next attempt to repair. */
  isKept?: boolean
  /** True when the work was sound and only its landing failed: the ticket is not charged an attempt for it. */
  isLanding?: boolean
}

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
  /** The tickets being built now, each in a worktree of its own. */
  flights?: readonly Flight[]
  /** The subagent at work on the run's branch while it is `finishing`: the reviewer, or the fix pass. */
  agentId?: string
  /** Which step the attended phase has reached: the grilling, then writing the spec, then writing the tickets. */
  step?: 'grilling' | 'spec' | 'tickets'
  /** The step whose start the main conversation was last compacted at, so that each boundary compacts it once. */
  compactedAt?: 'spec' | 'tickets'
  /**
   * What the run is at while `finishing`: the review of the branch, the one pass that fixes what it found, or a
   * pass that follows up its pull request's failing checks and comments.
   */
  stage?: 'review' | 'fix' | 'follow'
  /** The branch the run's branch is reviewed against and its pull request asks to be merged into. */
  base?: string
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
  /** The last failed attempt of each ticket, by ticket number, and what the failure said: what its retry is told. */
  failures?: Readonly<Record<string, Failure>>
  /** The tickets, by number, the run marked `blocked` only because they hang off one that was not built. */
  hangs?: readonly string[]
  /** How many times each ticket's landing failed at no cost to its attempts, by ticket number. */
  landings?: Readonly<Record<string, number>>
  /** How many attempts have ended since `startUsage` was read: what a ticket costs of the quota is counted over them. */
  ended?: number
  /** The files each ticket's commit changed, by ticket number: what its `Touches:` estimate is held against. */
  actual?: Readonly<Record<string, readonly string[]>>
  /** How long each ticket took to build, from taken to landed, in milliseconds, by ticket number. */
  took?: Readonly<Record<string, number>>
  /** The agents of a run the person stopped that may still be at work: each is refused whatever it calls next. */
  halted?: readonly string[]
  /** What became of the fix pass, in a sentence, once the review is done with. */
  fixes?: string
  /** What became of the last pass that followed up the pull request, in a sentence. */
  follow?: string
  /** The run's pull request, the commit it was last brought up to, and when its checks and comments were last followed up. */
  pr?: { url: string; head: string; followedAt?: string }
  /** What the checkpoint last told the model is wrong with the tickets, so that it is told again only when it changes. */
  lintShown?: string
  /** The blast radius block last printed at the checkpoint, so that it is printed again only when it changes. */
  radiusShown?: string
  /** The session's figures when the person last started the run, and when the run last looked. */
  startUsage?: UsageReading
  usage?: UsageReading
}

// Where a run keeps its working files, relative to the session's working directory
export const SCRATCH = '.scratch'

export const folderOf = (feature: string): string => `${SCRATCH}/${feature}`
/** What the run builds: `# Spec: <title>`, then the spec. A run from an idea opens its issue from it at the checkpoint. */
export const specOf = (feature: string): string => `${folderOf(feature)}/spec.md`
export const issuesOf = (feature: string): string => `${folderOf(feature)}/issues`
export const recordOf = (feature: string): string => `${folderOf(feature)}/run.json`
/** What the run started from, as the person typed it or as the issue said it. */
export const sourceOf = (feature: string): string => `${folderOf(feature)}/source.md`
/** What the reviewer found, as it reported it. */
export const reviewOf = (feature: string): string => `${folderOf(feature)}/review.md`
/** What the fix pass did about each finding, as it reported it. */
export const fixesOf = (feature: string): string => `${folderOf(feature)}/fixes.md`
/** The worktree a ticket is built in, by the ticket's label, and the branch checked out there: the run's, and the label. */
export const treeOf = (feature: string, key: string): string => `${folderOf(feature)}/trees/${key}`
export const ticketBranchOf = (branch: string, key: string): string => `${branch}--${key}`
/** What a pull request's checks and comments said when the run last followed them up, and what that pass reported. */
export const followupOf = (feature: string): string => `${folderOf(feature)}/followup.md`
export const followedOf = (feature: string): string => `${folderOf(feature)}/followed.md`

// The name, among a run's worktrees, of the one its branch is reviewed and fixed in
const FINISHING = 'finish'

/**
 * The worktree a run's branch is reviewed, fixed and followed up in, and the branch checked out there: apart from
 * the repo's own working tree, which is the person's.
 */
export const finishingOf = (record: Pick<RunRecord, 'feature' | 'branch'>): Pick<Flight, 'tree' | 'branch'> => ({
  tree: treeOf(record.feature, FINISHING),
  branch: ticketBranchOf(record.branch, FINISHING),
})

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

/** What of a record outlives the agents at work: everything but those agents and what they were doing. */
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
  ...(record.failures ? { failures: record.failures } : {}),
  ...(record.hangs?.length ? { hangs: record.hangs } : {}),
  ...(record.landings ? { landings: record.landings } : {}),
  ...(record.ended !== undefined ? { ended: record.ended } : {}),
  ...(record.actual ? { actual: record.actual } : {}),
  ...(record.took ? { took: record.took } : {}),
  ...(record.fixes !== undefined ? { fixes: record.fixes } : {}),
  ...(record.follow !== undefined ? { follow: record.follow } : {}),
  ...(record.pr ? { pr: record.pr } : {}),
  ...(record.startUsage ? { startUsage: record.startUsage } : {}),
})
