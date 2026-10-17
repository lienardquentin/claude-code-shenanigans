import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { BlackgateComment, BlackgateGate, BlackgatePhase } from '../../types'
import { HOW_TO, WEIGHER_MODEL, commentLine, gateText, handedOf, parseGithub, parseGitlab, parsePrRef, parseRemote, parseWeights, readArgv, reviewRef, weighPrompt } from './gate'
import { errorText, git, isMergedFrom, run, toolFailed } from '../flow'
import { badge } from '../kit/badge'
import type { Tone } from '../kit/badge'
import { paneView } from '../kit/pane-text'
import { takeReview } from '../fellowship/register'

type $ = EngineInterface
type On = Parameters<Register>[0]

const PANE = 'blackgate'
const TITLE = 'Black Gate'
const TICK_MS = 500
// How long the forge is given to answer
const FORGE_TIMEOUT_MS = 120_000

const gate = atom({ plugin: 'middle-earth', key: 'blackgateGate' } as const, null as BlackgateGate | null)
const note = atom({ plugin: 'middle-earth', key: 'blackgateNote' } as const, '')
const wanted = atom({ plugin: 'middle-earth', key: 'blackgateWanted' } as const, null as { what: 'open' | 'hand' | 'hand auto'; arg?: string } | null)
const working = atom({ plugin: 'middle-earth', key: 'blackgateWorking' } as const, '')

export const blackgateView = paneView({ id: PANE, title: TITLE, command: '/blackgate' })
const view = blackgateView

const TOOLS = [
  {
    name: 'open',
    description:
      "Opens the Black Gate on a pull request (a merge request on GitLab): reads its open review comments, has each weighed (light, standard, heavy) and told apart from questions only the person can answer. Changes nothing. Call it when the person asks to take care of a pull request's review comments.",
    inputSchema: { type: 'object', properties: { pr: { type: 'string', description: 'The pull request: its number, its URL, or empty for the branch checked out.' } } },
  },
  {
    name: 'march',
    description:
      "Hands the open gate's comments that ask for a change to the Fellowship, which answers them one at a time on the pull request's branch, in a worktree of its own: each answer proven by Argonath, judged by its statues, and committed. Questions are left to the person, and nothing is pushed until the person says so.",
    inputSchema: { type: 'object', properties: { auto: { type: 'boolean', description: 'Go on by itself from one comment to the next. Only when the person asked for it.' } } },
  },
  {
    name: 'gate',
    description: 'Where the Black Gate stands: the pull request, and each comment with its weight, the questions the person is to answer apart.',
    inputSchema: { type: 'object', properties: {} },
  },
] as const

const PHASE_TONE: Record<BlackgatePhase, Tone> = { weighing: 'info', ready: 'neutral', handed: 'success' }

async function keep($: $, change: (was: BlackgateGate) => BlackgateGate): Promise<void> {
  await update($, gate, was => (was === null ? was : change(was)))
}

/** Opens the gate: reads the pull request and its open comments, and has them weighed. Nothing is checked out. */
async function open($: $, input: string): Promise<string> {
  const held = await read($, gate)

  if (held?.phase === 'weighing') return `The gate weighs the comments of ${held.pr.repo}#${held.pr.number}: wait for it to settle.`

  const origin = parseRemote((await git($, ['remote', 'get-url', 'origin'])).out)
  let named = parsePrRef(input, origin)

  if (named === 'current') {
    if (origin === undefined) return 'The origin remote could not be read: name the pull request by its URL.'

    const viewed = await run($, origin.forge === 'github' ? ['gh', 'pr', 'view', '--json', 'number'] : ['glab', 'mr', 'view', '--output', 'json'], FORGE_TIMEOUT_MS)
    let number = NaN

    try {
      const shown = JSON.parse(viewed.out) as { number?: unknown; iid?: unknown }

      number = viewed.ok ? Number(shown.number ?? shown.iid) : NaN
    } catch {
      // no pull request for this branch
    }

    if (!Number.isInteger(number)) return `This branch has no open pull request that ${origin.forge === 'github' ? 'gh' : 'glab'} knows of: name one.`

    named = { ...origin, number }
  }

  if (typeof named === 'string') return named

  await update($, working, () => `Reading the review comments of ${named.repo}#${named.number}…`)

  const answers: string[] = []

  const unread: string[] = []

  for (const [at, argv] of readArgv(named.forge, named.repo, named.number).entries()) {
    const got = await run($, argv, FORGE_TIMEOUT_MS)

    // GitLab's members say whose comments are trusted: unread, every author is taken as outside, and that is said
    if (!got.ok && named.forge === 'gitlab' && at === 2) {
      unread.push(`the project's members could not be read (${got.out.split('\n').slice(-1)[0] ?? ''}), so every comment is taken as from outside the repository`)
      answers.push('')
      continue
    }
    if (!got.ok) return `${argv[0] ?? ''} could not read ${named.repo}#${named.number}: ${got.out.split('\n').slice(-1)[0] ?? ''}`
    answers.push(got.out)
  }

  const parsed = named.forge === 'github' ? parseGithub(answers[0] ?? '', named.repo, named.number) : parseGitlab(answers[0] ?? '', answers[1] ?? '', named.repo, named.number, answers[2] ?? '')

  if (typeof parsed === 'string') return parsed

  await update($, gate, (): BlackgateGate => ({ pr: parsed.pr, comments: [], phase: 'weighing', at: Date.now() }))
  await update($, working, () => `The Mouth of Sauron weighs ${parsed.comments.length} ${parsed.comments.length === 1 ? 'comment' : 'comments'}…`)

  const weighing = parsed.comments.length === 0 ? new Map() : await $.model.complete({ model: WEIGHER_MODEL, prompt: weighPrompt(parsed.comments) }).then(said => (said.isAnswered ? parseWeights(said.text) : 'it gave no answer')).catch((error: unknown) => errorText(error))
  const weighed = typeof weighing === 'string' ? new Map<string, { weight: 'standard'; kind: 'question' }>() : weighing
  // A comment the Mouth of Sauron did not weigh is the person's to read, never built on a guess; one from outside the
  // repository is the person's to weigh, whatever it asks
  const all = parsed.comments.map(one => {
    const got = weighed.get(one.id) ?? { weight: 'standard' as const, isUnweighed: true, kind: 'question' as const }

    return { ...one, ...got, kind: one.isOutside === true && got.kind === 'change' ? ('question' as const) : got.kind }
  })
  const unweighed = parsed.comments.filter(one => !weighed.has(one.id)).length
  const outside = all.filter(one => one.isOutside === true && one.kind !== 'settled').length
  const said = [
    ...unread,
    ...parsed.unread,
    ...(typeof weighing === 'string' ? [`the comments could not be weighed (${weighing}): each is a question for you`] : unweighed > 0 ? [`${unweighed} ${unweighed === 1 ? 'comment was' : 'comments were'} not weighed, and ${unweighed === 1 ? 'is a question' : 'are questions'} for you`] : []),
    ...(outside > 0 ? [`${outside} ${outside === 1 ? 'comment is' : 'comments are'} from outside the repository, and ${outside === 1 ? 'is a question' : 'are questions'} for you, never built`] : []),
  ]
  // What asks nothing more (a question answered against the change, a review's summary, a comment taken back) is left out
  const comments: BlackgateComment[] = all.flatMap(one => (one.kind === 'settled' ? [] : [{ ...one, kind: one.kind }]))
  const settled = all.length - comments.length

  await keep($, was => ({ ...was, comments, phase: 'ready' }))
  await update($, note, () => (said.length === 0 ? '' : `${said.join('; ')}.`))
  await $.ui.open({ id: PANE, title: TITLE }).catch(() => undefined)

  const changes = comments.filter(one => one.kind === 'change').length
  const questions = comments.length - changes

  return `The Black Gate opens on ${parsed.pr.repo}#${parsed.pr.number}, "${parsed.pr.title}", on ${parsed.pr.branch}: ${comments.length === 0 ? 'no open review comment.' : `${changes} ${changes === 1 ? 'comment asks' : 'comments ask'} for a change, ${questions} ${questions === 1 ? 'is a question' : 'are questions'} for the person${settled > 0 ? `, ${settled} ${settled === 1 ? 'is' : 'are'} settled` : ''}. /blackgate march hands them to the Fellowship.`}${said.length > 0 ? ` Mind: ${said.join('; ')}.` : ''}`
}

/** Hands the comments that ask for a change to the Fellowship, which builds them on the pull request's branch. */
async function hand($: $, isAuto: boolean): Promise<string> {
  const held = await read($, gate)

  if (held === null) return HOW_TO
  if (held.phase === 'weighing') return 'The comments are still being weighed.'
  if (held.pr.isFork === true) return `${held.pr.repo}#${held.pr.number} comes from a fork: its branch cannot be pushed to from this repository, so the Fellowship does not take it up. Answer its comments on the fork.`
  if (!held.comments.some(one => one.kind === 'change')) return `No comment of ${held.pr.repo}#${held.pr.number} asks for a change: the questions are yours to answer.`

  await update($, working, () => `Handing ${held.pr.repo}#${held.pr.number}'s comments to the Fellowship…`)

  const got = await takeReview($, handedOf(held), isAuto).catch((error: unknown) => errorText(error))

  if (!/sets out|takes up/.test(got)) return `The Fellowship did not take the comments up: ${got.slice(0, 300)}`

  await keep($, was => ({ ...was, phase: 'handed' }))

  return `${got} The questions are yours to answer on ${held.pr.url}.`
}

/** The pull request the gate is open on, for Mount Doom, which watches for it to be merged. */
export async function gateRelics($: $): Promise<{ ref: string; branch: string; base: string; pr: string; phase: string }[]> {
  const held = await read($, gate)

  return held === null ? [] : [{ ref: `${held.pr.repo}#${held.pr.number}`, branch: held.pr.branch, base: held.pr.base, pr: held.pr.url, phase: held.phase }]
}

/** Closes the gate once its pull request is merged, which the forge is asked; one not merged is kept. For Mount Doom. */
export async function closeGate($: $, pr: string): Promise<{ forgotten: boolean; text: string }> {
  const held = await read($, gate)

  if (held === null || held.pr.url !== pr) return { forgotten: false, text: 'No gate is open on that pull request.' }
  if (!(await isMergedFrom($, held.pr.url, held.pr.branch))) return { forgotten: false, text: `${held.pr.url} is not merged: the gate stays open.` }

  await update($, gate, () => null)

  return { forgotten: true, text: `The gate on ${held.pr.repo}#${held.pr.number} is closed.` }
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

    $.ui.toast(`Black Gate: ${said.split('\n')[0] ?? said}`)
    await update($, note, () => said)
  } catch (error) {
    await update($, note, () => `The gate stumbled: ${errorText(error)}`)
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

/** The Black Gate at the session's start: its command, its tools, and the clock that does what a command asked. */
export async function startBlackgate($: $): Promise<void> {
  await $.command.register({ name: 'blackgate', description: "Answer a pull request's review comments: /blackgate <pr> opens the gate; march (--auto) hands them to the Fellowship; close" })

  for (const tool of TOOLS) await $.tool.register(tool).catch(() => undefined)

  $.clock.every(TICK_MS, () => void tick($).catch(() => undefined))
}

export function registerBlackgate(on: On): void {
  on('tool.call', { tool: 'mcp__middle-earth__open' }, async ($, e) => ({ result: await alone($, () => open($, String((e as unknown as { pr?: unknown }).pr ?? ''))) })).catch((_$, _e, next) => toolFailed('open', next.error))

  on('tool.call', { tool: 'mcp__middle-earth__march' }, async ($, e) => ({ result: await alone($, () => hand($, (e as unknown as { auto?: unknown }).auto === true)) })).catch((_$, _e, next) => toolFailed('march', next.error))

  on('tool.call', { tool: 'mcp__middle-earth__gate' }, async $ => {
    const held = await read($, gate)

    return { result: held === null ? HOW_TO : gateText(held) }
  }).catch((_$, _e, next) => toolFailed('gate', next.error))

  // Reading the forge and handing over take a while: the command answers at once, and the clock does them
  on('command.run', { command: 'blackgate' }, async ($, e) => {
    const words = e.args.trim().split(/\s+/).filter(word => word !== '')
    const verb = words.find(word => !word.startsWith('--')) ?? ''
    const held = await read($, gate)

    await $.ui.open({ id: PANE, title: TITLE })

    // Handed over here, where the member the Fellowship sends on the first comment is held
    if (verb === 'march') return { text: await alone($, () => hand($, words.includes('--auto'))) }

    if (verb === 'close') {
      if (held?.phase === 'weighing') return { text: 'The gate weighs the comments: close it once it settles.' }
      await update($, gate, () => null)

      return { text: `The Black Gate is closed.${held?.phase === 'handed' ? ` The Fellowship's quest on ${reviewRef(held.pr)} goes on: /fellowship abandon ${reviewRef(held.pr)} stops it.` : ''}` }
    }

    if (verb === '' && held !== null) return { text: gateText(held) }

    await update($, wanted, () => ({ what: 'open' as const, arg: words.join(' ') }))

    return { text: 'The Black Gate opens: the pane says what it read.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const held = await read($, gate)
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
      )
    }

    const changes = held.comments.filter(one => one.kind === 'change')

    return view.keep(
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={2}>
          {badge({ label: held.phase, tone: PHASE_TONE[held.phase] })}
          <Text bold wrap="truncate-end">{held.pr.title}</Text>
        </Box>
        <Text dimColor>{`${held.pr.repo}#${held.pr.number} · ${held.pr.branch} → ${held.pr.base}`}</Text>
        {busy !== '' && <Text color="suggestion">{busy}</Text>}
        {problem !== '' && <Text color="warning">{problem}</Text>}
        <Box flexDirection="column" borderStyle="round" paddingX={1}>
          {held.comments.length === 0 && <Text dimColor>No open review comment.</Text>}
          {held.comments.map(comment => (
            <Text key={comment.id} color={comment.kind === 'question' ? 'warning' : held.phase === 'handed' ? 'success' : undefined} wrap="truncate-end">
              {commentLine(comment)}
            </Text>
          ))}
        </Box>
        {held.phase === 'handed' && <Text dimColor>{`The Fellowship answers ${changes.length === 1 ? 'the comment' : `the ${changes.length} comments`} that ask for a change as ${reviewRef(held.pr)}: its pane says how each stands, and pushes them once you say so.`}</Text>}
        <Box flexDirection="row" gap={1}>
          {held.phase === 'ready' && changes.length > 0 && (
            <Button key="march" hotkey="m" variant="primary" onPress={() => update($, wanted, () => ({ what: 'hand' as const }))}>
              Hand them to the Fellowship
            </Button>
          )}
          {held.phase === 'ready' && changes.length > 0 && (
            <Button key="march-auto" hotkey="a" onPress={() => update($, wanted, () => ({ what: 'hand auto' as const }))}>
              Hand them over, going on by itself
            </Button>
          )}
        </Box>
      </Box>,
    )
  })
}
