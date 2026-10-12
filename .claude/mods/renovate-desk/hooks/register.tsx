import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { LogEntry, Phase, Pr } from '../types'
import { actionLabel } from './kit/action-label'
import { badge } from './kit/badge'
import { card } from './kit/card'
import { divider } from './kit/divider'
import { logLines } from './kit/log-lines'
import { paneView } from './kit/pane-text'
import { table } from './kit/table'
import type { TableCell } from './kit/table'
import { mergeArgv, parse, searchArgv, shortTitle } from './renovate'

const PANE = 'renovate-desk'
const TITLE = 'Renovate'
const DEFAULT_QUERY = 'author:app/renovate user:@me'

const prs = atom({ plugin: 'renovate-desk', key: 'prs' } as const, [] as Pr[])
const total = atom({ plugin: 'renovate-desk', key: 'total' } as const, 0)
const phase = atom({ plugin: 'renovate-desk', key: 'phase' } as const, 'idle' as Phase)
const checkedAt = atom({ plugin: 'renovate-desk', key: 'checkedAt' } as const, '')
const error = atom({ plugin: 'renovate-desk', key: 'error' } as const, '')
const log = atom({ plugin: 'renovate-desk', key: 'log' } as const, [] as LogEntry[])

// What the pane last drew, for the model to read: it sees nothing of a pane otherwise
const view = paneView({ id: PANE, title: TITLE, command: '/renovate' })

const TONE = { safe: 'success', waiting: 'warning', look: 'danger' } as const

const firstLine = (text: string) => (text.trim().split('\n')[0] ?? '').slice(0, 160)

const clockTime = async ($: EngineInterface) => new Date(await $.clock.now()).toTimeString().slice(0, 5)

// GitHub is asked once, and only when the person asks: on the command and on Refresh, never on a timer
const refresh = async ($: EngineInterface, query: string) => {
  if ((await read($, phase)) !== 'idle') return

  await update($, phase, () => 'loading')

  try {
    const { exitCode, stdout, stderr } = await $.process.run(searchArgv(query), { timeoutMs: 30_000 })

    if (exitCode !== 0) throw new Error(firstLine(stderr) || `gh exited with ${exitCode}`)

    const found = parse(stdout)

    await update($, prs, () => found.prs)
    await update($, total, () => found.total)
    await update($, error, () => '')
  } catch (failure) {
    await update($, error, () => firstLine(failure instanceof Error ? failure.message : String(failure)))
  }

  const at = await clockTime($)

  await update($, checkedAt, () => at)
  await update($, phase, () => 'idle')
}

// One merge at a time and nothing else: no comment, no approval, no rebase request, so nobody is notified twice
const merge = async ($: EngineInterface, pick: (pr: Pr) => boolean) => {
  if ((await read($, phase)) !== 'idle') return

  const targets = (await read($, prs)).filter(pr => pr.canMerge && pick(pr))

  if (targets.length === 0) return

  await update($, phase, () => 'merging')

  let merged = 0

  for (const pr of targets) {
    const ran = await $.process
      .run(mergeArgv(pr), { timeoutMs: 60_000 })
      .catch((failure: unknown) => ({ exitCode: 1, stderr: String(failure) }))
    const at = await clockTime($)

    if (ran.exitCode === 0) {
      merged += 1
      await update($, prs, list => list.filter(other => other.id !== pr.id))
      await update($, total, n => Math.max(0, n - 1))
      await update($, log, entries => [...entries, { at, level: 'info', message: `merged ${pr.id} ${shortTitle(pr.title)}` }])
    } else {
      const why = firstLine(ran.stderr) || 'gh refused the merge'

      // Left for the person, and not tried again by the one button
      await update($, prs, list =>
        list.map(other => (other.id === pr.id ? { ...other, bucket: 'look', reason: 'merge refused', canMerge: false } : other)),
      )
      await update($, log, entries => [...entries, { at, level: 'error', message: `${pr.id} not merged: ${why}` }])
    }
  }

  await update($, phase, () => 'idle')
  $.ui.toast(`Renovate: merged ${merged} of ${targets.length}`)
}

export const register: Register = (on, options) => {
  const query = typeof options?.query === 'string' && options.query.trim() !== '' ? options.query.trim() : DEFAULT_QUERY

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'renovate', description: 'Open the Renovate pull requests and merge the safe ones' })
    // A host that registers no tools still starts the session
    await $.tool.register(view.tool).catch(() => undefined)

    return next(e)
  })

  // The pane as text, for the model
  on('tool.call', { tool: 'mcp__renovate-desk__pane' }, $ => view.answer(() => $.ui.panes()))

  on('command.run', { command: 'renovate' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE, focus: true })
    await refresh($, query)

    const list = await read($, prs)
    const failure = await read($, error)

    if (failure !== '') return { text: `Renovate: could not ask GitHub: ${failure}` }

    const count = (bucket: Pr['bucket']) => list.filter(pr => pr.bucket === bucket).length

    return { text: `Renovate: ${count('safe')} safe to merge, ${count('waiting')} waiting, ${count('look')} to look at.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button } = $.ui.resolve(e)
    const width = e.props.bodyColumns ?? 80
    const list = await read($, prs)
    const found = await read($, total)
    const now = await read($, phase)
    const at = await read($, checkedAt)
    const failure = await read($, error)
    const entries = await read($, log)

    const safe = list.filter(pr => pr.bucket === 'safe')
    const waiting = list.filter(pr => pr.bucket === 'waiting')
    const look = list.filter(pr => pr.bucket === 'look')
    const isIdle = now === 'idle'
    const isWide = width >= 100

    const status =
      now === 'loading'
        ? badge({ label: 'asking GitHub', tone: 'info' })
        : now === 'merging'
          ? badge({ label: 'merging', tone: 'accent' })
          : failure !== ''
            ? badge({ label: failure, tone: 'danger' })
            : at === ''
              ? badge({ label: 'not checked yet', tone: 'neutral' })
              : badge({
                  label: `${safe.length} safe · ${waiting.length} waiting · ${look.length} to look at`,
                  tone: safe.length > 0 ? 'success' : look.length > 0 ? 'warning' : 'neutral',
                })

    const rows = list.map((pr): TableCell[] => [
      isWide ? pr.id : pr.id.slice(pr.id.indexOf('/') + 1),
      shortTitle(pr.title),
      { text: pr.bucket === 'safe' ? `safe · ${pr.kind}` : pr.reason, tone: TONE[pr.bucket] },
      pr.bucket === 'look' && pr.canMerge && isIdle ? (
        <Button key={`merge-${pr.id}`} plain onPress={() => merge($, other => other.id === pr.id)}>
          {actionLabel({ text: 'merge' })}
        </Button>
      ) : (
        ''
      ),
    ])

    return view.keep(
      card({
        width,
        title: TITLE,
        meta: at === '' ? undefined : `checked ${at}`,
        children: [
          status,
          <Box key="actions" flexDirection="row" gap={2}>
            {[
              ...(safe.length > 0 && isIdle
                ? [
                    <Button key="merge-safe" hotkey="m" onPress={() => merge($, pr => pr.bucket === 'safe')}>
                      {actionLabel({ text: `Merge ${safe.length} safe`, primary: true })}
                    </Button>,
                  ]
                : []),
              ...(isIdle
                ? [
                    <Button key="refresh" hotkey="r" onPress={() => refresh($, query)}>
                      {actionLabel({ text: 'Refresh' })}
                    </Button>,
                  ]
                : []),
            ]}
          </Box>,
          divider(),
          table({
            columns: [
              { header: 'Pull request', width: isWide ? 30 : 18 },
              { header: 'Update' },
              { header: 'State', width: isWide ? 30 : 20 },
              { header: '', width: 7 },
            ],
            rows,
            empty: at === '' ? 'Press Refresh to ask GitHub.' : 'No open Renovate pull request.',
          }),
          ...(found > list.length ? [badge({ label: `${found - list.length} more not shown`, tone: 'neutral' })] : []),
          ...(entries.length > 0 ? [divider(), logLines({ entries: entries.slice(-8) })] : []),
        ],
      }),
    )
  })
}
