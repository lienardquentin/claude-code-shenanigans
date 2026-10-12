import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import type { TimelineLane, TimelineSpan } from '../types'
import { actionLabel } from './kit/action-label'
import { badge } from './kit/badge'
import { card } from './kit/card'
import { divider } from './kit/divider'
import { table } from './kit/table'
import { tonedText } from './kit/toned-text'
import {
  KINDS,
  MAIN,
  RANGES,
  RANGE_LABELS,
  busyOf,
  clockOf,
  isRange,
  lanesIn,
  lengthOf,
  periodOf,
  rowOf,
  spansIn,
  targetOf,
  toneOf,
} from './timeline'

type Engine = EngineInterface

const PANE = 'timeline-view'

// A long session makes thousands of calls: the oldest spans go first
const MAX_SPANS = 1500
const TICK_MS = 1000
// The lane's name, drawn left of its row
const LABEL_COLUMNS = 16
const MIN_COLUMNS = 20
const MAX_LANES = 12
const MAX_ROWS = 12

const spans = atom({ plugin: 'timeline-view', key: 'spans' } as const, [] as TimelineSpan[])
const lanes = atom({ plugin: 'timeline-view', key: 'lanes' } as const, [] as TimelineLane[])
const selected = atom({ plugin: 'timeline-view', key: 'selected' } as const, MAIN)
const range = atom({ plugin: 'timeline-view', key: 'range' } as const, 'all')
const now = atom({ plugin: 'timeline-view', key: 'now' } as const, 0)

let counter = 0
const newId = (): string => `${(counter += 1)}-${Math.random().toString(36).slice(2, 10)}`

const begin = async ($: Engine, span: Omit<TimelineSpan, 'start'>): Promise<void> => {
  const start = await $.clock.now()

  await update($, spans, all => [...all, { ...span, start }].slice(-MAX_SPANS))
  await update($, now, () => start)
}

const finish = async ($: Engine, id: string, failed: boolean): Promise<void> => {
  const end = await $.clock.now()

  await update($, spans, all => all.map(span => (span.id === id ? { ...span, end, ...(failed ? { failed } : {}) } : span)))
  await update($, now, () => end)
}

// A subagent's lane, opened when it is spawned, or when its first call arrives for one spawned before the mod loaded
const openLane = async ($: Engine, id: string, label: string | undefined): Promise<void> => {
  const known = (await read($, lanes)).find(lane => lane.id === id)
  if (known !== undefined && known.end === undefined) return

  const start = await $.clock.now()
  const named = label ?? (await nameOf($, id))

  await update($, lanes, all =>
    all.some(lane => lane.id === id)
      ? // A teammate takes turn after turn: its lane opens again
        all.map(lane => (lane.id === id ? { ...lane, end: undefined } : lane))
      : [...all, { id, label: named, start }],
  )
}

// What the engine calls an agent: its task's description, else its type. One it no longer lists is still a subagent.
const nameOf = async ($: Engine, id: string): Promise<string> => {
  try {
    const found = (await $.agent.list()).find(agent => agent.id === id)

    return found?.description || found?.name || found?.type || 'subagent'
  } catch {
    return 'subagent'
  }
}

const isRunning = (all: readonly { end?: number }[]): boolean => all.some(one => one.end === undefined)

// The lanes of agents the engine no longer runs are closed where their last call ended: a run that was killed
// never says it completed
const closeLost = async ($: Engine, at: number): Promise<void> => {
  const open = (await read($, lanes)).filter(lane => lane.end === undefined)
  if (open.length === 0) return

  const listed = await $.agent.list().catch(() => undefined)
  if (listed === undefined) return

  const working = new Set(listed.filter(agent => !['completed', 'failed', 'killed'].includes(agent.status)).map(agent => agent.id))
  const lost = new Set(open.filter(lane => !working.has(lane.id)).map(lane => lane.id))
  if (lost.size === 0) return

  const recorded = await read($, spans)
  await update($, lanes, all =>
    all.map(lane => {
      if (!lost.has(lane.id) || lane.end !== undefined) return lane
      const ends = recorded.filter(span => span.lane === lane.id).map(span => span.end ?? at)

      return { ...lane, end: ends.length > 0 ? Math.max(...ends) : at }
    }),
  )
}

const pad = (text: string, columns: number): string =>
  text.length > columns ? `${text.slice(0, columns - 1)}…` : text.padEnd(columns)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'timeline', description: 'Open the timeline of turns, tool calls and subagents' })
    // What still runs grows by itself; a quiet session redraws nothing
    $.clock.every(TICK_MS, async () => {
      if (!isRunning(await read($, spans)) && !isRunning(await read($, lanes))) return

      const at = await $.clock.now()
      await closeLost($, at)
      await update($, now, () => at)
    })

    return next(e)
  })

  // A /clear starts a conversation with nothing done in it yet
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, spans, () => [])
      await update($, lanes, () => [])
      await update($, selected, () => MAIN)
    }

    return next(e)
  })

  on('command.run', { command: 'timeline' }, async $ => {
    const at = await $.clock.now()
    await update($, now, () => at)
    await $.ui.open({ id: PANE, title: 'Timeline' })

    return { text: 'Timeline pane opened.' }
  })

  on('turn.start', async ($, e, next) => {
    await begin($, { id: e.turnId, lane: MAIN, kind: 'turn', name: 'turn', target: targetOf({ prompt: e.text }) }).catch(() => undefined)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    try {
      if (e.agentId === undefined) {
        await finish($, e.turnId, e.reason === 'error')
      } else {
        const end = await $.clock.now()
        await update($, lanes, all => all.map(lane => (lane.id === e.agentId ? { ...lane, end } : lane)))
        await update($, now, () => end)
      }
    } catch {
      // The timeline misses an end; the turn goes on
    }

    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)

    if (started.agentId !== undefined) {
      await openLane($, started.agentId, e.description.trim() || e.subagentType).catch(() => undefined)
    }

    return started
  }).catch(($, e, next) => next(e))

  // Every tool call, in whichever loop it runs: the call itself is passed on untouched, whatever the recording does
  on('tool.call', async ($, e, next) => {
    const id = newId()
    const lane = e.agentId ?? MAIN

    const recorded = await (async () => {
      if (e.agentId !== undefined) await openLane($, e.agentId, undefined)
      await begin($, { id, lane, kind: 'tool', name: String(e.tool), target: targetOf(e as unknown as Record<string, unknown>) })

      return true
    })().catch(() => false)

    try {
      const result = await next(e)
      if (recorded) await finish($, id, result.deny !== undefined || result.isError === true).catch(() => undefined)

      return result
    } catch (error) {
      if (recorded) await finish($, id, true).catch(() => undefined)
      throw error
    }
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Button } = elements
    // Mobile draws no picker: the whole session is shown there
    const Select = 'Select' in elements ? elements.Select : undefined
    const width = e.props.bodyColumns ?? 80
    const recorded = await read($, spans)
    const agents = await read($, lanes)
    const picked = await read($, range)
    const at = await read($, now)
    const chosen = await read($, selected)
    const period = periodOf(recorded, agents, isRange(picked) ? picked : 'all', at)

    const controls = (
      <Box key="controls" flexDirection="row" gap={2}>
        {Select !== undefined ? (
          <Select
            key="range"
            label="Show"
            options={RANGES.map(value => ({ value, label: RANGE_LABELS[value] }))}
            value={isRange(picked) ? picked : 'all'}
            onSelect={value => {
              if (isRange(value)) void update($, range, () => value)
            }}
          />
        ) : null}
        <Button
          key="clear"
          onPress={async () => {
            await update($, spans, all => all.filter(span => span.end === undefined))
            await update($, lanes, all => all.filter(lane => lane.end === undefined))
            await update($, selected, () => MAIN)
          }}
        >
          {actionLabel({ text: 'Clear' })}
        </Button>
      </Box>
    )

    if (period === undefined) {
      return card({
        width,
        title: 'Timeline',
        meta: 'nothing yet',
        children: [tonedText({ text: 'Nothing recorded yet: the timeline fills as turns, tool calls and subagents run.', tone: 'neutral', wrap: true })],
      })
    }

    // The card's border and padding take two cells each side
    const columns = Math.max(MIN_COLUMNS, width - 4 - LABEL_COLUMNS - 1)
    const shown = lanesIn(recorded, agents, period, at)
    const drawn = shown.slice(0, MAX_LANES)
    const current = shown.find(lane => lane.id === chosen) ?? shown[0]
    const listed = current === undefined ? [] : spansIn(recorded, current.id, period, at)
    const calls = listed.filter(span => span.kind === 'tool')

    const rows: RenderElement[] = drawn.map(lane => (
      <Box key={`row-${lane.id}`} flexDirection="row" gap={1}>
        <Button key={`lane-${lane.id}`} plain onPress={() => update($, selected, () => lane.id)}>
          {tonedText({ text: pad(lane.label, LABEL_COLUMNS), bold: lane.id === current?.id, ...(lane.id === current?.id ? {} : { tone: 'neutral' as const }) })}
        </Button>
        <Box key={`cells-${lane.id}`} flexDirection="row">
          {rowOf(lane, recorded, period, columns, at).map(run => tonedText(run))}
        </Box>
      </Box>
    ))

    const ends = `${clockOf(period.from)}${clockOf(period.to).padStart(columns - 8)}`

    return card({
      width,
      title: 'Timeline',
      meta: `${lengthOf(period.to - period.from)} · one cell ${lengthOf((period.to - period.from) / columns)}`,
      children: [
        controls,
        <Box key="legend" flexDirection="row" gap={2} marginTop={1}>
          {KINDS.map(kind => badge({ label: kind.label, tone: kind.tone }))}
          {badge({ label: 'other', tone: 'neutral' })}
          {badge({ label: 'failed', tone: 'danger' })}
        </Box>,
        <Box key="lanes" flexDirection="column" marginTop={1}>
          {rows}
          <Box key="axis" flexDirection="row" gap={1}>
            {tonedText({ text: pad('', LABEL_COLUMNS) })}
            {tonedText({ text: ends, tone: 'neutral' })}
          </Box>
        </Box>,
        ...(shown.length > drawn.length
          ? [tonedText({ text: `${shown.length - drawn.length} more lanes are not drawn; a shorter period shows fewer.`, tone: 'neutral', wrap: true })]
          : []),
        divider(),
        tonedText({
          text: `${current?.label ?? 'main'}: ${calls.length} ${calls.length === 1 ? 'call' : 'calls'}, ${lengthOf(busyOf(calls, at))} in tools`,
          bold: true,
        }),
        table({
          columns: [{ header: 'Start', width: 8 }, { header: 'Tool', width: 12 }, { header: 'What' }, { header: 'Took', width: 8 }],
          rows: listed.slice(0, MAX_ROWS).map(span => [
            clockOf(span.start),
            { text: span.name, tone: toneOf(span) },
            span.target,
            span.end === undefined
              ? { text: 'running', tone: 'info' as const }
              : { text: lengthOf(span.end - span.start), tone: span.failed === true ? ('danger' as const) : ('neutral' as const) },
          ]),
          empty: 'No call in this period.',
        }),
        ...(listed.length > MAX_ROWS
          ? [tonedText({ text: `The latest ${MAX_ROWS} of ${listed.length} are listed.`, tone: 'neutral' })]
          : []),
      ],
    })
  })
}
