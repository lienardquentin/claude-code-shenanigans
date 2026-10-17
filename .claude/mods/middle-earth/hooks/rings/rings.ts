import type { RingsIssue } from '../../types'
import { refText } from '../../core/forge'
import type { IssueSummary, Repo } from '../../core/forge'

// How much of an issue's body the pane shows of the one it opens
const BODY_CHARS = 600

export const HOW_TO = 'The Rings list the open issues of the repository the origin remote names: /rings reads them again.'

/** The open issues the forge listed, each with the ref Elrond and the Fellowship know it by, its body cut for the pane. */
export const ringsOf = (listed: readonly IssueSummary[], origin: Repo): RingsIssue[] =>
  listed.map(issue => ({ ...issue, ref: refText({ ...origin, number: issue.number }), body: issue.body.length > BODY_CHARS ? `${issue.body.slice(0, BODY_CHARS)}…` : issue.body }))

/** Where an issue stands with the other parts, in a few words: its quest, else its plan, else nothing yet. */
export const standingOf = (quest: { kind: string; phase: string } | undefined, plan: string): string =>
  quest !== undefined ? `${quest.kind} · ${quest.phase}` : plan
