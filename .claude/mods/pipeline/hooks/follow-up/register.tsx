import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { FollowUpComment, FollowUp, FollowUpPhase } from '../../types'
import { HOW_TO, WEIGHER_MODEL, commentShown, followUpText, handedOf, parseWeights, reviewRef, weighPrompt, checkComments } from './follow-up'
import { parsePullRef, parseRemote } from '../../core/forge'
import { errorText, forgeIn, git, isMergedFrom, offerTools, openPane, toolFailed } from '../flow'
import { badge } from '../kit/badge'
import type { Tone } from '../kit/badge'
import { paneView } from '../kit/pane-text'
import { keyed, shortRef } from '../look'
import { takeReview } from '../build/register'
import { inBackground } from '../trouble'

type $ = EngineInterface
type On = Parameters<Register>[0]

const PANE = 'follow-up'
const TITLE = 'Review follow-up'
const TICK_MS = 500
// How many lines of a comment the pane says: the rest is on the forge
const COMMENT_LINES = 3

const followUp = atom({ plugin: 'pipeline', key: 'followUpReview' } as const, null as FollowUp | null)
const note = atom({ plugin: 'pipeline', key: 'followUpNote' } as const, '')
const wanted = atom({ plugin: 'pipeline', key: 'followUpWanted' } as const, null as { what: 'open' | 'hand' | 'hand auto'; arg?: string } | null)
const working = atom({ plugin: 'pipeline', key: 'followUpWorking' } as const, '')

export const followUpView = paneView({ id: PANE, title: TITLE, command: '/follow-up' })
const view = followUpView

const TOOLS = [
  {
    name: 'open_review',
    description:
      "Opens a review follow-up on a pull request (a merge request on GitLab): reads its open review comments, has each weighed (light, standard, heavy) and told apart from questions only the person can answer. Changes nothing. Call it when the person asks to take care of a pull request's review comments.",
    inputSchema: { type: 'object', properties: { pr: { type: 'string', description: 'The pull request: its number, its URL, or empty for the branch checked out.' } } },
  },
  {
    name: 'answer_review',
    description:
      "Hands the open follow-up's comments that ask for a change to the build, which answers them one at a time on the pull request's branch, in a worktree of its own: each answer proven by verify, judged by its reviewers, and committed. Questions are left to the person, and nothing is pushed until the person says so.",
    inputSchema: { type: 'object', properties: { auto: { type: 'boolean', description: 'Go on by itself from one comment to the next. Only when the person asked for it.' } } },
  },
  {
    name: 'review_comments',
    description: 'Where the review follow-up stands: the pull request, and each comment with its weight, the questions the person is to answer apart.',
    inputSchema: { type: 'object', properties: {} },
  },
] as const

const PHASE_TONE: Record<FollowUpPhase, Tone> = { weighing: 'info', ready: 'neutral', handed: 'success' }

async function keep($: $, change: (was: FollowUp) => FollowUp): Promise<void> {
  await update($, followUp, was => (was === null ? was : change(was)))
}

/** Opens a follow-up: reads the pull request and its open comments, and has them weighed. Nothing is checked out. */
async function open($: $, input: string): Promise<string> {
  const held = await read($, followUp)

  if (held?.phase === 'weighing') return `The follow-up weighs the comments of ${held.pr.repo}#${held.pr.number}: wait for it to settle.`

  const origin = parseRemote((await git($, ['remote', 'get-url', 'origin'])).out)
  let named = parsePullRef(input, origin)

  if (named === 'current') {
    if (origin === undefined) return 'The origin remote could not be read: name the pull request by its URL.'

    const number = await forgeIn($, origin.forge).currentRequest()

    if (typeof number === 'string') return number

    named = { forge: origin.forge, repo: origin.repo, number }
  }

  if (typeof named === 'string') return named

  await update($, working, () => `Reading the review comments of ${named.repo}#${named.number}…`)

  const parsed = await forgeIn($, named.forge).readReview(named.repo, named.number)

  if (typeof parsed === 'string') return parsed

  // The pull request's failing checks ask for a change alongside its comments
  const checks = await forgeIn($, named.forge).failingChecks(named.repo, named.number).catch((error: unknown) => errorText(error))

  await update($, followUp, (): FollowUp => ({ pr: parsed.pr, comments: [], phase: 'weighing', at: Date.now() }))
  await update($, working, () => `The weigher weighs ${parsed.comments.length} ${parsed.comments.length === 1 ? 'comment' : 'comments'}…`)

  const weighing = parsed.comments.length === 0 ? new Map() : await $.model.complete({ model: WEIGHER_MODEL, prompt: weighPrompt(parsed.comments) }).then(said => (said.isAnswered ? parseWeights(said.text) : 'it gave no answer')).catch((error: unknown) => errorText(error))
  const weighed = typeof weighing === 'string' ? new Map<string, { weight: 'standard'; kind: 'question' }>() : weighing
  // A comment the weigher did not weigh is the person's to read, never built on a guess; one from outside the
  // repository is the person's to weigh, whatever it asks
  const all = parsed.comments.map(one => {
    const got = weighed.get(one.id) ?? { weight: 'standard' as const, isUnweighed: true, kind: 'question' as const }

    return { ...one, ...got, kind: one.isOutside === true && got.kind === 'change' ? ('question' as const) : got.kind }
  })
  const unweighed = parsed.comments.filter(one => !weighed.has(one.id)).length
  const outside = all.filter(one => one.isOutside === true && one.kind !== 'settled').length
  const said = [
    ...parsed.unread,
    ...(typeof checks === 'string' ? [`the checks could not be read (${checks})`] : []),
    ...(typeof weighing === 'string' ? [`the comments could not be weighed (${weighing}): each is a question for you`] : unweighed > 0 ? [`${unweighed} ${unweighed === 1 ? 'comment was' : 'comments were'} not weighed, and ${unweighed === 1 ? 'is a question' : 'are questions'} for you`] : []),
    ...(outside > 0 ? [`${outside} ${outside === 1 ? 'comment is' : 'comments are'} from outside the repository, and ${outside === 1 ? 'is a question' : 'are questions'} for you, never built`] : []),
  ]
  // What asks nothing more (a question answered against the change, a review's summary, a comment taken back) is left out
  const comments: FollowUpComment[] = [...all.flatMap(one => (one.kind === 'settled' ? [] : [{ ...one, kind: one.kind }])), ...checkComments(typeof checks === 'string' ? [] : checks)]
  const settled = all.length - comments.length

  await keep($, was => ({ ...was, comments, phase: 'ready' }))
  await update($, note, () => (said.length === 0 ? '' : `${said.join('; ')}.`))
  await openPane($, PANE, TITLE)

  const changes = comments.filter(one => one.kind === 'change').length
  const questions = comments.length - changes
  const failing = typeof checks === 'string' ? 0 : checks.length

  return `The review follow-up opens on ${parsed.pr.repo}#${parsed.pr.number}, "${parsed.pr.title}", on ${parsed.pr.branch}: ${comments.length === 0 ? 'no open review comment.' : `${changes} ${changes === 1 ? 'comment asks' : 'comments ask'} for a change, ${questions} ${questions === 1 ? 'is a question' : 'are questions'} for the person${settled > 0 ? `, ${settled} ${settled === 1 ? 'is' : 'are'} settled` : ''}${failing > 0 ? ` (${failing} of the changes ${failing === 1 ? 'is a failing check' : 'are failing checks'})` : ''}. /follow-up answer hands them to the build.`}${said.length > 0 ? ` Mind: ${said.join('; ')}.` : ''}`
}

/** Hands the comments that ask for a change to the build, which builds them on the pull request's branch. */
async function hand($: $, isAuto: boolean): Promise<string> {
  const held = await read($, followUp)

  if (held === null) return HOW_TO
  if (held.phase === 'weighing') return 'The comments are still being weighed.'
  if (held.pr.isFork === true) return `${held.pr.repo}#${held.pr.number} comes from a fork: its branch cannot be pushed to from this repository, so the build does not take it up. Answer its comments on the fork.`
  if (!held.comments.some(one => one.kind === 'change')) return `No comment of ${held.pr.repo}#${held.pr.number} asks for a change: the questions are yours to answer.`

  await update($, working, () => `Handing ${held.pr.repo}#${held.pr.number}'s comments to the build…`)

  const got = await takeReview($, handedOf(held), isAuto).catch((error: unknown) => errorText(error))

  if (!/starts|takes up/.test(got)) return `The build did not take the comments up: ${got.slice(0, 300)}`

  await keep($, was => ({ ...was, phase: 'handed' }))

  return `${got} The questions are yours to answer on ${held.pr.url}.`
}

/** The pull request the follow-up is open on, for the cleanup, which watches for it to be merged. */
export async function followUpLeftovers($: $): Promise<{ ref: string; branch: string; base: string; pr: string; phase: string }[]> {
  const held = await read($, followUp)

  return held === null ? [] : [{ ref: `${held.pr.repo}#${held.pr.number}`, branch: held.pr.branch, base: held.pr.base, pr: held.pr.url, phase: held.phase }]
}

/** Closes the follow-up once its pull request is merged, which the forge is asked; one not merged is kept. For the cleanup. */
export async function closeFollowUp($: $, pr: string): Promise<{ forgotten: boolean; text: string }> {
  const held = await read($, followUp)

  if (held === null || held.pr.url !== pr) return { forgotten: false, text: 'No review follow-up is open on that pull request.' }
  if (!(await isMergedFrom($, held.pr.url, held.pr.branch))) return { forgotten: false, text: `${held.pr.url} is not merged: the follow-up stays open.` }

  await update($, followUp, () => null)

  return { forgotten: true, text: `The follow-up on ${held.pr.repo}#${held.pr.number} is closed.` }
}

let isBusy = false

/** Opens or hands over as a command asked, outside its hooks: what came of it is told, and kept in the pane. */
async function tick($: $): Promise<void> {
  const asked = await read($, wanted)

  if (isBusy || asked === null) return

  isBusy = true
  await update($, wanted, () => null)

  try {
    const said = asked.what === 'open' ? await open($, asked.arg ?? '') : await hand($, asked.what === 'hand auto')

    $.ui.toast(`Follow-up: ${said.split('\n')[0] ?? said}`)
    await update($, note, () => said)
  } catch (error) {
    await update($, note, () => `The follow-up stumbled: ${errorText(error)}`)
  } finally {
    isBusy = false
    await update($, working, () => '')
  }
}

async function alone<T>($: $, act: () => Promise<T>): Promise<T> {
  isBusy = true

  try {
    return await act()
  } finally {
    isBusy = false
    await update($, working, () => '')
  }
}

/** The review follow-up at the session's start: its command, its tools, and the clock that does what a command asked. */
export async function startFollowUp($: $): Promise<void> {
  await $.command.register({ name: 'follow-up', description: "Answer a pull request's review comments: /follow-up <pr> opens them; answer (--auto) hands them to the build; close" })

  await offerTools($, TOOLS)

  $.clock.every(TICK_MS, inBackground($, 'the review follow-up', () => tick($)))
}

export function registerFollowUp(on: On): void {
  on('tool.call', { tool: 'mcp__pipeline__open_review' }, async ($, e) => ({ result: await alone($, () => open($, String((e as unknown as { pr?: unknown }).pr ?? ''))) })).catch((_$, _e, next) => toolFailed('open_review', next.error))

  on('tool.call', { tool: 'mcp__pipeline__answer_review' }, async ($, e) => ({ result: await alone($, () => hand($, (e as unknown as { auto?: unknown }).auto === true)) })).catch((_$, _e, next) => toolFailed('answer_review', next.error))

  on('tool.call', { tool: 'mcp__pipeline__review_comments' }, async $ => {
    const held = await read($, followUp)

    return { result: held === null ? HOW_TO : followUpText(held) }
  }).catch((_$, _e, next) => toolFailed('review_comments', next.error))

  // Reading the forge and handing over take a while: the command answers at once, and the clock does them
  on('command.run', { command: 'follow-up' }, async ($, e) => {
    const words = e.args.trim().split(/\s+/).filter(word => word !== '')
    const verb = words.find(word => !word.startsWith('--')) ?? ''
    const held = await read($, followUp)

    await $.ui.open({ id: PANE, title: TITLE })

    // Handed over here, where the builder the build sends on the first comment is held
    if (verb === 'answer') return { text: await alone($, () => hand($, words.includes('--auto'))) }

    if (verb === 'close') {
      if (held?.phase === 'weighing') return { text: 'The follow-up weighs the comments: close it once it settles.' }
      await update($, followUp, () => null)

      return { text: `The review follow-up is closed.${held?.phase === 'handed' ? ` The build's run on ${reviewRef(held.pr)} goes on: /build abandon ${reviewRef(held.pr)} stops it.` : ''}` }
    }

    if (verb === '' && held !== null) return { text: followUpText(held) }

    await update($, wanted, () => ({ what: 'open' as const, arg: words.join(' ') }))

    return { text: 'The review follow-up opens: the pane says what it read.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const held = await read($, followUp)
    const problem = await read($, note)
    const busy = await read($, working)

    if (held === null) {
      return view.keep(
        <Box flexDirection="column" gap={1}>
          {badge({ label: 'closed', tone: 'neutral' })}
          {busy !== '' && <Text color="suggestion">{busy}</Text>}
          {problem !== '' && <Text color="warning">{problem}</Text>}
          <Text dimColor>{HOW_TO}</Text>
        </Box>,
        e.props.bodyColumns,
      )
    }

    const changes = held.comments.filter(one => one.kind === 'change')
    const questions = held.comments.length - changes.length
    const width = e.props.bodyColumns ?? 80
    return view.keep(
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
            {badge({ label: held.phase, tone: PHASE_TONE[held.phase] })}
            {changes.length > 0 && <Text>{`${changes.length} ${changes.length === 1 ? 'change' : 'changes'}`}</Text>}
            {questions > 0 && <Text color="warning">{`${questions} ${questions === 1 ? 'question' : 'questions'}`}</Text>}
          </Box>
          <Text bold>{`#${held.pr.number} ${held.pr.title}`}</Text>
          <Text dimColor>{`${held.pr.repo} · ${held.pr.branch} → ${held.pr.base}`}</Text>
        </Box>
        {busy !== '' && <Text color="suggestion">{busy}</Text>}
        {problem !== '' && <Text color="warning">{problem}</Text>}
        <Box flexDirection="column" borderStyle="round" paddingX={1} gap={1}>
          {held.comments.length === 0 && <Text dimColor>No open review comment.</Text>}
          {held.comments.map(comment => {
            const color = comment.kind === 'question' ? 'warning' : held.phase === 'handed' ? 'success' : undefined
            const where = comment.path !== '' ? `${comment.path}:${comment.line}` : ''
            const replies = comment.replies ?? 0
            const leftOut = comment.leftOut ?? 0

            return (
              <Box key={comment.id} flexDirection="row">
                <Box width={2} flexShrink={0}>
                  <Text color={color}>{comment.kind === 'question' ? '?' : '○'}</Text>
                </Box>
                <Box flexDirection="column" flexGrow={1} flexShrink={1}>
                  <Text>
                    <Text color={color} bold>{comment.kind === 'question' ? 'question' : comment.weight}</Text>
                    <Text dimColor>{` · ${comment.author}`}</Text>
                    {comment.isOutside === true && <Text color="warning">{' · from outside the repository'}</Text>}
                  </Text>
                  {where !== '' && <Text dimColor wrap="truncate-start">{where}</Text>}
                  <Text>{commentShown(comment, COMMENT_LINES) || 'a review comment'}</Text>
                  {replies > 0 && <Text dimColor>{`${replies} ${replies === 1 ? 'reply' : 'replies'} on the forge`}</Text>}
                  {leftOut > 0 && <Text color="warning">{`${leftOut} ${leftOut === 1 ? 'reply' : 'replies'} from outside the repository left out`}</Text>}
                </Box>
              </Box>
            )
          })}
        </Box>
        {held.phase === 'handed' && <Text dimColor>{`The build answers ${changes.length === 1 ? 'the comment' : `the ${changes.length} comments`} that ask for a change as ${shortRef(reviewRef(held.pr))}: its pane says how each stands, and pushes them once you say so.`}</Text>}
        {held.phase === 'ready' && changes.length > 0 && (
          <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
            <Button key="answer" hotkey="m" variant="primary" onPress={() => update($, wanted, () => ({ what: 'hand' as const }))}>
              {keyed('m', 'Hand them to the build')}
            </Button>
            <Button key="answer-auto" hotkey="a" onPress={() => update($, wanted, () => ({ what: 'hand auto' as const }))}>
              {keyed('a', 'Hand them over, going on by itself')}
            </Button>
          </Box>
        )}
      </Box>,
      width,
    )
  })
}
