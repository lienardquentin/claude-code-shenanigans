import type { Elements, RenderElement, RenderSurface } from 'claude-code'

import type { Settings } from './budget'
import { requestOf } from './forge'
import { actionLabel } from './kit/action-label'
import { badge } from './kit/badge'
import type { Tone as CellTone } from './kit/badge'
import { card } from './kit/card'
import { divider } from './kit/divider'
import { tonedText } from './kit/toned-text'
import { DEPENDENTS_UNREAD, OUTWARD_MARK, blockOf, radiusOf, rowText } from './radius'
import type { Reading } from './radius'
import type { RunRecord } from './run'
import { notesOf, problemText, standingOf } from './status'
import type { Folder } from './status'
import { frontier, label, problemsOf, scheduleLines } from './tickets'

/** The pane's id, and its title. */
export const PANE = 'ship-flow'

// What each state of a ticket says by its colour
const STATE_TONE: Readonly<Record<string, CellTone>> = {
  done: 'success',
  'in-progress': 'accent',
  ready: 'neutral',
  blocked: 'danger',
  'too-large': 'warning',
}

// The quota windows as the session names them, as a person reads them, and the setting each is held to
const WINDOWS = [
  { kind: 'five_hour', name: '5h', threshold: 'shortWindowPercent' },
  { kind: 'seven_day', name: 'week', threshold: 'weeklyPercent' },
] as const

// How near its threshold a window has to be to stand out before it is reached, as a share of the threshold
const NEAR = 0.8

const isBuilding = (record: RunRecord | undefined): boolean => record?.phase === 'unattended' || record?.phase === 'finishing'

const standingTone = (record: RunRecord): CellTone =>
  record.phase === 'ended' ? 'success' : record.phase === 'paused' ? 'warning' : isBuilding(record) ? 'accent' : 'info'

// One run as a card: where it stands, its tickets, what it last read of the quota, and a way to take it up
const runCard = (
  { Button }: Pick<Elements[RenderSurface], 'Button'>,
  { feature, tickets, record }: Folder,
  width: number,
  settings: Settings,
  onResume: (feature: string) => void,
  onStop: (feature: string) => void,
  onAuto: (feature: string, isAuto: boolean) => void,
  reading: Reading | undefined,
): RenderElement => {
  const problems = problemsOf(tickets)
  const takeable = new Set(frontier(tickets))
  const done = tickets.filter(ticket => ticket.status === 'done').length
  const quota = WINDOWS.flatMap(({ kind, name, threshold }) => {
    const used = record?.usage?.quota.find(window => window.kind === kind)?.percentUsed

    if (used === undefined) return []

    const limit = settings[threshold]

    return [badge({ label: `${name} ${used}%`, tone: used >= limit ? 'danger' : used >= limit * NEAR ? 'warning' : 'neutral' })]
  })
  // The estimate stays on the card until the run ends: a pull request then holds the real answer
  const hasRadius = record?.phase !== 'ended'
  const block = blockOf(tickets, reading)
  const isUnread = reading === undefined && tickets.some(ticket => ticket.touches !== undefined)
  // A run whose pull request is open and whose tickets leave nothing to take follows up what the pull request has met
  const canFollow = !isBuilding(record) && record?.pr !== undefined && takeable.size === 0
  const canResume = !isBuilding(record) && problems.length === 0 && (record?.phase === 'attended' || takeable.size > 0 || canFollow)
  // A run waiting on the quota goes on by itself, so it too can be stopped
  const canStop = isBuilding(record) || (record?.phase === 'paused' && record.resumeAt !== undefined)
  // Before the checkpoint, how the run would build the tickets it is about to be approved with
  const schedule = record?.phase === 'attended' && problems.length === 0 ? scheduleLines(tickets, settings.parallelTickets) : []

  return card({
    width,
    title: feature,
    meta: tickets.length === 0 ? 'no tickets yet' : `${done} of ${tickets.length} done`,
    children: [
      ...(record ? [tonedText({ text: standingOf(record), tone: standingTone(record) })] : []),
      ...(problems.length > 0
        ? [
            tonedText({ text: 'The ticket folder cannot be run:', tone: 'danger', bold: true }),
            ...problems.map(problem => tonedText({ text: problemText(problem), tone: 'danger' })),
          ]
        : tickets.length > 0
          ? [
              ...[...tickets]
                .sort((a, b) => (a.number ?? 0) - (b.number ?? 0))
                .map(ticket => {
                  const radius = radiusOf(ticket, reading)

                  return card({
                    // The run card's border and padding take two cells each side
                    width: width - 4,
                    title: `${ticket.number !== undefined ? label(ticket.number) : '??'} · ${ticket.title}`,
                    children: [
                      badge({ label: ticket.status ?? '?', tone: STATE_TONE[ticket.status ?? ''] ?? 'neutral' }),
                      ...notesOf(ticket, takeable, record).map(note =>
                        tonedText({ text: note, tone: note.startsWith('failed: ') ? 'danger' : undefined }),
                      ),
                      ...(ticket.criteria.length > 0
                        ? [tonedText({ text: `${ticket.criteria.filter(criterion => criterion.isDone).length} of ${ticket.criteria.length} criteria` })]
                        : []),
                      ...(hasRadius
                        ? [tonedText({ text: rowText(radius), tone: radius.outward.length > 0 ? 'warning' : 'neutral' })]
                        : []),
                      ...(hasRadius
                        ? radius.outward.map(action => tonedText({ text: `${OUTWARD_MARK} ${action}`, tone: 'warning' }))
                        : []),
                    ],
                  })
                }),
              ...(hasRadius
                ? [
                    tonedText({ text: block.totals, tone: 'info' }),
                    ...(isUnread ? [tonedText({ text: DEPENDENTS_UNREAD, tone: 'warning' })] : []),
                    ...block.undeclared.map(line => tonedText({ text: line, tone: 'warning' })),
                  ]
                : []),
              ...schedule.map(line => tonedText({ text: line, tone: 'info' })),
            ]
          : []),
      ...quota,
      ...(canResume
        ? [
            <Button key={`resume-${feature}`} onPress={() => onResume(feature)}>
              {actionLabel({
                text: record?.phase === 'attended' ? 'Approve and build' : canFollow ? `Follow up the ${requestOf(record)}` : 'Resume',
                primary: true,
              })}
            </Button>,
          ]
        : []),
      // Only before the checkpoint is there anything a run would ask: there it is switched to auto, or back
      ...(record?.phase === 'attended'
        ? [
            <Button key={`auto-${feature}`} onPress={() => onAuto(feature, record.isAuto !== true)}>
              {actionLabel({ text: record.isAuto ? 'Hand it back to me' : 'Go auto: ask me nothing' })}
            </Button>,
          ]
        : []),
      ...(canStop
        ? [
            <Button key={`stop-${feature}`} onPress={() => onStop(feature)}>
              {actionLabel({ text: 'Stop' })}
            </Button>,
          ]
        : []),
    ],
  })
}

/**
 * The pane: every run of the repo as a card, newest state on each redraw. Everything styled is a ui-kit part; the
 * buttons and the column that holds the cards are the mod's own.
 */
export const paneOf = (
  elements: Pick<Elements[RenderSurface], 'Box' | 'Button'>,
  given: {
    folders: readonly Folder[]
    /** What was read of the repo through `git`; absent when it could not be read. */
    reading?: Reading
    width: number
    settings: Settings
    onResume: (feature: string) => void
    onStop: (feature: string) => void
    /** Switches a run before its checkpoint to an auto run, or back. */
    onAuto: (feature: string, isAuto: boolean) => void
    onRefresh: () => void
  },
): RenderElement => {
  const { Box, Button } = elements
  const { folders, reading, width, settings, onResume, onStop, onAuto, onRefresh } = given

  return (
    <Box flexDirection="column" gap={1}>
      {folders.length === 0
        ? card({
            width,
            title: 'ship-flow',
            children: [tonedText({ text: 'No run in this repo. Start one with /ship <idea> or /ship #<issue>.' })],
          })
        : folders.map(folder => runCard(elements, folder, width, settings, onResume, onStop, onAuto, reading))}
      {divider()}
      <Button key="refresh" onPress={onRefresh}>
        {actionLabel({ text: 'Refresh' })}
      </Button>
    </Box>
  )
}
