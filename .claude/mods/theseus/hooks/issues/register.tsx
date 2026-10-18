import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ListedIssue } from '../../types'
import { HOW_TO, listedOf, standingOf } from './listed'
import { parseRemote } from '../../core/forge'
import { askPlanner, planStanding } from '../planner/register'
import { askErrand, runLeftovers } from '../build/register'
import { errorText, forgeIn, git } from '../flow'
import { badge } from '../kit/badge'
import { paneView } from '../kit/pane-text'
import { clip, keyed } from '../look'

type $ = EngineInterface
type On = Parameters<Register>[0]

const PANE = 'issues'
const TITLE = 'Issues'

const issues = atom({ plugin: 'theseus', key: 'issuesIssues' } as const, [] as ListedIssue[])
const repo = atom({ plugin: 'theseus', key: 'issuesRepo' } as const, '')
const note = atom({ plugin: 'theseus', key: 'issuesNote' } as const, '')
const working = atom({ plugin: 'theseus', key: 'issuesWorking' } as const, '')
const selected = atom({ plugin: 'theseus', key: 'issuesSelected' } as const, 0)

export const issuesView = paneView({ id: PANE, title: TITLE, command: '/theseus issues' })
const view = issuesView

/** Reads the origin's open issues again, and says how it went: what the forge said in place of a list, when it said one. */
async function refresh($: $): Promise<string> {
  const origin = parseRemote((await git($, ['remote', 'get-url', 'origin'])).out)

  if (origin === undefined) return 'The origin remote could not be read: the issues pane lists the issues of the repository it names.'

  await update($, working, () => `Reading the open issues of ${origin.repo}…`)

  try {
    const got = await forgeIn($, origin.forge).listIssues(origin)

    if (typeof got === 'string') return got

    const listed = listedOf(got, origin)

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

/** Where each listed issue stands with the build and the planner, by its ref. */
async function standings($: $, listed: readonly ListedIssue[]): Promise<Map<string, string>> {
  const quests = await runLeftovers($)
  const found = new Map<string, string>()

  for (const issue of listed) {
    // A review run is a pull request's, never an issue's
    const quest = quests.find(one => one.ref === issue.ref && one.kind !== 'review' && one.phase !== 'submitted')

    found.set(issue.ref, standingOf(quest, quest === undefined ? await planStanding($, issue.ref) : ''))
  }

  return found
}

/** The issues pane at the session's start: its command. The issues are read once the pane is opened. */
export async function startIssues($: $): Promise<void> {
}

/** `/theseus issues`: Opens the open issues. */
export async function issuesCommand($: $, _args: string): Promise<{ text: string }> {
  await $.ui.open({ id: PANE, title: TITLE })

  return { text: await refreshed($) }
}

export function registerIssues(on: On): void {


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
    const width = e.props.bodyColumns ?? 80
    // The widest number keeps the titles in a column
    const numberWidth = Math.max(0, ...listed.map(issue => String(issue.number).length)) + 1

    const head = (
      <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
        {badge({ label: from === '' ? 'not read' : `${listed.length} open · ${from}`, tone: 'neutral' })}
        <Button key="refresh" hotkey="r" onPress={() => refreshed($).then(() => undefined)}>
          {keyed('r', 'Refresh')}
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
        width,
      )
    }

    const openStanding = open === undefined ? '' : (standing.get(open.ref) ?? '')
    // An issue a run is on already is the build's: its pane goes on with it
    const isOnRun = /^(plan|errand) · /.test(openStanding)
    const isPlanned = openStanding.startsWith('planned')

    return view.keep(
      <Box flexDirection="column" gap={1}>
        {head}
        {busy !== '' && <Text color="suggestion">{busy}</Text>}
        {problem !== '' && <Text color="warning">{problem}</Text>}
        <Box flexDirection="column">
          {listed.map(issue => {
            const stands = standing.get(issue.ref) ?? ''
            // One line an issue: its title is cut to leave room for where it stands, which is never cut; opened, it is whole
            const room = width - 2 - numberWidth - 1 - (stands === '' ? 0 : stands.length + 1)
            // Its labels, where the whole title leaves room for them
            const labels = issue.labels.length > 0 ? ` [${issue.labels.join(', ')}]` : ''

            return (
              <Button key={`issue-${issue.number}`} plain onPress={() => update($, selected, was => (was === issue.number ? 0 : issue.number))}>
                {issue.number === openNumber ? '▸ ' : '  '}
                <Text bold={issue.number === openNumber}>{`#${issue.number}`.padEnd(numberWidth + 1)}</Text>
                <Text bold={issue.number === openNumber}>{clip(issue.title, room)}</Text>
                {labels !== '' && issue.title.length + labels.length <= room && <Text dimColor>{labels}</Text>}
                {stands !== '' && <Text color="suggestion">{` ${stands}`}</Text>}
              </Button>
            )
          })}
        </Box>
        {open !== undefined && (
          <Box flexDirection="column" borderStyle="round" paddingX={1}>
            <Text bold>{`#${open.number} ${open.title}`}</Text>
            <Text dimColor>{[open.author !== '' ? `by ${open.author}` : '', open.updatedAt !== '' ? `updated ${open.updatedAt.slice(0, 10)}` : ''].filter(part => part !== '').join(' · ')}</Text>
            {open.labels.length > 0 && <Text color="suggestion">{open.labels.map(label => `[${label}]`).join(' ')}</Text>}
            {open.body !== '' && (
              // As the pane reads it, up to its first 600 characters: the rest is the forge's to show
              <Box flexDirection="column" marginTop={1}>
                <Text>{open.body.trimEnd()}</Text>
              </Box>
            )}
            {open.url !== '' && <Text dimColor wrap="truncate-middle">{open.url}</Text>}
            <Box marginTop={1}>
              {isOnRun ? (
                <Text color="suggestion">{`The build is on it (${openStanding}): /theseus build goes on with it.`}</Text>
              ) : (
                <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
                  <Button key="errand" hotkey="e" variant="primary" onPress={() => askErrand($, open.ref).then(() => said(`${open.ref} is sent as an errand: the build pane shows it started.`))}>
                    {keyed('e', 'Errand')}
                  </Button>
                  <Button key="planner" hotkey="c" onPress={() => askPlanner($, open.ref).then(said)}>
                    {keyed('c', isPlanned ? 'Open its plan' : 'Send to the planner')}
                  </Button>
                </Box>
              )}
            </Box>
          </Box>
        )}
      </Box>,
      width,
    )
  })
}
