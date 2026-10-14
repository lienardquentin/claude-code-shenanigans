import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { FellowshipMember, FellowshipPhase, FellowshipPlan, FellowshipQuest, FellowshipTask, FellowshipWanted } from '../types'
import { HOW_TO, MARK, MEMBERS, REVISE, branchOf, purposeOf, commitMessage, companionPrompt, isAllDone, isForbiddenGit, isModPath, isModSource, memberFor, memberSystem, nextTask, parseJudgement, parsePlan, prArgv, proofVerdict, questText, resumePrompt, statuesFor, tally, triesOf, unsettledOf, wardPurpose } from './quest'
import type { Retry, Target } from './quest'
import { badge } from './kit/badge'
import type { Tone } from './kit/badge'
import { paneView } from './kit/pane-text'

type $ = EngineInterface

const PANE = 'fellowship'
const TITLE = 'Fellowship'
// How many ticks of the clock pass between two looks at the statues' judgement
const JUDGE_EVERY = 6
// How often the clock looks for what a press or a turn asked for
const TICK_MS = 500
// How long the forge is given to take a push or open a pull request
const FORGE_TIMEOUT_MS = 120_000
// Where a quest is kept across sessions, by its issue
const STORE_KEY = (ref: string) => `quest:${ref}`

const quest = atom({ plugin: 'fellowship', key: 'quest' } as const, null as FellowshipQuest | null)
const plan = atom({ plugin: 'fellowship', key: 'plan' } as const, null as FellowshipPlan | null)
const note = atom({ plugin: 'fellowship', key: 'note' } as const, '')
const wanted = atom({ plugin: 'fellowship', key: 'wanted' } as const, '' as FellowshipWanted)
const working = atom({ plugin: 'fellowship', key: 'working' } as const, '')

const view = paneView({ id: PANE, title: TITLE, command: '/fellowship' })

const TOOLS = [
  {
    name: 'set_out',
    description:
      'Sets the Fellowship out on the Elrond plan in force: on a branch of its own, it sends a member of the Fellowship to build each task in turn in the working tree (a hobbit, the elf, the dwarf or the man of Gondor, Aragorn or Gandalf, by the weight and the target of the task, one rung up each try), has the Argonath prove each change and its statues judge it, and commits it once they pass it. Once every task is, the person opens the pull request with /fellowship sail, or it opens by itself on a quest they set out on with auto. It sets out only once every question of the plan is answered and every risk decided. Call it when the person asks to implement a planned issue.',
    inputSchema: { type: 'object', properties: { auto: { type: 'boolean', description: 'Go on by itself: send each task once the one before is committed, and open the pull request at the end. Only when the person asked for it in those words.' } } },
  },
  {
    name: 'relics',
    description: 'Every quest the Fellowship keeps, as JSON: its issue, branch, base, pull request and phase. For Mount Doom, which watches for their pull requests to be merged.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'forget',
    description: 'Forgets a quest once its pull request is merged from its branch, which the forge is asked; one not merged is kept. For Mount Doom.',
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
    name: 'quest',
    description: "Where the Fellowship's quest stands: its phase, the companion out, Argonath's last proof, and each task with its commit.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'commit',
    description: "Puts the uncommitted change of a stuck task before the Argonath again: proved, then judged by its statues, and committed once they pass it. Call it when the person has finished a stuck task by hand and asks to commit it.",
    inputSchema: { type: 'object', properties: {} },
  },
] as const

const PHASE_TONE: Record<FellowshipPhase, Tone> = { ready: 'neutral', gazing: 'info', marching: 'info', proving: 'info', judging: 'info', stuck: 'danger', arrived: 'accent', warding: 'info', sailed: 'success' }

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** A tool of another mod, through the engine's MCP connection: its text, or why it did not answer. */
const ask = async ($: $, server: string, tool: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> => {
  try {
    const got = await $.mcp.call(server, tool, args)
    const text = got.content.map(block => ('text' in block && typeof block.text === 'string' ? block.text : '')).join('\n')

    return { text, isError: got.isError }
  } catch (error) {
    return { text: `${server} did not answer ${tool}: ${errorText(error)}`, isError: true }
  }
}

/** The Elrond plan in force, read afresh and kept for the pane: `null` when none is, a sentence when it could not be read. */
const readPlan = async ($: $): Promise<FellowshipPlan | null | string> => {
  const got = await ask($, 'elrond', 'plan', { json: true })
  const made = got.isError ? got.text : parsePlan(got.text)

  if (typeof made !== 'string') await update($, plan, () => made)

  return made
}

const git = async ($: $, args: readonly string[]): Promise<{ ok: boolean; out: string }> => {
  const ran = await $.process.run(['git', ...args], { cwd: await $.session.cwd() }).catch((error: unknown) => ({ exitCode: -1, stdout: '', stderr: errorText(error) }))

  return { ok: ran.exitCode === 0, out: (ran.exitCode === 0 ? ran.stdout : ran.stderr || ran.stdout).trim() }
}

/**
 * The project's folder: the repository's top, wherever the session's directory has wandered within it (a `cd` in
 * Claude's shell moves it), else the session's directory itself.
 */
const rootOf = async ($: $): Promise<string> => {
  const top = await git($, ['rev-parse', '--show-toplevel'])

  return top.ok && top.out !== '' ? top.out : (await $.session.cwd()).replace(/\/+$/, '')
}

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

/** Every quest kept, here or across sessions: what Mount Doom watches. */
const relics = async ($: $): Promise<{ ref: string; branch: string; base: string; pr: string; phase: string }[]> => {
  const kept: FellowshipQuest[] = []
  const held = await read($, quest)

  if (held !== null) kept.push(held)

  for (const key of (await $.store.keys().catch(() => [])).filter(one => one.startsWith('quest:'))) {
    const one = (await $.store.get(key).catch(() => undefined)) as FellowshipQuest | undefined

    if (one !== undefined && one !== null && !kept.some(was => was.ref === one.ref)) kept.push(one)
  }

  return kept.map(({ ref, branch, base, pr, phase }) => ({ ref, branch, base, pr, phase }))
}

/** Forgets a quest whose pull request is merged from its branch, here and across sessions. Nothing else is touched. */
const forget = async ($: $, ref: string, pr: string): Promise<{ forgotten: boolean; text: string }> => {
  const found = (await relics($)).find(one => one.ref === ref)

  if (found === undefined) return { forgotten: false, text: `No quest on ${ref} is kept.` }
  if (!(await isMergedFrom($, pr, found.branch))) return { forgotten: false, text: `${pr} is not a merged pull request from ${found.branch}: the quest on ${ref} is kept.` }

  await $.store.delete(STORE_KEY(ref)).catch(() => undefined)
  if ((await read($, quest))?.ref === ref) {
    await update($, quest, () => null)
    await update($, plan, () => null)
  }

  return { forgotten: true, text: `The quest on ${ref} is forgotten.` }
}

/** Sets the quest, and keeps it across sessions. */
const keep = async ($: $, change: (was: FellowshipQuest) => FellowshipQuest): Promise<FellowshipQuest | null> => {
  const was = await read($, quest)

  if (was === null) return null

  const made = change(was)

  await update($, quest, () => made)
  await $.store.set(STORE_KEY(made.ref), made).catch(() => undefined)

  return made
}

const tell = async ($: $, text: string): Promise<void> => {
  $.ui.toast(`Fellowship: ${text}`)
  await $.ui.notify(text, { title: 'Fellowship' }).catch(() => undefined)
}

/** The branch a quest set out from when it is already on its own: the remote's default, else main. */
const defaultBranch = async ($: $): Promise<string> => {
  const found = await git($, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])

  return found.ok && found.out !== '' ? found.out.replace(/^origin\//, '') : 'main'
}

/**
 * Sets out on the plan in force, or takes up its quest where it was left. Answers what was done, in a sentence; the
 * first task is sent by the clock, outside the call that asked.
 */
const setOut = async ($: $, isAuto: boolean): Promise<string> => {
  const made = await readPlan($)

  if (made === null) return HOW_TO
  if (typeof made === 'string') return made

  const open = unsettledOf(made)

  if (open.length > 0) return `The council's work on ${made.ref} is not settled: ${open.join('; ')}. Settle them in the Elrond pane, then set out.`

  const held = await read($, quest)

  if (held !== null && held.ref !== made.ref && held.phase !== 'sailed' && held.phase !== 'ready') return `The Fellowship is on ${held.ref} (${held.phase}); finish it before setting out on ${made.ref}.`

  const kept = held?.ref === made.ref ? held : ((await $.store.get(STORE_KEY(made.ref)).catch(() => undefined)) as FellowshipQuest | undefined)
  const resumed = kept !== undefined && kept !== null && kept.phase !== 'sailed' ? kept : undefined
  const branch = resumed?.branch ?? branchOf(made)
  const current = await git($, ['rev-parse', '--abbrev-ref', 'HEAD'])

  if (!current.ok) return `The Fellowship could not read the branch: ${current.out}`

  // A quest taken up mid-task keeps the change it left; one setting out starts from a clean tree, its first commit its own
  if (current.out !== branch) {
    const dirty = await git($, ['status', '--porcelain'])

    if (dirty.out !== '') return `The working tree has uncommitted changes: commit or stash them, then set out. Each task's change is proven against HEAD and committed alone.`

    const exists = await git($, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
    const switched = await git($, exists.ok ? ['switch', branch] : ['switch', '-c', branch])

    if (!switched.ok) return `The Fellowship could not take the branch ${branch}: ${switched.out}`
  }

  const base = resumed?.base ?? (current.out === branch ? await defaultBranch($) : current.out)
  // A quest left mid-march has no member out any more: the person sends it again
  // Nor is Anárion still judging the whole branch: it is sailed for again
  const phase: FellowshipPhase = resumed === undefined ? 'ready' : resumed.phase === 'gazing' || resumed.phase === 'marching' || resumed.phase === 'proving' || resumed.phase === 'judging' ? 'stuck' : resumed.phase === 'warding' ? 'arrived' : resumed.phase

  await update($, quest, () => ({
    ref: made.ref,
    url: made.url,
    title: made.title,
    branch,
    base,
    isAuto,
    phase: isAllDone(made) && phase !== 'arrived' ? 'arrived' : phase,
    march: resumed?.march ?? null,
    proof: resumed?.proof ?? '',
    proofLine: resumed?.proofLine ?? '',
    verdictLine: resumed?.verdictLine ?? '',
    vision: resumed?.vision ?? null,
    gazed: resumed?.gazed,
    commits: resumed?.commits ?? [],
    pr: '',
    at: resumed?.at ?? Date.now(),
  }))
  await keep($, was => was)
  await update($, note, () => '')
  await $.ui.open({ id: PANE, title: TITLE }).catch(() => undefined)

  const now = await read($, quest)

  if (now?.phase === 'ready') await update($, wanted, () => 'next')
  if (now?.phase === 'arrived' && isAuto) await update($, wanted, () => 'sail')

  const how = isAuto ? 'going on by itself' : 'stopping after each commit for you'

  return resumed !== undefined
    ? `The Fellowship takes up its quest on ${made.ref} (${tally(made)}, ${now?.phase ?? phase}) on ${branch}, ${how}.`
    : `The Fellowship sets out on ${made.ref}, "${made.title}", on ${branch} from ${base}, ${how}: the first task is sent.`
}

/** What the project builds, as Argonath answers it: a member is chosen by the target its task is in. */
const targetsOf = async ($: $): Promise<Target[]> => {
  const got = await ask($, 'argonath', 'targets')

  try {
    return got.isError ? [] : (JSON.parse(got.text) as Target[])
  } catch {
    return []
  }
}

/** Sends a member on a task: marked doing in Elrond, chosen by the try and the task, and spawned with the plan around it. */
const march = async ($: $, made: FellowshipPlan, task: FellowshipTask, attempt: number, retry?: Retry): Promise<void> => {
  const member = memberFor(made, task, attempt, await targetsOf($))
  const last = (await read($, quest))?.march
  // A task sent again keeps HEAD as it was when it was first sent: a commit made past the proof since stays one
  const head = last !== null && last !== undefined && last.taskId === task.id && last.head !== undefined && last.head !== '' ? last.head : (await git($, ['rev-parse', 'HEAD'])).out

  await ask($, 'elrond', 'task', { id: task.id, state: 'doing' })

  const started = await $.agent
    .spawn({ subagentType: `fellowship:${member}`, description: `${MEMBERS[member].title}: task ${task.id}, ${task.title}`, prompt: companionPrompt(made, task, retry, (await read($, quest))?.vision) })
    .catch((error: unknown) => ({ deny: errorText(error), agentId: undefined }))

  if (started.deny !== undefined) {
    await keep($, was => ({ ...was, phase: 'stuck', march: null }))
    await update($, note, () => `${MEMBERS[member].title} could not be sent on task ${task.id}: ${started.deny}`)

    return
  }

  await keep($, was => ({ ...was, phase: 'marching', verdictLine: '', march: { taskId: task.id, title: task.title, member, agentId: started.agentId ?? '', attempt, at: Date.now(), answer: '', head, isResumed: false } }))
  await update($, note, () => '')
}

/** Sends the next task, or finds the quest arrived. A stuck task is sent again from its first rung, on what the tree holds. */
const sendNext = async ($: $): Promise<void> => {
  const held = await read($, quest)

  if (held === null || (held.phase !== 'ready' && held.phase !== 'stuck')) return

  const made = await readPlan($)

  if (made === null || typeof made === 'string') {
    await update($, note, () => (made === null ? 'Elrond holds no plan any more.' : made))

    return
  }

  if (isAllDone(made)) {
    await keep($, was => ({ ...was, phase: 'arrived', march: null }))

    if (held.isAuto) await update($, wanted, () => 'sail')
    else await tell($, `every task of ${made.ref} is committed: open the pull request from the pane`)

    return
  }

  const task = nextTask(made)

  if (task === undefined) {
    await keep($, was => ({ ...was, phase: 'stuck' }))
    await update($, note, () => `No task of ${made.ref} is ready: what is left depends on a task that is not done.`)

    return
  }

  // A task that is not light is shown first in the Mirror: Galadriel writes its tests, red, before anyone builds it
  if (task.weight !== 'light' && held.gazed !== task.id) return gazeOn($, made, task)

  const last = held.march?.taskId === task.id ? held.march : null
  const retry: Retry | undefined = last === null || held.proof === '' ? undefined : { attempt: 1, by: MEMBERS[last.member].title, answer: last.answer, proof: held.proof }

  await update($, working, () => `Sending a member on task ${task.id}…`)
  await march($, made, task, 1, retry)
}

/** Has Galadriel write a task's tests first. Where Lothlórien does not answer, the task is built without them. */
const gazeOn = async ($: $, made: FellowshipPlan, task: FellowshipTask): Promise<void> => {
  await update($, working, () => `Galadriel gazes on task ${task.id}…`)

  const sent = await ask($, 'lothlorien', 'gaze', { purpose: purposeOf(made, task), ref: made.ref, weight: task.weight })

  if (sent.isError || !/gazes/.test(sent.text)) {
    await keep($, was => ({ ...was, gazed: task.id, vision: null }))
    await update($, note, () => `The Mirror did not answer (${sent.text.slice(0, 160)}): task ${task.id} is built without tests first.`)
    await march($, made, task, 1)

    return
  }

  await keep($, was => ({ ...was, phase: 'gazing', gazed: task.id, vision: null, march: null }))
}

/** Looks into the Mirror while Galadriel gazes: once she has shown the tests, or that there are none, the task is built. */
const behold = async ($: $): Promise<void> => {
  const held = await read($, quest)

  if (held === null || held.phase !== 'gazing') return

  const answer = await ask($, 'lothlorien', 'mirror', { json: true })
  let shown: { state?: string; tests?: { file: string; name: string }[]; red?: string; why?: string } = {}

  try {
    shown = JSON.parse(answer.text) as typeof shown
  } catch {
    shown = { state: 'unreadable', why: answer.text.slice(0, 200) }
  }

  if (shown.state === 'gazing') return

  const made = await readPlan($)
  const task = made === null || typeof made === 'string' ? undefined : made.tasks.find(one => one.id === held.gazed)

  if (made === null || typeof made === 'string' || task === undefined) {
    await keep($, was => ({ ...was, phase: 'stuck' }))
    await update($, note, () => `The task the Mirror showed is not in the Elrond plan in force.`)

    return
  }

  if (shown.state === 'clouded' || shown.state === 'unreadable') {
    await keep($, was => ({ ...was, phase: 'stuck', gazed: undefined }))
    await update($, note, () => `The Mirror is clouded on task ${task.id}: ${shown.why ?? ''}. Send it again, and Galadriel gazes anew.`)
    await tell($, `the Mirror is clouded on task ${task.id}`)

    return
  }

  const vision = shown.state === 'shown' ? { taskId: task.id, tests: shown.tests ?? [], red: shown.red ?? '' } : null

  await keep($, was => ({ ...was, phase: 'ready', vision }))
  if (shown.state === 'empty') await update($, note, () => `Nothing to test first in task ${task.id}: ${shown.why ?? ''}`)
  await update($, working, () => `Sending a member on task ${task.id}…`)
  await march($, made, task, 1)
}

/**
 * Sends the task up a rung after a try that did not pass, with what stopped it; or, when Gandalf has tried it, stops
 * the quest for the person.
 */
const again = async ($: $, out: NonNullable<FellowshipQuest['march']>, why: { proof?: string; findings?: string[] }, line: string): Promise<void> => {
  // A proof that does not settle the change sends its member back once, with all it read and did, before a fresh
  // member a rung up starts over: what the statues find blocking goes up a rung at once
  // Where its spawn answered no id, the member is known by the type it runs as: the last of it sent
  const agentId = out.agentId !== '' ? out.agentId : ((await $.agent.list().catch(() => [])).filter(one => one.type === `fellowship:${out.member}`).at(-1)?.id ?? '')

  if (why.proof !== undefined && out.isResumed !== true && agentId !== '') {
    const sent = await $.session.send({ to: { agentId }, text: resumePrompt(why.proof) }).catch(() => undefined)

    if (sent?.isDelivered === true) {
      await keep($, was => ({ ...was, phase: 'marching', march: { ...out, isResumed: true, answer: '' } }))
      await update($, note, () => `${MEMBERS[out.member].title} is sent back to task ${out.taskId} with the proof: ${line}`)

      return
    }
  }

  const made = await readPlan($)
  const task = made === null || typeof made === 'string' ? undefined : made.tasks.find(one => one.id === out.taskId)

  if (typeof made === 'object' && made !== null && task !== undefined && out.attempt < triesOf(made, task)) {
    await march($, made, task, out.attempt + 1, { attempt: out.attempt + 1, by: MEMBERS[out.member].title, answer: out.answer, ...why })

    return
  }

  await keep($, was => ({ ...was, phase: 'stuck' }))
  await update($, note, () => `Task ${out.taskId} did not pass after ${out.attempt} ${out.attempt === 1 ? 'try' : 'tries'}, the last ${MEMBERS[out.member].title}'s: ${line}. Finish it by hand and commit, or send it again.`)
  await tell($, `task ${out.taskId} is stuck: ${line}`)
}

/**
 * Why the change in the tree cannot be taken as the task's: HEAD moved since the task was first sent, so a commit was
 * made past the proof and the statues. Nothing when it did not.
 */
const headMoved = async ($: $, out: NonNullable<FellowshipQuest['march']>): Promise<string | undefined> => {
  if (out.head === undefined || out.head === '') return undefined

  const now = (await git($, ['rev-parse', 'HEAD'])).out

  return now === out.head
    ? undefined
    : `HEAD moved from ${out.head.slice(0, 7)} to ${now.slice(0, 7)} while task ${out.taskId} was out: a commit was made past the Argonath's proof and its statues. Put it back as uncommitted work (git reset --soft ${out.head.slice(0, 7)}), then put it before the Argonath again.`
}

/** Stops the quest on a task for the person, saying why. */
const stop = async ($: $, out: NonNullable<FellowshipQuest['march']>, why: string): Promise<void> => {
  await keep($, was => ({ ...was, phase: 'stuck' }))
  await update($, note, () => why)
  await tell($, `task ${out.taskId} is stuck: ${why}`)
}

/** Proves what a member built: settled, the statues of the Argonath are sent to judge it; else the task goes up a rung. */
const prove = async ($: $): Promise<void> => {
  const held = await read($, quest)

  if (held === null || held.phase !== 'proving' || held.march === null) return

  const out = held.march
  const moved = await headMoved($, out)

  if (moved !== undefined) return stop($, out, moved)

  await update($, working, () => `Argonath proves task ${out.taskId}…`)

  // The statues are convened here, on the change and what it is for: the proof owes none at the turn's end
  const proof = await ask($, 'argonath', 'prove', { owe: false, json: true })
  const verdict = proof.isError ? { isSettled: false, isUnlooked: true, line: proof.text, unhandled: [] as string[], text: proof.text } : proofVerdict(proof.text)

  await keep($, was => ({ ...was, proof: verdict.text, proofLine: verdict.line, unproven: verdict.unhandled }))

  // Argonath could not look at what the change reached: no member mends that, and no try is spent on it
  if (verdict.isUnlooked) return stop($, out, `${verdict.line}. No member can mend that: set the target right in .claude/argonath, then put task ${out.taskId} before the Argonath again.`)
  if (!verdict.isSettled) return again($, out, { proof: verdict.text }, verdict.line)

  const mirror = held.vision?.taskId === out.taskId ? await mirrorOf($) : { amendments: [], tampered: [] }

  // What was taken out of Galadriel's tests without a reason blocks the change, as a finding would
  if (mirror.tampered.length > 0) {
    const findings = mirror.tampered.map(one => `- Lothlórien, ${one.file}: locked lines of Galadriel's tests were taken out with no reason given (${one.lines.slice(0, 2).map(line => `\`${line.trim()}\``).join(', ')}). Put them back, or call mcp__lothlorien__amend with the file and why before changing them.`)

    return again($, out, { findings }, `${findings.length} of Galadriel's test ${findings.length === 1 ? 'file' : 'files'} changed with no reason`)
  }

  await update($, working, () => `The statues of the Argonath are sent to judge task ${out.taskId}…`)

  const made = await readPlan($)
  const task = made === null || typeof made === 'string' ? undefined : made.tasks.find(one => one.id === out.taskId)
  const about = made === null || typeof made === 'string' || task === undefined ? '' : purposeOf(made, task, mirror.amendments)
  // Where nothing proves what the change reached, both statues judge it; else as the task's weight and risks ask
  const statues = made === null || typeof made === 'string' || task === undefined || verdict.unhandled.length > 0 ? ['isildur', 'anarion'] : statuesFor(made, task)
  const judged = parseJudgement((await ask($, 'argonath', 'judgement', { convene: true, json: true, about, statues })).text)

  await keep($, was => ({ ...was, phase: 'judging', verdictLine: judged.line }))
  await settle($, judged)
}

/** What a member changed of Galadriel's tests and why, and what was taken out of them with no reason, as Lothlórien keeps it. */
const mirrorOf = async ($: $): Promise<{ amendments: { file: string; why: string; by: string }[]; tampered: { file: string; lines: string[] }[] }> => {
  try {
    const shown = JSON.parse((await ask($, 'lothlorien', 'mirror', { json: true })).text) as { amendments?: { file: string; why: string; by: string }[]; tampered?: { file: string; lines: string[] }[] }

    return { amendments: Array.isArray(shown.amendments) ? shown.amendments : [], tampered: Array.isArray(shown.tampered) ? shown.tampered : [] }
  } catch {
    return { amendments: [], tampered: [] }
  }
}

/** Looks at the statues' judgement of the change, while they sit. */
const judge = async ($: $): Promise<void> => {
  const held = await read($, quest)

  if (held === null || held.phase !== 'judging') return

  await settle($, parseJudgement((await ask($, 'argonath', 'judgement', { json: true })).text))
}

/** What the statues' verdict comes to: committed when they pass the change, sent back up a rung when they find what blocks it. */
const settle = async ($: $, judged: ReturnType<typeof parseJudgement>): Promise<void> => {
  const held = await read($, quest)

  if (held === null || held.phase !== 'judging' || held.march === null) return

  const out = held.march

  await keep($, was => ({ ...was, verdictLine: judged.line }))

  if (judged.verdict === 'sitting') return
  if (judged.verdict === 'pass') return void (await commitNow($, judged.minor))
  if (judged.verdict === 'fail') return again($, out, { findings: judged.blocking }, judged.line)

  // The change moved while they sat, or they never sat on it: it is proved and judged afresh
  if (judged.verdict === 'stale' || judged.verdict === 'unsettled' || judged.verdict === 'none') {
    await keep($, was => ({ ...was, phase: 'proving' }))
    await update($, wanted, () => 'prove')

    return
  }

  await keep($, was => ({ ...was, phase: 'stuck' }))
  await update($, note, () => `The statues could not judge task ${out.taskId}: ${judged.line}. Commit it once they can, or send it again.`)
  await tell($, `task ${out.taskId} was not judged: ${judged.line}`)
}

/** Commits the change the statues passed as the task's own, and goes on. Answers what was done, in a sentence. */
const commitNow = async ($: $, minor: readonly string[]): Promise<string> => {
  const held = await read($, quest)

  if (held === null || held.march === null) return 'There is nothing to commit.'

  const out = held.march
  const made = await readPlan($)
  const task = made === null || typeof made === 'string' ? undefined : made.tasks.find(one => one.id === out.taskId)

  if (task === undefined || made === null || typeof made === 'string') {
    await keep($, was => ({ ...was, phase: 'stuck' }))

    return `Task ${out.taskId} is not in the Elrond plan in force: ${typeof made === 'string' ? made : 'set out again.'}`
  }

  // The statues judged the change against HEAD as it was sent: a commit made since was judged by no one
  const moved = await headMoved($, out)

  if (moved !== undefined) {
    await stop($, out, moved)

    return moved
  }

  await update($, working, () => `Committing task ${task.id}…`)

  const by = MEMBERS[out.member].title
  const unproven = held.unproven ?? []
  const dirty = await git($, ['status', '--porcelain'])
  let sha = ''

  // A task that needed no change is done with no commit
  if (dirty.out !== '') {
    const added = await git($, ['add', '-A'])
    const done = added.ok ? await git($, ['commit', '-m', commitMessage(made, task, by, minor, unproven)]) : added

    if (!done.ok) {
      await keep($, was => ({ ...was, phase: 'stuck' }))
      await update($, note, () => `Task ${task.id} could not be committed: ${done.out}`)

      return `Task ${task.id} could not be committed: ${done.out}`
    }

    sha = (await git($, ['rev-parse', 'HEAD'])).out
  }

  await ask($, 'elrond', 'task', { id: task.id, state: 'done' })

  const after = await keep($, was => ({ ...was, phase: 'ready', march: null, vision: null, proof: '', proofLine: '', verdictLine: '', unproven: [], isWarded: false, commits: [...was.commits, { taskId: task.id, title: task.title, sha, by, minor: [...minor], unproven: [...unproven] }] }))
  const left = await readPlan($)
  const isArrived = typeof left === 'object' && left !== null && isAllDone(left)
  const said = `Task ${task.id}, "${task.title}", built by ${by}, passed the Argonath and is committed${sha === '' ? ' (it changed nothing, so it is marked done with no commit)' : ` as ${sha.slice(0, 7)}`}.`

  if (isArrived || after?.isAuto === true) await update($, wanted, () => 'next')
  else await tell($, `${said} The next task waits for you.`)

  return said
}

/** Puts a stuck task's change before the Argonath again: proved, judged, and committed once the statues pass it. */
const resubmit = async ($: $): Promise<string> => {
  const held = await read($, quest)

  if (held === null) return HOW_TO
  if (held.march === null || held.phase !== 'stuck') return `There is nothing to put before the Argonath: the quest is ${held.phase}.`

  await keep($, was => ({ ...was, phase: 'proving' }))
  await update($, wanted, () => 'prove')

  return `Task ${held.march.taskId}'s change goes before the Argonath: it is proved, judged by the statues, and committed once they pass it.`
}
/** What a quest that is out waits on before it may be abandoned; nothing when it waits on nothing. */
const waitBeforeAbandon = (held: FellowshipQuest): string | undefined =>
  held.phase === 'gazing' || held.phase === 'marching' || held.phase === 'proving' || held.phase === 'judging' || held.phase === 'warding'
    ? `The quest is ${held.phase}: wait until ${held.phase === 'gazing' ? 'Galadriel has shown the tests' : held.phase === 'judging' || held.phase === 'warding' ? 'the statues have judged' : held.phase === 'proving' ? 'the proof is made' : `${held.march === null ? 'the member' : MEMBERS[held.march.member].title} is back`}, then abandon it.`
    : undefined

/**
 * Gives the quest up: its tasks reopened in Elrond, its local branch deleted from the branch it set out from, and the
 * quest forgotten here and across sessions, so the plan can be set out on afresh. Nothing on the forge is touched.
 */
const abandon = async ($: $): Promise<string> => {
  const made = await readPlan($)
  const held = (await read($, quest)) ?? (typeof made === 'object' && made !== null ? ((await $.store.get(STORE_KEY(made.ref)).catch(() => undefined)) as FellowshipQuest | undefined) ?? null : null)

  if (held === null) return 'No quest is kept: there is nothing to abandon.'

  const waiting = waitBeforeAbandon(held)

  if (waiting !== undefined) return waiting

  const current = await git($, ['rev-parse', '--abbrev-ref', 'HEAD'])

  if (!current.ok) return `The Fellowship could not read the branch: ${current.out}`

  // Leaving the quest's branch carries what is uncommitted along: work left there is the person's to keep or drop first
  if (current.out === held.branch) {
    const dirty = await git($, ['status', '--porcelain'])

    if (dirty.out !== '') return `${held.branch} has uncommitted changes: commit, stash or drop them, then abandon the quest.`

    const back = await git($, ['switch', held.base])

    if (!back.ok) return `The Fellowship could not go back to ${held.base}: ${back.out}`
  }

  const exists = await git($, ['rev-parse', '--verify', '--quiet', `refs/heads/${held.branch}`])
  const deleted = exists.ok ? await git($, ['branch', '-D', held.branch]) : { ok: true, out: '' }

  // The tasks it took up are open again in the plan, which can be set out on as it is
  const reopened = typeof made === 'object' && made !== null && made.ref === held.ref ? made.tasks.filter(task => task.state !== 'todo') : []

  for (const task of reopened) await ask($, 'elrond', 'task', { id: task.id, state: 'todo' })

  await update($, quest, () => null)
  await $.store.delete(STORE_KEY(held.ref)).catch(() => undefined)
  await update($, note, () => '')
  await update($, wanted, () => '')
  if (reopened.length > 0) await readPlan($)

  return [
    `The quest on ${held.ref} is abandoned.`,
    deleted.ok ? (exists.ok ? `${held.branch} is deleted, with its ${held.commits.length} ${held.commits.length === 1 ? 'commit' : 'commits'}.` : `${held.branch} was already gone.`) : `${held.branch} could not be deleted: ${deleted.out}.`,
    reopened.length > 0 ? `${reopened.length} ${reopened.length === 1 ? 'task is' : 'tasks are'} open again in the Elrond plan.` : '',
    held.pr !== '' ? `Its pull request, ${held.pr}, is left as it is on the forge.` : '',
  ]
    .filter(line => line !== '')
    .join(' ')
}

/** Pushes a branch and opens a pull request from it with the forge's CLI: its URL, or why it could not be. */
const openRequest = async ($: $, branch: string, argv: readonly string[]): Promise<{ url: string } | string> => {
  await update($, working, () => `Pushing ${branch}…`)

  const pushed = await $.process.run(['git', 'push', '-u', 'origin', branch], { cwd: await $.session.cwd(), timeoutMs: FORGE_TIMEOUT_MS }).catch((error: unknown) => ({ exitCode: -1, stdout: '', stderr: errorText(error) }))

  if (pushed.exitCode !== 0) return `${branch} could not be pushed: ${pushed.stderr.trim() || `git exited with ${pushed.exitCode}`}`

  await update($, working, () => 'Opening the pull request…')

  const opened = await $.process.run(argv, { cwd: await $.session.cwd(), timeoutMs: FORGE_TIMEOUT_MS }).catch((error: unknown) => ({ exitCode: -1, stdout: '', stderr: errorText(error) }))

  if (opened.exitCode !== 0) return `The pull request could not be opened: ${argv[0] ?? ''} said ${opened.stderr.trim() || `it exited with ${opened.exitCode}`}`

  return { url: [...`${opened.stdout}\n${opened.stderr}`.matchAll(/https?:\/\/\S+/g)].map(found => found[0]).pop() ?? '' }
}

/** Pushes the branch and opens the pull request that closes the issue. */
const sail = async ($: $): Promise<string> => {
  const held = await read($, quest)

  if (held === null) return HOW_TO
  if (held.phase === 'sailed') return `The pull request is open: ${held.pr}`
  if (held.phase === 'warding') return `Anárion judges the whole branch of ${held.ref}: the pull request opens once he passes it.`
  if (held.phase !== 'arrived') return `The quest has not arrived: it is ${held.phase}. Every task is committed first.`

  const made = await readPlan($)

  if (made === null || typeof made === 'string') return made ?? 'Elrond holds no plan any more.'

  // Each task was judged alone: Anárion judges what they let in together, once, before the branch leaves the machine
  if (held.isWarded !== true) {
    const judged = parseJudgement((await ask($, 'argonath', 'judgement', { convene: true, json: true, statues: ['anarion'], against: held.base, about: wardPurpose(made) })).text)

    await keep($, was => ({ ...was, phase: 'warding', verdictLine: judged.line }))

    return ward($, judged)
  }

  const opened = await openRequest($, held.branch, prArgv(made, held))

  if (typeof opened !== 'object') return opened

  const url = opened.url

  await keep($, was => ({ ...was, phase: 'sailed', pr: url }))
  await tell($, `the pull request for ${held.ref} is open${url === '' ? '' : `: ${url}`}`)

  return `The Fellowship has sailed: ${held.branch} is pushed and the pull request that closes ${held.ref} is open${url === '' ? '' : ` at ${url}`}.`
}

/**
 * What Anárion's judgement of the whole branch comes to: it sails once he passes it; what he finds blocking, or his
 * silence, stops it for the person. Answers what was done, in a sentence.
 */
const ward = async ($: $, judged: ReturnType<typeof parseJudgement>): Promise<string> => {
  const held = await read($, quest)

  if (held === null || held.phase !== 'warding') return ''
  if (judged.verdict === 'sitting') return `Anárion judges the whole branch of ${held.ref} before it sails: the pull request opens once he passes it.`

  if (judged.verdict === 'pass') {
    await keep($, was => ({ ...was, phase: 'arrived', isWarded: true, verdictLine: `the whole branch ${judged.line}` }))

    return sail($)
  }

  const why =
    judged.verdict === 'fail'
      ? `Anárion found what blocks the whole branch of ${held.ref}:\n${judged.blocking.join('\n')}\nFix it and commit, then sail again: he judges the branch as it then stands.`
      : `Anárion could not judge the whole branch of ${held.ref} (${judged.line}): sail again to have him judge it.`

  await keep($, was => ({ ...was, phase: 'arrived', isWarded: false, verdictLine: `the whole branch: ${judged.line}` }))
  await update($, note, () => why)
  await tell($, why.split('\n')[0] ?? why)

  return why
}

/** Looks at Anárion's judgement of the whole branch, while he sits. */
const watchWard = async ($: $): Promise<void> => {
  const said = await ward($, parseJudgement((await ask($, 'argonath', 'judgement', { json: true })).text))

  if (said !== '' && !said.startsWith('Anárion judges')) await update($, note, () => said)
}

// Whether the clock is doing what was asked: a proof takes minutes, and the next tick waits for it
let isBusy = false
// Ticks since the statues' judgement was last looked at
let ticks = 0

/** Does what a press or a turn asked for, one thing at a time; and while the statues sit, looks at their judgement now and then. */
const tick = async ($: $): Promise<void> => {
  if (isBusy) return

  const asked = await read($, wanted)

  if (asked === '') {
    ticks += 1
    const phase = (await read($, quest))?.phase

    if (ticks % JUDGE_EVERY !== 0 || (phase !== 'judging' && phase !== 'gazing' && phase !== 'warding')) return
  }

  isBusy = true
  if (asked !== '') await update($, wanted, () => '')

  try {
    const phase = (await read($, quest))?.phase

    if (asked === '') await (phase === 'gazing' ? behold($) : phase === 'warding' ? watchWard($) : judge($))
    else if (asked === 'next') await sendNext($)
    else if (asked === 'prove') await prove($)
    else {
      const said = asked === 'set out' || asked === 'set out auto' ? await setOut($, asked === 'set out auto') : asked === 'abandon' ? await abandon($) : await sail($)

      // A command typed answers before it is done: what came of it is told as well as kept in the pane
      $.ui.toast(`Fellowship: ${said}`)
      await update($, note, () => said)
    }
  } catch (error) {
    await update($, note, () => `The Fellowship stumbled: ${errorText(error)}`)
  } finally {
    isBusy = false
    await update($, working, () => '')
  }
}

/** Runs a call that is not the clock's, holding the clock off it. */
const alone = async <T,>($: $, run: () => Promise<T>): Promise<T> => {
  isBusy = true

  try {
    return await run()
  } finally {
    isBusy = false
    await update($, working, () => '')
  }
}

/** Whether an agent is the member out: by the id its spawn answered, else, where it answered none, by its type. */
const isCompanion = async ($: $, held: FellowshipQuest | null, agentId: string): Promise<boolean> => {
  if (held === null || held.march === null) return false

  const out = held.march

  return out.agentId !== '' ? agentId === out.agentId : (await $.agent.list().catch(() => [])).some(one => one.id === agentId && one.type === `fellowship:${out.member}` && one.status === 'running')
}

const sectionText = (held: FellowshipQuest): string =>
  `The Fellowship mod is on a quest: the Elrond plan for ${held.ref}, built task by task on ${held.branch} by its members, each change proven and judged by the Argonath and committed alone. It is ${held.phase}. Leave the working tree to the member out; mcp__fellowship__quest says where the quest stands.`

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'fellowship', description: 'Build the Elrond plan task by task: /fellowship sets out (--auto goes on by itself); next, commit, sail, halt, abandon' })

    for (const [name, member] of Object.entries(MEMBERS) as [FellowshipMember, (typeof MEMBERS)[FellowshipMember]][]) {
      await $.agent
        .register({
          name,
          description: `${member.title} of the Fellowship: builds one task of an Elrond plan in the working tree, proven and judged by the Argonath. Sent by the Fellowship mod alone.`,
          prompt: memberSystem(name),
          tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash', 'mcp__argonath__radius', 'mcp__argonath__prove', 'mcp__lothlorien__amend'],
          permissionMode: 'acceptEdits',
          disallowedTools: ['Agent', 'mcp__elrond__task', 'mcp__argonath__judgement', 'mcp__fellowship__commit'],
          model: member.model,
          effort: member.effort,
        })
        .catch(() => undefined)
    }

    // A host that registers no tools still starts the session
    for (const tool of [view.tool, ...TOOLS]) await $.tool.register(tool).catch(() => undefined)

    $.clock.every(TICK_MS, () => void tick($).catch(() => undefined))

    // A reload loads the module afresh: a pane drawn by the copy before it is drawn again, so its buttons press this one
    $.ui.invalidate('ui.render')

    return next(e)
  })

  // A member is sent by the Fellowship, never through the Agent tool
  for (const name of Object.keys(MEMBERS)) on('agent.offer', { agent: `fellowship:${name}` }, () => ({ isOffered: false }))

  // The member's turn has ended: what it built is proven, outside this hook
  on('turn.complete', async ($, e, next) => {
    const held = await read($, quest)

    if (held?.phase === 'marching' && held.march !== null && e.agentId !== undefined && (await isCompanion($, held, e.agentId))) {
      const out = { ...held.march, answer: e.answer ?? '' }
      const title = MEMBERS[out.member].title
      const revise = out.member === 'gandalf' ? out.answer.split('\n').find(line => line.trim().startsWith(REVISE)) : undefined

      if (e.isAborted || e.reason !== 'answer') {
        await keep($, was => ({ ...was, phase: 'stuck', march: out }))
        await update($, note, () => `${title} on task ${out.taskId} ${e.isAborted ? 'was interrupted' : e.reason === 'refusal' ? 'refused' : 'ended on an API error'}: send it again from the pane.`)
      } else if (revise !== undefined) {
        await keep($, was => ({ ...was, phase: 'stuck', march: out }))
        await update($, note, () => `Gandalf stops on task ${out.taskId}. ${revise.trim()} Revise the plan in the Elrond pane, then send it again.`)
        await tell($, `Gandalf says the plan must be revised at task ${out.taskId}`)
      } else {
        await keep($, was => ({ ...was, phase: 'proving', march: out }))
        await update($, wanted, () => 'prove')
      }
    }

    return next(e)
  })

  // The member builds its task, and leaves the branch, the commits and the plan to the Fellowship
  on('tool.call', async ($, e, next) => {
    const agentId = (e as { agentId?: string }).agentId

    if (agentId === undefined || !(await isCompanion($, await read($, quest), agentId))) return next(e)

    const given = e as unknown as { tool: string; command?: unknown; file_path?: unknown; notebook_path?: unknown }

    if (given.tool === 'Bash' && typeof given.command === 'string' && isForbiddenGit(given.command)) return { deny: 'The Fellowship commits and keeps the branch: leave your change uncommitted, and run no git command that moves HEAD or the index.' }

    const path = typeof given.file_path === 'string' ? given.file_path : typeof given.notebook_path === 'string' ? given.notebook_path : undefined

    if (path !== undefined) {
      const root = await rootOf($)
      const march = (await read($, quest))?.march
      const task = march === null || march === undefined ? undefined : (await read($, plan))?.tasks.find(one => one.id === march.taskId)

      if (isModPath(root, path)) return { deny: 'That folder belongs to a mod: a member changes the project, not what the mods keep.' }
      if (isModSource(root, path, task)) return { deny: "That is a mod's source, and your task is not about a mod: say in your account what of it stood in your way, and leave it as it is." }
    }

    return next(e)
  })

  // Claude is told of the quest while it is under way
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const held = await read($, quest)

    return held === null || held.phase === 'sailed' ? composed : { sections: [...composed.sections, { id: 'fellowship:quest', text: sectionText(held), scope: 'session' as const }] }
  })

  on('tool.call', { tool: 'mcp__fellowship__pane' }, $ => view.answer(() => $.ui.panes()))

  on('tool.call', { tool: 'mcp__fellowship__set_out' }, async ($, e) => ({ result: await alone($, () => setOut($, (e as unknown as { auto?: unknown }).auto === true)) }))

  on('tool.call', { tool: 'mcp__fellowship__quest' }, async $ => {
    const held = await read($, quest)

    if (held === null) return { result: HOW_TO }

    const made = await readPlan($)

    return { result: questText(held, typeof made === 'string' ? await read($, plan) : made) }
  })

  on('tool.call', { tool: 'mcp__fellowship__commit' }, async $ => ({ result: await resubmit($) }))

  on('tool.call', { tool: 'mcp__fellowship__relics' }, async $ => ({ result: JSON.stringify(await relics($)) }))

  on('tool.call', { tool: 'mcp__fellowship__forget' }, async ($, e) => {
    const given = e as unknown as { ref?: unknown; pr?: unknown; json?: unknown }
    const done = await forget($, String(given.ref ?? ''), String(given.pr ?? ''))

    return { result: given.json === true ? JSON.stringify(done) : done.text }
  })

  // Pushing and opening the pull request reach outside the machine: no tool offers them to Claude. The person sails with
  // /fellowship sail or the pane, or opted into it up front with --auto
  on('command.run', { command: 'fellowship' }, async ($, e) => {
    const words = e.args.trim().split(/\s+/).filter(word => word !== '')
    const isAuto = words.includes('--auto')
    const verb = words.find(word => !word.startsWith('--')) ?? ''
    const held = await read($, quest)

    await $.ui.open({ id: PANE, title: TITLE })

    // Abandoning deletes a branch: the person types it, and no tool offers it to Claude
    if (verb === 'abandon') {
      const waiting = held === null ? undefined : waitBeforeAbandon(held)

      if (waiting !== undefined) return { text: waiting }
      await update($, wanted, () => 'abandon')

      return { text: 'The quest is being abandoned: the pane says how it went.' }
    }

    if (verb === 'halt') {
      await keep($, was => ({ ...was, isAuto: false }))

      return { text: held === null ? HOW_TO : 'The Fellowship stops after the task it is on: send the next from the pane, or /fellowship next.' }
    }

    if (verb === 'next') {
      if (held === null || (held.phase !== 'ready' && held.phase !== 'stuck')) return { text: held === null ? HOW_TO : `The quest is ${held.phase}: no task is sent now.` }
      await update($, wanted, () => 'next')

      return { text: 'A member is sent on the next task.' }
    }

    if (verb === 'commit') return { text: await resubmit($) }
    if (verb === 'sail') {
      await update($, wanted, () => 'sail')

      return { text: 'The Fellowship makes ready to sail: the pane says how it went.' }
    }
    if (verb !== '') return { text: `/fellowship knows set out (no word, or --auto), next, commit, sail, halt and abandon; not ${verb}.` }

    // A quest under way is shown; any other sets out
    if (held !== null && held.phase !== 'sailed' && !isAuto) return { text: questText(held, await read($, plan)) }

    // Setting out, sailing and abandoning read the plan from Elrond: a call made beneath a command's hooks is not answered
    // by Elrond's, which sit in the same chain, so the clock makes them
    await update($, wanted, () => (isAuto ? 'set out auto' : 'set out'))

    return { text: `The Fellowship sets out on the Elrond plan${isAuto ? ', going on by itself' : ''}: the pane says how it went.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const held = await read($, quest)
    const made = await read($, plan)
    const problem = await read($, note)
    const busy = await read($, working)
    const asked = await read($, wanted)
    const press = (what: FellowshipWanted) => update($, wanted, () => what)

    const status = (
      <Box flexDirection="column">
        {busy !== '' && <Text color="suggestion">{busy}</Text>}
        {asked !== '' && busy === '' && <Text dimColor>{`${asked}…`}</Text>}
        {problem !== '' && <Text color="warning">{problem}</Text>}
      </Box>
    )

    if (held === null) {
      return view.keep(
        <Box flexDirection="column" gap={1}>
          {badge({ label: 'no quest', tone: 'neutral' })}
          {status}
          <Text dimColor>{HOW_TO}</Text>
          <Button key="set-out" hotkey="s" variant="primary" onPress={() => press('set out')}>
            Set out on the Elrond plan
          </Button>
        </Box>,
      )
    }

    const out = held.march
    const commitOf = (id: number) => held.commits.find(one => one.taskId === id)
    const outTask = out === null || made === null ? undefined : made.tasks.find(task => task.id === out.taskId)

    return view.keep(
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={2}>
          {badge({ label: held.phase, tone: PHASE_TONE[held.phase] })}
          {made !== null && badge({ label: tally(made), tone: isAllDone(made) ? 'success' : 'info' })}
          <Text bold wrap="truncate-end">{held.title}</Text>
        </Box>
        <Text dimColor>{`${held.ref} · ${held.branch} ← ${held.base}${held.isAuto ? ' · auto' : ''}`}</Text>
        {status}
        {made !== null && (
          <Box flexDirection="column" borderStyle="round" paddingX={1}>
            {made.tasks.map(task => (
              <Text key={`task-${task.id}`} color={out?.taskId === task.id ? 'suggestion' : task.state === 'done' ? 'success' : undefined} dimColor={task.state === 'todo' && out?.taskId !== task.id}>
                {`${MARK[task.state]} ${task.id}. ${task.title}  · ${task.weight}${commitOf(task.id) !== undefined ? ` · ${commitOf(task.id)?.by ?? ''} ${commitOf(task.id)?.sha.slice(0, 7) || 'no change'}` : ''}${out?.taskId === task.id ? ` · ${MEMBERS[out.member].title}, ${held.phase}` : ''}`}
              </Text>
            ))}
          </Box>
        )}
        {held.phase === 'gazing' && <Text color="suggestion">{`Galadriel gazes into the Mirror: task ${held.gazed ?? ''}'s tests are written first, red`}</Text>}
        {held.phase === 'warding' && <Text color="suggestion">Anárion judges the whole branch before it sails</Text>}
        {out === null && held.verdictLine.startsWith('the whole branch') && <Text color={held.isWarded === true ? 'success' : 'warning'}>{`The statues: ${held.verdictLine}`}</Text>}
        {held.vision !== undefined && held.vision !== null && held.vision.tests.length > 0 && <Text dimColor>{`The Mirror: ${held.vision.tests.length} red ${held.vision.tests.length === 1 ? 'test' : 'tests'} for task ${held.vision.taskId} to make pass`}</Text>}
        {out !== null && (
          <Box flexDirection="column" borderStyle="round" paddingX={1}>
            <Text bold>{`${MEMBERS[out.member].title} on task ${out.taskId}: ${out.title}`}</Text>
            <Text dimColor>{`try ${out.attempt}${made !== null && outTask !== undefined ? ` of ${triesOf(made, outTask)}` : ''} · since ${new Date(out.at).toLocaleTimeString()}`}</Text>
            {held.proofLine !== '' && <Text color={held.phase === 'judging' ? 'success' : 'warning'}>{`Argonath's proof: ${held.proofLine}`}</Text>}
            {held.verdictLine !== '' && <Text color={held.verdictLine.startsWith('passed') ? 'success' : held.verdictLine === 'judging' ? 'suggestion' : 'warning'}>{`The statues: ${held.verdictLine}`}</Text>}
          </Box>
        )}
        {held.pr !== '' && <Text color="success">{`Pull request: ${held.pr}`}</Text>}
        <Box flexDirection="row" gap={1}>
          {(held.phase === 'ready' || held.phase === 'stuck') && (
            <Button key="next" hotkey="n" variant="primary" onPress={() => press('next')}>
              {held.phase === 'stuck' ? 'Send again' : 'Send the next task'}
            </Button>
          )}
          {held.phase === 'stuck' && out !== null && (
            <Button key="commit" hotkey="c" onPress={() => resubmit($).then(said => update($, note, () => said))}>
              Put it before the Argonath
            </Button>
          )}
          {held.phase === 'arrived' && (
            <Button key="sail" hotkey="p" variant="primary" onPress={() => press('sail')}>
              Push and open the pull request
            </Button>
          )}
          {held.phase !== 'sailed' && (
            <Button key="auto" hotkey="a" onPress={() => keep($, was => ({ ...was, isAuto: !was.isAuto })).then(() => undefined)}>
              {held.isAuto ? '✓ Going on by itself' : 'Go on by itself'}
            </Button>
          )}
        </Box>
      </Box>,
    )
  })
}
