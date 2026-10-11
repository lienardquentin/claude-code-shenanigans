import type { Elements, RenderElement, RenderSurface } from 'claude-code'

import type { Settings } from './budget'
import { actionLabel } from './kit/action-label'
import { badge } from './kit/badge'
import { card } from './kit/card'
import { divider } from './kit/divider'
import { table } from './kit/table'
import type { CellTone } from './kit/table'
import { tonedText } from './kit/toned-text'
import { DEPENDENTS_UNREAD, OUTWARD_MARK, blockOf, radiusOf, rowText } from './radius'
import type { Reading } from './radius'
import type { RunRecord } from './run'
import { notesOf, problemText, standingOf } from './status'
import type { Folder } from './status'
import { frontier, label, problemsOf } from './tickets'

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
  const canResume = !isBuilding(record) && problems.length === 0 && (record?.phase === 'attended' || takeable.size > 0)

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
              table({
                columns: [
                  { header: '#', width: 2 },
                  { header: 'State', width: 11 },
                  { header: 'Ticket' },
                  ...(hasRadius ? [{ header: 'Reach', width: 36 }] : []),
                  { header: 'Note' },
                ],
                rows: [...tickets]
                  .sort((a, b) => (a.number ?? 0) - (b.number ?? 0))
                  .map(ticket => {
                    const radius = radiusOf(ticket, reading)

                    return [
                      ticket.number !== undefined ? label(ticket.number) : '??',
                      { text: ticket.status ?? '?', tone: STATE_TONE[ticket.status ?? ''] ?? 'neutral' },
                      ticket.title,
                      ...(hasRadius
                        ? [{ text: rowText(radius), tone: radius.outward.length > 0 ? ('warning' as const) : ('neutral' as const) }]
                        : []),
                      notesOf(ticket, takeable, record).join(' · '),
                    ]
                  }),
              }),
              ...(hasRadius
                ? [
                    tonedText({ text: block.totals, tone: 'info' }),
                    ...(isUnread ? [tonedText({ text: DEPENDENTS_UNREAD, tone: 'warning' })] : []),
                    ...block.outward.map(line => tonedText({ text: `${OUTWARD_MARK} ${line}`, tone: 'warning' })),
                  ]
                : []),
            ]
          : []),
      ...quota,
      ...(canResume
        ? [
            <Button key={`resume-${feature}`} onPress={() => onResume(feature)}>
              {actionLabel({ text: record?.phase === 'attended' ? 'Approve and build' : 'Resume', primary: true })}
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
    onRefresh: () => void
  },
): RenderElement => {
  const { Box, Button } = elements
  const { folders, reading, width, settings, onResume, onRefresh } = given

  return (
    <Box flexDirection="column" gap={1}>
      {folders.length === 0
        ? card({
            width,
            title: 'ship-flow',
            children: [tonedText({ text: 'No run in this repo. Start one with /ship <idea> or /ship #<issue>.' })],
          })
        : folders.map(folder => runCard(elements, folder, width, settings, onResume, reading))}
      {divider()}
      <Button key="refresh" onPress={onRefresh}>
        {actionLabel({ text: 'Refresh' })}
      </Button>
    </Box>
  )
}
