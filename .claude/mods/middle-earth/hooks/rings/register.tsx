import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { RingsIssue } from '../../types'
import { HOW_TO, listArgv, parseIssues, standingOf } from './rings'
import { parseRemote } from '../elrond/council'
import { askCouncil, planStanding } from '../elrond/register'
import { askErrand, questRelics } from '../fellowship/register'
import { errorText, git, run } from '../flow'
import { badge } from '../kit/badge'
import { paneView } from '../kit/pane-text'

type $ = EngineInterface
type On = Parameters<Register>[0]

const PANE = 'rings'
const TITLE = 'Rings'
// How long the forge is given to answer
const FORGE_TIMEOUT_MS = 60_000

const issues = atom({ plugin: 'middle-earth', key: 'ringsIssues' } as const, [] as RingsIssue[])
const repo = atom({ plugin: 'middle-earth', key: 'ringsRepo' } as const, '')
const note = atom({ plugin: 'middle-earth', key: 'ringsNote' } as const, '')
const working = atom({ plugin: 'middle-earth', key: 'ringsWorking' } as const, '')
const selected = atom({ plugin: 'middle-earth', key: 'ringsSelected' } as const, 0)

export const ringsView = paneView({ id: PANE, title: TITLE, command: '/rings' })
const view = ringsView

/** Reads the origin's open issues again, and says how it went: what the forge said in place of a list, when it said one. */
async function refresh($: $): Promise<string> {
  const origin = parseRemote((await git($, ['remote', 'get-url', 'origin'])).out)

  if (origin === undefined) return 'The origin remote could not be read: the Rings list the issues of the repository it names.'

  await update($, working, () => `Reading the open issues of ${origin.repo}…`)

  try {
    const got = await run($, listArgv(origin), FORGE_TIMEOUT_MS)

    if (!got.ok) return `${origin.forge === 'github' ? 'gh' : 'glab'} could not list the issues of ${origin.repo}: ${got.out.trim().split('\n').slice(-1)[0] ?? ''}`

    const listed = parseIssues(got.out, origin)

    if (typeof listed === 'string') return listed

    await update($, issues, () => listed)
    await update($, repo, () => origin.repo)
    // The issue the pane opened stays open while it is still listed
    await update($, selected, was => (listed.some(one => one.number === was) ? was : 0))

    return `${listed.length} open ${listed.length === 1 ? 'issue' : 'issues'} on ${origin.repo}.`
  } finally {
    await update($, working, () => '')
  }
}

/** Refreshes, keeping what went wrong for the pane to say. */
async function refreshed($: $): Promise<string> {
  const said = await refresh($).catch((error: unknown) => `The issues could not be read: ${errorText(error)}`)

  await update($, note, () => (/ open issues? on /.test(said) ? '' : said))

  return said
}

/** Where each listed issue stands with the Fellowship and Elrond, by its ref. */
async function standings($: $, listed: readonly RingsIssue[]): Promise<Map<string, string>> {
  const quests = await questRelics($).catch(() => [])
  const found = new Map<string, string>()

  for (const issue of listed) {
    // A review quest is a pull request's, never an issue's
    const quest = quests.find(one => one.ref === issue.ref && one.kind !== 'review' && one.phase !== 'sailed')

    found.set(issue.ref, standingOf(quest, quest === undefined ? await planStanding($, issue.ref).catch(() => '') : ''))
  }

  return found
}

/** The Rings at the session's start: their command. The issues are read once the pane is opened. */
export async function startRings($: $): Promise<void> {
  await $.command.register({ name: 'rings', description: 'Open the pane of the open issues: each one an errand for the Fellowship, or sent to the council to be planned' })
}

export function registerRings(on: On): void {
  on('command.run', { command: 'rings' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: await refreshed($) }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const listed = await read($, issues)
    const from = await read($, repo)
    const busy = await read($, working)
    const problem = await read($, note)
    const openNumber = await read($, selected)
    const open = listed.find(one => one.number === openNumber)
    const standing = await standings($, listed)
    const said = (text: string) => update($, note, () => text)

    const head = (
      <Box flexDirection="row" gap={2}>
        {badge({ label: from === '' ? 'not read' : `${listed.length} open · ${from}`, tone: 'neutral' })}
        <Button key="refresh" hotkey="r" onPress={() => refreshed($).then(() => undefined)}>
          Refresh
        </Button>
      </Box>
    )

    if (listed.length === 0) {
      return view.keep(
        <Box flexDirection="column" gap={1}>
          {head}
          {busy !== '' && <Text color="suggestion">{busy}</Text>}
          {problem !== '' && <Text color="warning">{problem}</Text>}
          <Text dimColor>{from === '' ? HOW_TO : `No open issue on ${from}.`}</Text>
        </Box>,
      )
    }

    const openStanding = open === undefined ? '' : (standing.get(open.ref) ?? '')
    // An issue a quest is on already is the Fellowship's: its pane goes on with it
    const isOnQuest = /^(plan|errand) · /.test(openStanding)
    const isPlanned = openStanding.startsWith('planned')

    return view.keep(
      <Box flexDirection="column" gap={1}>
        {head}
        {busy !== '' && <Text color="suggestion">{busy}</Text>}
        {problem !== '' && <Text color="warning">{problem}</Text>}
        <Box flexDirection="column">
          {listed.map(issue => (
            <Button key={`issue-${issue.number}`} plain onPress={() => update($, selected, was => (was === issue.number ? 0 : issue.number))}>
              {issue.number === openNumber ? '▸ ' : '  '}
              {`#${issue.number} ${issue.title}`}
              {issue.labels.length > 0 && <Text dimColor>{` [${issue.labels.join(', ')}]`}</Text>}
              {(standing.get(issue.ref) ?? '') !== '' && <Text color="suggestion">{` ${standing.get(issue.ref) ?? ''}`}</Text>}
            </Button>
          ))}
        </Box>
        {open !== undefined && (
          <Box flexDirection="column" borderStyle="round" paddingX={1}>
            <Text bold wrap="truncate-end">{`#${open.number} ${open.title}`}</Text>
            <Text dimColor>{[open.author !== '' ? `by ${open.author}` : '', open.updatedAt !== '' ? `updated ${open.updatedAt.slice(0, 10)}` : '', open.url].filter(part => part !== '').join(' · ')}</Text>
            {open.body !== '' && <Text>{open.body}</Text>}
            {isOnQuest ? (
              <Text color="suggestion">{`The Fellowship is on it (${openStanding}): /fellowship goes on with it.`}</Text>
            ) : (
              <Box flexDirection="row" gap={1}>
                <Button key="errand" hotkey="e" variant="primary" onPress={() => askErrand($, open.ref).then(() => said(`${open.ref} is sent as an errand: the Fellowship pane shows it set out.`))}>
                  Errand
                </Button>
                <Button key="council" hotkey="c" onPress={() => askCouncil($, open.ref).then(said)}>
                  {isPlanned ? 'Open its plan' : 'Send to the council'}
                </Button>
              </Box>
            )}
          </Box>
        )}
      </Box>,
    )
  })
}
