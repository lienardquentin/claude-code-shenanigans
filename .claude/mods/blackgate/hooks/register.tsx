import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { BlackgateComment, BlackgateGate, BlackgatePhase, BlackgateWanted } from '../types'
import { ASKS, HOW_TO, MAX_TRIES, WEIGHER_MODEL, commentLine, commitMessage, gateText, isForbiddenGit, isModPath, marchPrompt, memberFor, parseGithub, parseGitlab, parseJudgement, parsePrRef, parseRemote, parseWeights, proofVerdict, purposeOf, readArgv, weighPrompt } from './gate'
import type { Target } from './gate'
import { badge } from './kit/badge'
import type { Tone } from './kit/badge'
import { paneView } from './kit/pane-text'

type $ = EngineInterface

/**
 * The project's folder: the repository's top, wherever the session's directory has wandered within it (a `cd` in
 * Claude's shell moves it), else the session's directory itself.
 */
const rootOf = async ($: $): Promise<string> => {
  const cwd = (await $.session.cwd()).replace(/\/+$/, '')
  const top = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd }).catch(() => undefined)
  const found = top?.exitCode === 0 ? top.stdout.trim() : ''

  return found !== '' ? found : cwd
}

const PANE = 'blackgate'
const TITLE = 'Black Gate'
const TICK_MS = 500
// How many ticks pass between two looks at the statues' judgement
const JUDGE_EVERY = 6
// How long the forge is given to answer or take a push
const FORGE_TIMEOUT_MS = 120_000

const gate = atom({ plugin: 'blackgate', key: 'gate' } as const, null as BlackgateGate | null)
const note = atom({ plugin: 'blackgate', key: 'note' } as const, '')
const wanted = atom({ plugin: 'blackgate', key: 'wanted' } as const, '' as BlackgateWanted)
const working = atom({ plugin: 'blackgate', key: 'working' } as const, '')

const view = paneView({ id: PANE, title: TITLE, command: '/blackgate' })

const TOOLS = [
  {
    name: 'open',
    description:
      "Opens the Black Gate on a pull request (a merge request on GitLab): reads its open review comments, has each weighed (light, standard, heavy) and told apart from questions only the person can answer, and checks out its branch. Changes nothing but the branch checked out. Call it when the person asks to take care of a pull request's review comments.",
    inputSchema: { type: 'object', properties: { pr: { type: 'string', description: 'The pull request: its number, its URL, or empty for the branch checked out.' } } },
  },
  {
    name: 'march',
    description: "Sends the Fellowship's members to answer the open gate's comments that ask for a change, one at a time: each answer proven by Argonath, judged by its statues, and committed on the pull request's branch. Questions are left to the person, and nothing is pushed.",
    inputSchema: { type: 'object', properties: { auto: { type: 'boolean', description: 'Go on by itself from one comment to the next. Only when the person asked for it.' } } },
  },
  {
    name: 'relics',
    description: 'The pull request the Black Gate is open on, as JSON: its ref, branch, base, URL and phase. For Mount Doom.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'forget',
    description: 'Closes the gate once its pull request is merged, which the forge is asked; one not merged is kept. For Mount Doom.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        pr: { type: 'string', description: 'The merged pull request, by its URL.' },
        json: { type: 'boolean', description: 'Answer as JSON, `{ forgotten, text }`, for a mod that reads it.' },
      },
      required: ['ref', 'pr'],
    },
  },
  {
    name: 'gate',
    description: 'Where the Black Gate stands: the pull request, each comment with its weight and state, the last proof and verdict.',
    inputSchema: { type: 'object', properties: {} },
  },
] as const

const PHASE_TONE: Record<BlackgatePhase, Tone> = { weighing: 'info', ready: 'neutral', marching: 'info', proving: 'info', judging: 'info', stuck: 'danger', done: 'success' }

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const ask = async ($: $, server: string, tool: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> => {
  try {
    const got = await $.mcp.call(server, tool, args)

    return { text: got.content.map(block => ('text' in block && typeof block.text === 'string' ? block.text : '')).join('\n'), isError: got.isError }
  } catch (error) {
    return { text: `${server} did not answer ${tool}: ${errorText(error)}`, isError: true }
  }
}

const run = async ($: $, argv: readonly string[]): Promise<{ ok: boolean; out: string }> => {
  const ran = await $.process.run(argv, { cwd: await rootOf($), timeoutMs: FORGE_TIMEOUT_MS }).catch((error: unknown) => ({ exitCode: -1, stdout: '', stderr: errorText(error) }))

  return { ok: ran.exitCode === 0, out: (ran.exitCode === 0 ? ran.stdout : ran.stderr || ran.stdout).trim() }
}

const git = ($: $, args: readonly string[]) => run($, ['git', ...args])

/**
 * Whether the forge says a pull request (a merge request on GitLab) is merged, by its URL, and, when a branch is named,
 * merged from that branch: what a mod forgets after it, it forgets only once its work has landed.
 */
const isMergedFrom = async ($: $, url: string, branch?: string): Promise<boolean> => {
  if (!/^https?:\/\//.test(url)) return false

  const isGithub = /\/\/github\.com\//.test(url)
  const ran = await $.process.run(isGithub ? ['gh', 'pr', 'view', url, '--json', 'state,headRefName'] : ['glab', 'mr', 'view', url, '--output', 'json'], { timeoutMs: 60_000 }).catch(() => undefined)

  if (ran === undefined || ran.exitCode !== 0) return false

  try {
    const held = JSON.parse(ran.stdout) as { state?: unknown; headRefName?: unknown; source_branch?: unknown }
    const from = isGithub ? held.headRefName : held.source_branch

    return (held.state === 'MERGED' || held.state === 'merged') && (branch === undefined || from === branch)
  } catch {
    return false
  }
}

const keep = async ($: $, change: (was: BlackgateGate) => BlackgateGate): Promise<void> => {
  await update($, gate, was => (was === null ? was : change(was)))
}

const setComment = (id: string, change: (was: BlackgateComment) => BlackgateComment) => (was: BlackgateGate): BlackgateGate => ({ ...was, comments: was.comments.map(one => (one.id === id ? change(one) : one)) })

const tell = async ($: $, text: string): Promise<void> => {
  $.ui.toast(`Black Gate: ${text}`)
  await $.ui.notify(text, { title: 'Black Gate' }).catch(() => undefined)
}

/** Opens the gate: reads the pull request and its open comments, checks its branch out, and has the comments weighed. */
const open = async ($: $, input: string): Promise<string> => {
  const held = await read($, gate)

  if (held !== null && held.phase !== 'done' && held.phase !== 'ready' && held.phase !== 'stuck') return `The gate is ${held.phase} on ${held.pr.repo}#${held.pr.number}: wait for it to settle.`

  const origin = parseRemote((await git($, ['remote', 'get-url', 'origin'])).out)
  let named = parsePrRef(input, origin)

  if (named === 'current') {
    if (origin === undefined) return 'The origin remote could not be read: name the pull request by its URL.'

    const viewed = await run($, origin.forge === 'github' ? ['gh', 'pr', 'view', '--json', 'number'] : ['glab', 'mr', 'view', '--output', 'json'])
    const number = viewed.ok ? Number((JSON.parse(viewed.out) as { number?: unknown; iid?: unknown }).number ?? (JSON.parse(viewed.out) as { iid?: unknown }).iid) : NaN

    if (!Number.isInteger(number)) return `This branch has no open pull request that ${origin.forge === 'github' ? 'gh' : 'glab'} knows of: name one.`

    named = { ...origin, number }
  }

  if (typeof named === 'string') return named

  await update($, working, () => `Reading the review comments of ${named.repo}#${named.number}…`)

  const argv = readArgv(named.forge, named.repo, named.number)
  const answers: string[] = []

  for (const one of argv) {
    const got = await run($, one)

    if (!got.ok) return `${one[0] ?? ''} could not read ${named.repo}#${named.number}: ${got.out.split('\n').slice(-1)[0] ?? ''}`
    answers.push(got.out)
  }

  const parsed = named.forge === 'github' ? parseGithub(answers[0] ?? '', named.repo, named.number) : parseGitlab(answers[0] ?? '', answers[1] ?? '', named.repo, named.number)

  if (typeof parsed === 'string') return parsed

  const current = (await git($, ['rev-parse', '--abbrev-ref', 'HEAD'])).out

  if (current !== parsed.pr.branch) {
    if ((await git($, ['status', '--porcelain'])).out !== '') return `The working tree has uncommitted changes: commit or stash them, then open the gate. Its answers are committed on ${parsed.pr.branch}.`

    await git($, ['fetch', 'origin', parsed.pr.branch])

    const switched = await git($, ['switch', parsed.pr.branch])

    if (!switched.ok) return `The gate could not check out ${parsed.pr.branch}: ${switched.out}`
  }

  await update($, gate, (): BlackgateGate => ({ pr: parsed.pr, comments: [], phase: 'weighing', isAuto: false, march: null, proof: '', proofLine: '', verdictLine: '', at: Date.now() }))
  await update($, working, () => `The Mouth of Sauron weighs ${parsed.comments.length} ${parsed.comments.length === 1 ? 'comment' : 'comments'}…`)

  const weighed = parsed.comments.length === 0 ? new Map() : await $.model.complete({ model: WEIGHER_MODEL, prompt: weighPrompt(parsed.comments) }).then(said => (said.isAnswered ? parseWeights(said.text) : new Map())).catch(() => new Map())
  const comments: BlackgateComment[] = parsed.comments.map(one => {
    const weight = weighed.get(one.id) ?? { weight: 'standard' as const, kind: 'change' as const }

    return { ...one, ...weight, state: weight.kind === 'question' ? 'asked' : 'todo', by: '', sha: '', note: weight.kind === 'question' ? 'a question for the person' : '' }
  })

  await keep($, was => ({ ...was, comments, phase: comments.some(one => one.state === 'todo') ? 'ready' : 'done' }))
  await update($, note, () => '')
  await $.ui.open({ id: PANE, title: TITLE }).catch(() => undefined)

  const changes = comments.filter(one => one.kind === 'change').length
  const questions = comments.length - changes

  return `The Black Gate opens on ${parsed.pr.repo}#${parsed.pr.number}, "${parsed.pr.title}", on ${parsed.pr.branch}: ${comments.length === 0 ? 'no open review comment.' : `${changes} ${changes === 1 ? 'comment asks' : 'comments ask'} for a change, ${questions} ${questions === 1 ? 'is a question' : 'are questions'} for the person. /blackgate march sends the members.`}`
}

/** What the project builds, as Argonath answers it: a member is chosen by the target a comment's file is in. */
const targetsOf = async ($: $): Promise<Target[]> => {
  const got = await ask($, 'argonath', 'targets')

  try {
    return got.isError ? [] : (JSON.parse(got.text) as Target[])
  } catch {
    return []
  }
}

/** Sends a member on a comment, on a try. */
const send = async ($: $, comment: BlackgateComment, attempt: number, retry?: { by: string; answer: string; proof?: string; findings?: string[] }): Promise<void> => {
  const held = await read($, gate)

  if (held === null) return

  const member = memberFor(comment, attempt, await targetsOf($), held.comments.indexOf(comment))
  // A comment sent again keeps HEAD as it was when it was first sent: a commit made past the proof since stays one
  const head = held.march !== null && held.march.commentId === comment.id && held.march.head !== undefined && held.march.head !== '' ? held.march.head : (await git($, ['rev-parse', 'HEAD'])).out
  const started = await $.agent
    .spawn({ subagentType: `fellowship:${member}`, description: `${member}: a review comment on ${held.pr.repo}#${held.pr.number}`, prompt: marchPrompt(held.pr, comment, retry) })
    .catch((error: unknown) => ({ deny: errorText(error), agentId: undefined }))

  if (started.deny !== undefined) {
    await keep($, was => ({ ...setComment(comment.id, one => ({ ...one, state: 'stuck', note: `no member could be sent: ${started.deny}` }))(was), phase: 'stuck', march: null }))

    return
  }

  await keep($, was => ({ ...setComment(comment.id, one => ({ ...one, state: 'doing' }))(was), phase: 'marching', verdictLine: '', march: { commentId: comment.id, member, agentId: started.agentId ?? '', attempt, answer: '', at: Date.now(), head } }))
}

/** Sends a member on the next comment that asks for a change, or finds every one answered. */
const sendNext = async ($: $): Promise<void> => {
  const held = await read($, gate)

  if (held === null || (held.phase !== 'ready' && held.phase !== 'stuck')) return

  const next = held.comments.find(one => one.state === 'todo') ?? (held.phase === 'stuck' ? held.comments.find(one => one.state === 'stuck') : undefined)

  if (next === undefined) {
    await keep($, was => ({ ...was, phase: 'done', march: null }))
    await tell($, `every comment on ${held.pr.repo}#${held.pr.number} that asked for a change is answered: /blackgate push pushes them`)

    return
  }

  await update($, working, () => `Sending a member on ${next.author}'s comment…`)
  await send($, { ...next, state: 'todo' }, 1)
}

/** A try that did not pass: a rung up with what stopped it, or, its tries spent, stopped for the person. */
const again = async ($: $, why: { proof?: string; findings?: string[] }, line: string): Promise<void> => {
  const held = await read($, gate)
  const out = held?.march
  const comment = held?.comments.find(one => one.id === out?.commentId)

  if (held === null || out === null || out === undefined || comment === undefined) return
  if (out.attempt < MAX_TRIES) return send($, comment, out.attempt + 1, { by: out.member, answer: out.answer, ...why })

  await keep($, was => ({ ...setComment(comment.id, one => ({ ...one, state: 'stuck', note: line }))(was), phase: 'stuck' }))
  await tell($, `${comment.author}'s comment is stuck: ${line}`)
}

/**
 * Why the change in the tree cannot be taken as the answer: HEAD moved since the comment was first sent, so a commit
 * was made past the proof and the statues. Nothing when it did not.
 */
const headMoved = async ($: $, held: BlackgateGate): Promise<string | undefined> => {
  const head = held.march?.head

  if (head === undefined || head === '') return undefined

  const now = (await git($, ['rev-parse', 'HEAD'])).out

  return now === head ? undefined : `HEAD moved from ${head.slice(0, 7)} to ${now.slice(0, 7)} while the comment was answered: a commit was made past the Argonath's proof and its statues. Put it back as uncommitted work (git reset --soft ${head.slice(0, 7)}), then march again.`
}

/** Stops the gate on a comment for the person, saying why. */
const stop = async ($: $, comment: BlackgateComment, why: string): Promise<void> => {
  await keep($, was => ({ ...setComment(comment.id, one => ({ ...one, state: 'stuck', note: why }))(was), phase: 'stuck' }))
  await update($, note, () => why)
  await tell($, `${comment.author}'s comment is stuck: ${why}`)
}

/** Proves what the member built: settled, the statues judge it; else a rung up. */
const prove = async ($: $): Promise<void> => {
  const held = await read($, gate)
  const comment = held?.comments.find(one => one.id === held.march?.commentId)

  if (held === null || held.phase !== 'proving' || comment === undefined) return

  const moved = await headMoved($, held)

  if (moved !== undefined) return stop($, comment, moved)

  await update($, working, () => `Argonath proves the answer to ${comment.author}'s comment…`)

  // The statues are convened here, on the change and what it is for: the proof owes none at the turn's end
  const proof = await ask($, 'argonath', 'prove', { owe: false, json: true })
  const verdict = proof.isError ? { isSettled: false, isUnlooked: true, line: proof.text, text: proof.text } : proofVerdict(proof.text)

  await keep($, was => ({ ...was, proof: verdict.text, proofLine: verdict.line }))

  // Argonath could not look at what the change reached: no member mends that
  if (verdict.isUnlooked) return stop($, comment, `${verdict.line}. Set the target right in .claude/argonath, then march again.`)
  if (!verdict.isSettled) return again($, { proof: verdict.text }, verdict.line)

  await keep($, was => ({ ...was, phase: 'judging', verdictLine: 'judging' }))
  await settle($, parseJudgement((await ask($, 'argonath', 'judgement', { convene: true, json: true, about: purposeOf(held.pr, comment) })).text))
}

/** What the statues' verdict comes to: committed when they pass the answer, a rung up when they find what blocks it. */
const settle = async ($: $, judged: ReturnType<typeof parseJudgement>): Promise<void> => {
  const held = await read($, gate)

  if (held === null || held.phase !== 'judging' || judged.verdict === 'sitting') return
  if (judged.verdict === 'pass') return commit($, judged.minor)
  if (judged.verdict === 'fail') return again($, { findings: judged.blocking }, `${judged.blocking.length} blocking ${judged.blocking.length === 1 ? 'finding' : 'findings'}`)

  if (judged.verdict === 'stale' || judged.verdict === 'unsettled' || judged.verdict === 'none') {
    await keep($, was => ({ ...was, phase: 'proving' }))
    await update($, wanted, () => 'prove')

    return
  }

  await keep($, was => ({ ...was, phase: 'stuck', verdictLine: judged.verdict }))
}

/** Commits the answer the statues passed, and goes on to the next comment when the gate goes on by itself. */
const commit = async ($: $, minor: readonly string[]): Promise<void> => {
  const held = await read($, gate)
  const out = held?.march
  const comment = held?.comments.find(one => one.id === out?.commentId)

  if (held === null || out === null || out === undefined || comment === undefined) return

  // The statues judged the answer against HEAD as the comment was sent: a commit made since was judged by no one
  const moved = await headMoved($, held)

  if (moved !== undefined) return stop($, comment, moved)

  let sha = ''

  if ((await git($, ['status', '--porcelain'])).out !== '') {
    const added = await git($, ['add', '-A'])
    const done = added.ok ? await git($, ['commit', '-m', commitMessage(held.pr, comment, out.member, minor)]) : added

    if (!done.ok) {
      await keep($, was => ({ ...was, phase: 'stuck' }))
      await update($, note, () => `The answer could not be committed: ${done.out}`)

      return
    }

    sha = (await git($, ['rev-parse', 'HEAD'])).out
  }

  await keep($, was => ({ ...setComment(comment.id, one => ({ ...one, state: 'done', by: out.member, sha }))(was), phase: 'ready', march: null, proof: '', proofLine: '', verdictLine: `passed${minor.length > 0 ? `, ${minor.length} minor` : ''}` }))

  const after = await read($, gate)

  if (after?.isAuto === true || after?.comments.every(one => one.state !== 'todo') === true) await update($, wanted, () => 'next')
  else await tell($, `${comment.author}'s comment is answered${sha === '' ? '' : ` as ${sha.slice(0, 7)}`}: /blackgate march sends the next`)
}

/** Pushes what the members committed onto the pull request's branch. The person's word alone: no tool offers it to Claude. */
const push = async ($: $): Promise<string> => {
  const held = await read($, gate)

  if (held === null) return HOW_TO
  if (held.phase !== 'done' && held.phase !== 'ready' && held.phase !== 'stuck') return `The gate is ${held.phase}: push once it settles.`
  if ((await git($, ['rev-parse', '--abbrev-ref', 'HEAD'])).out !== held.pr.branch) return `${held.pr.branch} is not checked out: nothing is pushed.`

  await update($, working, () => `Pushing ${held.pr.branch}…`)

  const pushed = await git($, ['push', 'origin', held.pr.branch])

  return pushed.ok ? `${held.pr.branch} is pushed: ${held.comments.filter(one => one.state === 'done').length} answered ${held.comments.filter(one => one.state === 'done').length === 1 ? 'comment' : 'comments'} are on ${held.pr.url}.` : `${held.pr.branch} could not be pushed: ${held.pr.branch} may be behind its remote. ${pushed.out.split('\n').slice(-1)[0] ?? ''}`
}

let isBusy = false
let ticks = 0

const tick = async ($: $): Promise<void> => {
  if (isBusy) return

  const asked = await read($, wanted)

  if (asked === '') {
    ticks += 1
    if (ticks % JUDGE_EVERY !== 0 || (await read($, gate))?.phase !== 'judging') return
  }

  isBusy = true
  if (asked !== '') await update($, wanted, () => '')

  try {
    if (asked === '') await settle($, parseJudgement((await ask($, 'argonath', 'judgement', { json: true })).text))
    else if (asked === 'next') await sendNext($)
    else await prove($)
  } catch (error) {
    await update($, note, () => `The gate stumbled: ${errorText(error)}`)
  } finally {
    isBusy = false
    await update($, working, () => '')
  }
}

const alone = async <T,>($: $, act: () => Promise<T>): Promise<T> => {
  isBusy = true

  try {
    return await act()
  } finally {
    isBusy = false
    await update($, working, () => '')
  }
}

/** Starts the members on the comments; auto, they go on from one to the next by themselves. */
const march = async ($: $, isAuto: boolean): Promise<string> => {
  const held = await read($, gate)

  if (held === null) return HOW_TO
  if (held.phase !== 'ready' && held.phase !== 'stuck') return `The gate is ${held.phase}.`

  await keep($, was => ({ ...was, isAuto }))
  await update($, wanted, () => 'next')

  return `The members set out on ${held.pr.repo}#${held.pr.number}'s comments${isAuto ? ', going on by themselves' : ', stopping after each answer for you'}.`
}

/** Whether an agent is the member out on a comment: by the id its spawn answered, else by its type. */
const isOut = async ($: $, held: BlackgateGate | null, agentId: string): Promise<boolean> => {
  const out = held?.march

  if (held === null || held.phase !== 'marching' || out === null || out === undefined) return false

  return out.agentId !== '' ? agentId === out.agentId : (await $.agent.list().catch(() => [])).some(one => one.id === agentId && one.type === `fellowship:${out.member}` && one.status === 'running')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'blackgate', description: "Answer a pull request's review comments: /blackgate <pr> opens the gate; march (--auto), push, close" })

    for (const tool of [view.tool, ...TOOLS]) await $.tool.register(tool).catch(() => undefined)

    $.clock.every(TICK_MS, () => void tick($).catch(() => undefined))
    $.ui.invalidate('ui.render')

    return next(e)
  })

  // The member's turn has ended: what it built is proven, outside this hook; a comment it cannot answer goes to the person
  on('turn.complete', async ($, e, next) => {
    const held = await read($, gate)

    if (held !== null && e.agentId !== undefined && (await isOut($, held, e.agentId))) {
      const out = { ...(held.march ?? { commentId: '', member: '', agentId: '', attempt: 1, at: 0 }), answer: e.answer ?? '' }
      const asks = out.answer.split('\n').find(line => line.trim().startsWith(ASKS))

      if (e.isAborted || e.reason !== 'answer') {
        await keep($, was => ({ ...setComment(out.commentId, one => ({ ...one, state: 'stuck', note: e.isAborted ? 'the member was interrupted' : 'the member ended without an answer' }))(was), phase: 'stuck', march: out }))
      } else if (asks !== undefined) {
        const isClean = (await git($, ['status', '--porcelain'])).out === ''

        await keep($, was => ({ ...setComment(out.commentId, one => ({ ...one, state: isClean ? 'asked' : 'stuck', note: asks.trim().slice(ASKS.length).trim() }))(was), phase: isClean ? 'ready' : 'stuck', march: isClean ? null : out }))
        if (isClean) await update($, wanted, () => 'next')
      } else {
        await keep($, was => ({ ...was, phase: 'proving', march: out }))
        await update($, wanted, () => 'prove')
      }
    }

    return next(e)
  })

  // The member answers the comment, and leaves the branch, the commits and the mods' folders to the gate
  on('tool.call', async ($, e, next) => {
    const given = e as unknown as { tool: string; agentId?: string; command?: unknown; file_path?: unknown }

    if (given.agentId === undefined || !(await isOut($, await read($, gate), given.agentId))) return next(e)
    if (given.tool === 'Bash' && typeof given.command === 'string' && isForbiddenGit(given.command)) return { deny: 'The gate commits and keeps the branch: leave your change uncommitted, and run no git command that moves HEAD or the index.' }
    if (typeof given.file_path === 'string' && isModPath(await rootOf($), given.file_path)) return { deny: 'That folder belongs to a mod: change the project, not what the mods keep.' }

    return next(e)
  }).catch((_$, e, next) => next(e))

  on('tool.call', { tool: 'mcp__blackgate__pane' }, $ => view.answer(() => $.ui.panes()))

  on('tool.call', { tool: 'mcp__blackgate__open' }, async ($, e) => ({ result: await alone($, () => open($, String((e as unknown as { pr?: unknown }).pr ?? ''))) }))

  on('tool.call', { tool: 'mcp__blackgate__march' }, async ($, e) => ({ result: await march($, (e as unknown as { auto?: unknown }).auto === true) }))

  on('tool.call', { tool: 'mcp__blackgate__relics' }, async $ => {
    const held = await read($, gate)

    return { result: JSON.stringify(held === null ? [] : [{ ref: `${held.pr.repo}#${held.pr.number}`, branch: held.pr.branch, base: held.pr.base, pr: held.pr.url, phase: held.phase }]) }
  })

  on('tool.call', { tool: 'mcp__blackgate__forget' }, async ($, e) => {
    const given = e as unknown as { pr?: unknown; json?: unknown }
    const answer = (forgotten: boolean, text: string) => ({ result: given.json === true ? JSON.stringify({ forgotten, text }) : text })
    const held = await read($, gate)

    if (held === null || held.pr.url !== given.pr) return answer(false, 'No gate is open on that pull request.')
    if (!(await isMergedFrom($, held.pr.url, held.pr.branch))) return answer(false, `${held.pr.url} is not merged: the gate stays open.`)

    await update($, gate, () => null)

    return answer(true, `The gate on ${held.pr.repo}#${held.pr.number} is closed.`)
  })

  on('tool.call', { tool: 'mcp__blackgate__gate' }, async $ => {
    const held = await read($, gate)

    return { result: held === null ? HOW_TO : gateText(held) }
  })

  // Pushing reaches outside the machine: no tool offers it to Claude, and the person pushes with /blackgate push or the pane
  on('command.run', { command: 'blackgate' }, async ($, e) => {
    const words = e.args.trim().split(/\s+/).filter(word => word !== '')
    const verb = words.find(word => !word.startsWith('--')) ?? ''

    await $.ui.open({ id: PANE, title: TITLE })

    if (verb === 'march') return { text: await march($, words.includes('--auto')) }
    if (verb === 'push') return { text: await alone($, () => push($)) }

    if (verb === 'close') {
      const held = await read($, gate)

      if (held !== null && (held.phase === 'marching' || held.phase === 'proving' || held.phase === 'judging' || held.phase === 'weighing')) return { text: `The gate is ${held.phase}: close it once it settles.` }
      await update($, gate, () => null)

      return { text: 'The Black Gate is closed. Nothing on the branch or the forge was touched.' }
    }

    const held = await read($, gate)

    if (verb === '' && held !== null) return { text: gateText(held) }

    return { text: await alone($, () => open($, words.join(' '))) }
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

    return view.keep(
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={2}>
          {badge({ label: held.phase, tone: PHASE_TONE[held.phase] })}
          <Text bold wrap="truncate-end">{held.pr.title}</Text>
        </Box>
        <Text dimColor>{`${held.pr.repo}#${held.pr.number} · ${held.pr.branch} → ${held.pr.base}${held.isAuto ? ' · auto' : ''}`}</Text>
        {busy !== '' && <Text color="suggestion">{busy}</Text>}
        {problem !== '' && <Text color="warning">{problem}</Text>}
        <Box flexDirection="column" borderStyle="round" paddingX={1}>
          {held.comments.length === 0 && <Text dimColor>No open review comment.</Text>}
          {held.comments.map(comment => (
            <Text key={comment.id} color={comment.state === 'done' ? 'success' : comment.state === 'asked' ? 'warning' : comment.state === 'stuck' ? 'error' : comment.state === 'doing' ? 'suggestion' : undefined} wrap="truncate-end">
              {`${commentLine(comment)}${held.march?.commentId === comment.id ? ` · ${held.march.member}, ${held.phase}` : ''}`}
            </Text>
          ))}
        </Box>
        {held.proofLine !== '' && <Text dimColor>{`Argonath's proof: ${held.proofLine}`}</Text>}
        {held.verdictLine !== '' && <Text dimColor>{`The statues: ${held.verdictLine}`}</Text>}
        <Box flexDirection="row" gap={1}>
          {(held.phase === 'ready' || held.phase === 'stuck') && held.comments.some(one => one.state === 'todo' || one.state === 'stuck') && (
            <Button key="march" hotkey="m" variant="primary" onPress={() => march($, held.isAuto).then(said => update($, note, () => said))}>
              {held.phase === 'stuck' ? 'Send again' : 'Answer the next comment'}
            </Button>
          )}
          {held.comments.some(one => one.state === 'done') && (held.phase === 'done' || held.phase === 'ready' || held.phase === 'stuck') && (
            <Button key="push" hotkey="p" onPress={() => alone($, () => push($)).then(said => update($, note, () => said))}>
              Push the answers
            </Button>
          )}
        </Box>
      </Box>,
    )
  })
}
