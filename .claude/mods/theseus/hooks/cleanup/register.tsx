import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Leftover } from '../../types'
import { HOW_TO, gathered, isIssueRef, leftoverLine, leftoversText } from './leftovers'
import { badge } from '../kit/badge'
import { paneView } from '../kit/pane-text'
import { keyed, shortRef } from '../look'
import { forgeOfHost } from '../../core/forge'
import { UNMODDED } from '../../core/change'
import { errorText, forgeIn, movedTo, offerTools, pullStateOf, removeTree, rootOf, toolFailed } from '../flow'
import { closeFollowUp, followUpLeftovers } from '../follow-up/register'
import { forgetPlan } from '../planner/register'
import { forgetRun, runLeftovers } from '../build/register'
import { forgetTestsFirst } from '../tests-first/register'
import { inBackground, stumbled } from '../trouble'

type $ = EngineInterface
type On = Parameters<Register>[0]

const PANE = 'cleanup'
const TITLE = 'Cleanup'
// How often the forge is asked whether what is kept is merged
const WATCH_MS = 10 * 60_000
// The first look waits for the session to have settled: it asks the forge
const FIRST_LOOK_MS = 30_000
const FORGE_TIMEOUT_MS = 60_000

const leftovers = atom({ plugin: 'theseus', key: 'cleanupLeftovers' } as const, [] as Leftover[])
const told = atom({ plugin: 'theseus', key: 'cleanupTold' } as const, [] as string[])
const note = atom({ plugin: 'theseus', key: 'cleanupNote' } as const, '')
const wanted = atom({ plugin: 'theseus', key: 'cleanupWanted' } as const, '')

// How often the clock looks for what a command asked of it
const TICK_MS = 500
const working = atom({ plugin: 'theseus', key: 'cleanupWorking' } as const, '')

export const cleanupView = paneView({ id: PANE, title: TITLE, command: '/theseus cleanup' })
const view = cleanupView

const TOOLS = [
  {
    name: 'leftovers',
    description: "The work kept that is cleaned up once merged: each branch the build or the review follow-up keeps, its worktree, its pull request, and whether the forge says it is merged. Cleaning up deletes branches and worktrees, so it is the person's: /theseus cleanup clean.",
    inputSchema: { type: 'object', properties: {} },
  },
] as const

/** Has a part forget what it keeps of a leftover, and says whether it did. */
async function forgets($: $, keeper: 'build' | 'follow-up' | 'planner' | 'tests-first', leftover: Pick<Leftover, 'ref' | 'pr'>): Promise<boolean> {
  const forgot =
    keeper === 'build' ? forgetRun($, leftover.ref, leftover.pr) : keeper === 'follow-up' ? closeFollowUp($, leftover.pr) : keeper === 'planner' ? forgetPlan($, leftover.ref, leftover.pr) : forgetTestsFirst($, leftover.ref)

  return (
    await forgot.catch((error: unknown) => {
      stumbled($, 'the cleanup')(error)

      return { forgotten: false }
    })
  ).forgotten
}

async function run($: $, argv: readonly string[]): Promise<{ ok: boolean; out: string }> {
  const ran = await $.process.run(argv, { cwd: await rootOf($), timeoutMs: FORGE_TIMEOUT_MS }).catch((error: unknown) => ({ exitCode: -1, stdout: '', stderr: errorText(error) }))

  return { ok: ran.exitCode === 0, out: (ran.exitCode === 0 ? ran.stdout : ran.stderr || ran.stdout).trim() }
}

function git($: $, args: readonly string[]) {
  return run($, ['git', ...args])
}

/** Looks at what the parts keep, and asks the forge whether each is merged; tells the person of each newly merged once. */
async function watch($: $): Promise<Leftover[]> {
  const answers = [
    { keeper: 'build' as const, kept: await runLeftovers($) },
    { keeper: 'follow-up' as const, kept: await followUpLeftovers($) },
  ]

  const origin = (await git($, ['remote', 'get-url', 'origin'])).out
  const forge = forgeOfHost(origin)
  const found = gathered(answers)

  for (const leftover of found) {
    // A pull request a mod did not open, the forge finds by its branch
    if (leftover.pr === '') {
      leftover.pr = await forgeIn($, forge).mergedFrom(leftover.branch)
    }

    if (leftover.pr === '') continue

    const state = await pullStateOf($, leftover.pr)

    // A forge that could not be asked is said so, never taken for "not merged"
    if (typeof state === 'string') {
      leftover.unknown = state
      continue
    }

    leftover.isMerged = state.isMerged && state.branch === leftover.branch
    leftover.head = state.head
    // A pull request still open that fell into conflict with its base waits on the person, though nothing says so
    leftover.isConflicting = !leftover.isMerged && state.isConflicting
  }

  await update($, leftovers, () => found)

  const already = await read($, told)
  // Each is told once while it stays in conflict; once it merges cleanly again, a later conflict is told anew
  const clashing = found.filter(leftover => leftover.isConflicting === true && !already.includes(`conflict:${leftover.pr}`))
  const eased = found.filter(leftover => leftover.isConflicting !== true && already.includes(`conflict:${leftover.pr}`)).map(leftover => `conflict:${leftover.pr}`)

  if (clashing.length > 0 || eased.length > 0) await update($, told, was => [...was.filter(one => !eased.includes(one)), ...clashing.map(leftover => `conflict:${leftover.pr}`)])
  if (clashing.length > 0) {
    $.ui.toast(`Cleanup: ${clashing.map(leftover => leftover.ref || leftover.branch).join(', ')} ${clashing.length === 1 ? 'is' : 'are'} in conflict with ${clashing.length === 1 ? 'its' : 'their'} base: merge it in, then push`)
  }

  const fresh = found.filter(leftover => leftover.isMerged && !already.includes(leftover.pr))

  if (fresh.length > 0) {
    await update($, told, was => [...was, ...fresh.map(leftover => leftover.pr)])
    $.ui.toast(`Cleanup: ${fresh.map(one => one.ref || one.branch).join(', ')} merged: /theseus cleanup clean removes what is kept of ${fresh.length === 1 ? 'it' : 'them'}`)
    await $.ui.notify(`${fresh.length === 1 ? 'A pull request is' : `${fresh.length} pull requests are`} merged: /theseus cleanup clean removes what is kept of ${fresh.length === 1 ? 'it' : 'them'}`, { title: 'Cleanup' }).catch(stumbled($, 'the cleanup'))
  }

  return found
}

/**
 * Cleans up a merged leftover: back on its base, brought up to date, its local branch deleted, and every part made to
 * forget it. Each forgets only once the forge says it is merged; a remote branch is the forge's to remove.
 */
async function cleanUp($: $, leftover: Leftover): Promise<string> {
  const state = await pullStateOf($, leftover.pr)

  if (typeof state === 'string') return `${leftover.ref || leftover.branch}: the forge could not say whether it is merged (${state}), and nothing is cleaned up.`
  if (!state.isMerged || state.branch !== leftover.branch) return `${leftover.ref || leftover.branch}: ${leftover.pr || 'no pull request'} is not merged from ${leftover.branch}, and nothing is cleaned up.`

  const said: string[] = []
  const root = await rootOf($)

  // A worktree an earlier cleanup removed already is gone: what git still says of it is pruned
  // A tree that cannot be looked at is taken as there, and kept
  const isTreeGone = leftover.tree !== '' && leftover.tree !== root && !(await $.fs.exists(leftover.tree).catch(() => true))

  if (isTreeGone) await git($, ['worktree', 'prune'])

  // The worktree the build ran in goes first: its branch can be deleted only once no worktree holds it
  if (leftover.tree !== '' && leftover.tree !== root && !isTreeGone) {
    // What the mods keep there (the recorder's builds, the verify trees) is none of the run's work
    if ((await run($, ['git', '-C', leftover.tree, 'status', '--porcelain', ...UNMODDED])).out !== '') return `${leftover.tree} holds uncommitted changes: commit, stash or drop them there, and clean up again.`

    const removed = await removeTree($, root, leftover.tree)

    said.push(removed.ok ? 'its worktree removed' : `its worktree could not be removed: ${removed.out}`)
  }

  const current = (await git($, ['rev-parse', '--abbrev-ref', 'HEAD'])).out

  if (current === leftover.branch) {
    if ((await git($, ['status', '--porcelain'])).out !== '') return `${leftover.branch} is checked out with uncommitted changes: commit, stash or drop them, and clean up again.`

    const back = await git($, ['switch', leftover.base])

    if (!back.ok) return `Could not go back to ${leftover.base}: ${back.out}`
    said.push(`back on ${leftover.base}`)
  }

  if ((await git($, ['rev-parse', '--abbrev-ref', 'HEAD'])).out === leftover.base) {
    const pulled = await git($, ['pull', '--ff-only', 'origin', leftover.base])

    if (pulled.ok) said.push(`${leftover.base} brought up to date`)
  }

  const tip = await git($, ['rev-parse', '--verify', '--quiet', `refs/heads/${leftover.branch}`])

  if (tip.ok) {
    // A squash or a rebase merge leaves the branch unmerged in git's eyes, so it is deleted by force: only once its tip
    // is the commit the forge merged, or one before it. Work committed past it is the person's, and the branch is kept
    const isLanded = state.head !== '' && (tip.out === state.head || (await git($, ['merge-base', '--is-ancestor', tip.out, state.head])).ok)
    const deleted = isLanded ? await git($, ['branch', '-D', leftover.branch]) : undefined

    said.push(
      deleted === undefined
        ? `${leftover.branch} kept: it holds ${state.head === '' ? 'commits the forge named no merged commit for' : `commits past ${state.head.slice(0, 7)}, the one merged`}, so delete it yourself once you are sure`
        : deleted.ok
          ? `${leftover.branch} deleted`
          : `${leftover.branch} could not be deleted: ${deleted.out}`,
    )
  }

  const forgotten: string[] = []

  for (const keeper of leftover.keepers) {
    // Every run on the branch is forgotten: an errand and the review of its pull request alike
    const refs = keeper === 'build' ? (leftover.quests ?? [leftover.ref]) : [leftover.ref]
    const forgot = await Promise.all(refs.map(ref => forgets($, keeper, { ...leftover, ref })))

    if (forgot.some(one => one)) forgotten.push(keeper)
  }

  // The plan of the issue, and its tests written first: of this issue alone
  if (isIssueRef(leftover.ref) && (await forgets($, 'planner', leftover))) forgotten.push('planner')
  if (leftover.keepers.includes('build') && (await forgets($, 'tests-first', leftover))) forgotten.push('tests-first')

  return `${leftover.ref || leftover.branch} is cleaned up: ${[...said, forgotten.length > 0 ? `forgotten by ${forgotten.join(', ')}` : ''].filter(one => one !== '').join(', ')}.`
}

/** Cleans up every merged leftover, or the one named by its branch, ref or pull request. */
async function clean($: $, named: string): Promise<string> {
  await update($, working, () => 'Asking the forge what is merged…')

  try {
    const found = await watch($)
    const chosen = found.filter(leftover => leftover.isMerged && (named === '' || [leftover.branch, leftover.ref, leftover.pr].includes(named)))

    if (chosen.length === 0) return named === '' ? `Nothing kept is merged yet.${found.length > 0 ? `\n${found.map(leftoverLine).join('\n')}` : ''}` : `Nothing merged is kept under ${named}.`

    const said: string[] = []

    await git($, ['fetch', '--prune', 'origin'])

    for (const leftover of chosen) {
      await update($, working, () => `Cleaning up ${leftover.ref || leftover.branch}…`)
      said.push(await cleanUp($, leftover))
    }

    await watch($)

    return said.join('\n')
  } finally {
    await update($, working, () => '')
  }
}

let isBusy = false

/** Looks or cleans up as /theseus cleanup asked, outside its hooks: what came of it is told as well as kept in the pane. */
async function tick($: $): Promise<void> {
  const asked = await read($, wanted)

  if (isBusy || asked === '') return

  isBusy = true
  await update($, wanted, () => '')

  try {
    const said = asked === 'look' ? leftoversText(await watch($)) : await clean($, asked.replace(/^clean\s*/, ''))

    $.ui.toast(`Cleanup: ${said.split('\n')[0] ?? ''}`)
    await update($, note, () => said)
  } catch (error) {
    await update($, note, () => `The cleanup stumbled: ${errorText(error)}`)
  } finally {
    isBusy = false
  }
}

/** The cleanup at the session's start: its command, its tool, and the clock that watches the forge and does what a command asked. */
export async function startCleanup($: $): Promise<void> {
  await $.command.register({ name: 'cleanup', description: 'Now /theseus cleanup (this name goes in the next release)' })

  await offerTools($, TOOLS)

  $.clock.after(FIRST_LOOK_MS, inBackground($, 'the cleanup', () => watch($)))
  $.clock.every(WATCH_MS, inBackground($, 'the cleanup', () => watch($)))
  $.clock.every(TICK_MS, inBackground($, 'the cleanup', () => tick($)))
}

/** `/theseus cleanup`: Says what is kept of merged pull requests, and cleans it up. */
export async function cleanupCommand($: $, args: string): Promise<{ text: string }> {
  const words = args.trim().split(/\s+/).filter(word => word !== '')

  await $.ui.open({ id: PANE, title: TITLE })

  if (words.length > 0 && words[0] !== 'clean') return { text: `/theseus cleanup knows clean; not ${words[0] ?? ''}.` }

  // Looking and cleaning up ask the forge, and take a while: the command answers at once, and the clock does both
  await update($, wanted, () => (words[0] === 'clean' ? `clean ${words.slice(1).join(' ')}`.trim() : 'look'))

  return { text: words[0] === 'clean' ? 'The cleanup removes what is merged: the pane says what it cleaned up.' : `${leftoversText(await read($, leftovers))}\n\nLooking again: the pane says what the forge answers.` }
}

export function registerCleanup(on: On): void {
  on('tool.call', { tool: 'mcp__theseus__leftovers' }, async $ => ({ result: leftoversText(await watch($)) })).catch((_$, _e, next) => toolFailed('leftovers', next.error))

  // Cleaning up deletes branches and has every part forget: no tool offers it to Claude, and the person cleans up
  // The command it had before /theseus, kept for one release: it says its new spelling
  on('command.run', { command: 'cleanup' }, async ($, e) => movedTo('/cleanup', '/theseus cleanup', await cleanupCommand($, e.args)))


  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const held = await read($, leftovers)
    const problem = await read($, note)
    const busy = await read($, working)
    const merged = held.filter(leftover => leftover.isMerged)

    return view.keep(
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          {badge({ label: merged.length > 0 ? `${merged.length} merged` : held.length > 0 ? `watching ${held.length}` : 'nothing kept', tone: merged.length > 0 ? 'danger' : 'neutral' })}
          <Button key="look" hotkey="l" onPress={() => watch($).then(() => undefined)}>
            {keyed('l', 'Look again')}
          </Button>
        </Box>
        {busy !== '' && <Text color="suggestion">{busy}</Text>}
        {problem !== '' && <Text>{problem}</Text>}
        {held.length === 0 && <Text dimColor>{HOW_TO}</Text>}
        {held.length > 0 && (
          <Box flexDirection="column" gap={1}>
            {/* The merged first: they are what waits to be cleaned up */}
            {[...merged, ...held.filter(leftover => !leftover.isMerged)].map(leftover => {
              // Where the forge could not say, it is said unknown: the line under it says why
              const standing = [leftover.isMerged ? 'merged' : leftover.unknown !== undefined ? 'unknown' : 'open', ...(leftover.isConflicting === true ? ['in conflict with its base'] : [])].join(' · ')

              return (
                <Box key={leftover.branch} flexDirection="row">
                  <Box width={3} flexShrink={0}>
                    <Text>{leftover.isMerged ? '●' : '·'}</Text>
                  </Box>
                  <Box flexDirection="column" flexGrow={1} flexShrink={1}>
                    <Text>
                      <Text bold={leftover.isMerged}>{leftover.ref !== '' ? shortRef(leftover.ref) : leftover.branch}</Text>
                      <Text color={leftover.isMerged ? 'error' : leftover.isConflicting === true ? 'warning' : undefined} dimColor={!leftover.isMerged && leftover.isConflicting !== true}>{`  ${standing}`}</Text>
                    </Text>
                    <Text dimColor>{`${leftover.branch} · kept by ${leftover.keepers.join(', ')}`}</Text>
                    <Text dimColor wrap="truncate-middle">{leftover.pr !== '' ? leftover.pr : 'no pull request known'}</Text>
                    {leftover.unknown !== undefined && <Text color="warning">{`The forge could not say whether it is merged: ${leftover.unknown}`}</Text>}
                  </Box>
                </Box>
              )
            })}
          </Box>
        )}
        {merged.length > 0 && (
          <Button key="clean" hotkey="c" variant="primary" onPress={() => clean($, '').then(said => update($, note, () => said))}>
            {keyed('c', 'Clean them up')}
          </Button>
        )}
      </Box>,
      e.props.bodyColumns,
    )
  })
}
