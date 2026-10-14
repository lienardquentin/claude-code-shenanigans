import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { FellowshipPhase, FellowshipPlan, FellowshipQuest, FellowshipTask, FellowshipWanted } from '../types'
import { COMPANION_SYSTEM, HOW_TO, MARK, MAX_ATTEMPTS, branchOf, commitMessage, companionPrompt, isAllDone, isForbiddenGit, isModPath, nextTask, parsePlan, prArgv, proofVerdict, provenText, questText, tally, unsettledOf } from './quest'
import { badge } from './kit/badge'
import type { Tone } from './kit/badge'
import { paneView } from './kit/pane-text'

type $ = EngineInterface

const PANE = 'fellowship'
const TITLE = 'Fellowship'
const AGENT = 'companion'
const AGENT_TYPE = `fellowship:${AGENT}`
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
      'Sets the Fellowship out on the Elrond plan in force: on a branch of its own, it sends a companion subagent to build each task in turn in the working tree, has Argonath prove each change, and commits it once proven; at the end it opens the pull request that closes the issue. It sets out only once every question of the plan is answered and every risk decided. Call it when the person asks to implement a planned issue.',
    inputSchema: { type: 'object', properties: { auto: { type: 'boolean', description: 'Go on by itself: send each task once the one before is committed, and open the pull request at the end. Only when the person asked for it.' } } },
  },
  {
    name: 'quest',
    description: "Where the Fellowship's quest stands: its phase, the companion out, Argonath's last proof, and each task with its commit.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'commit',
    description: "Proves the uncommitted change of the task the Fellowship's companion built once more, and commits it if every changed run is pinned; then sends the next task on an auto quest. Call it once Argonath's reviews of the change have answered and their findings are addressed.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'sail',
    description: "Pushes the quest's branch and opens the pull request (a merge request on GitLab) that closes the issue, once every task is committed. It reaches outside the machine: call it only when the person asks to.",
    inputSchema: { type: 'object', properties: {} },
  },
] as const

const PHASE_TONE: Record<FellowshipPhase, Tone> = { ready: 'neutral', marching: 'info', proving: 'info', proven: 'success', stuck: 'danger', arrived: 'accent', sailed: 'success' }

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
  // A quest left mid-march has no companion out any more: the person sends it again
  const phase: FellowshipPhase = resumed === undefined ? 'ready' : resumed.phase === 'marching' || resumed.phase === 'proving' ? 'stuck' : resumed.phase

  await update($, quest, () => ({
    ref: made.ref,
    url: made.url,
    title: made.title,
    branch,
    base,
    isAuto,
    phase: isAllDone(made) && phase !== 'arrived' && phase !== 'proven' ? 'arrived' : phase,
    march: resumed?.march ?? null,
    proof: resumed?.proof ?? '',
    proofLine: resumed?.proofLine ?? '',
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
    : `The Fellowship sets out on ${made.ref}, "${made.title}", on ${branch} from ${base}, ${how}: a companion is sent on the first task.`
}

/** Sends a companion on a task: marked doing in Elrond, and spawned with the plan around it. */
const march = async ($: $, made: FellowshipPlan, task: FellowshipTask, attempt: number, retry?: { answer: string; proof: string }): Promise<void> => {
  await ask($, 'elrond', 'task', { id: task.id, state: 'doing' })

  const started = await $.agent
    .spawn({ subagentType: AGENT_TYPE, description: `Task ${task.id}: ${task.title}`, prompt: companionPrompt(made, task, retry === undefined ? undefined : { attempt, ...retry }) })
    .catch((error: unknown) => ({ deny: errorText(error), agentId: undefined }))

  if (started.deny !== undefined) {
    await keep($, was => ({ ...was, phase: 'stuck', march: null }))
    await update($, note, () => `A companion could not be sent on task ${task.id}: ${started.deny}`)

    return
  }

  await keep($, was => ({ ...was, phase: 'marching', march: { taskId: task.id, title: task.title, agentId: started.agentId ?? '', attempt, at: Date.now(), answer: '' } }))
  await update($, note, () => '')
}

/** Sends the next task, or finds the quest arrived. */
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

  // A task sent again carries on from what its last companion left in the tree
  const isAgain = held.march?.taskId === task.id && held.proof !== ''

  await update($, working, () => `Sending a companion on task ${task.id}…`)
  await march($, made, task, 1, isAgain ? { answer: held.march?.answer ?? '', proof: held.proof } : undefined)
}

/** Proves what a companion built: settled, Claude is woken for the reviews and the commit; else the task is tried again. */
const prove = async ($: $): Promise<void> => {
  const held = await read($, quest)

  if (held === null || held.phase !== 'proving' || held.march === null) return

  const out = held.march

  await update($, working, () => `Argonath proves task ${out.taskId}…`)

  const proof = await ask($, 'argonath', 'prove')
  const verdict = proof.isError ? { isSettled: false, line: proof.text } : proofVerdict(proof.text)

  await keep($, was => ({ ...was, proof: proof.text, proofLine: verdict.line }))

  if (verdict.isSettled) {
    const now = await keep($, was => ({ ...was, phase: 'proven' }))

    if (now !== null) await $.prompt.submit({ text: provenText(now, { id: out.taskId, title: out.title }, verdict.line) }).catch(() => undefined)
    await tell($, `task ${out.taskId} is proven: ${verdict.line}`)

    return
  }

  const made = await readPlan($)
  const task = made === null || typeof made === 'string' ? undefined : made.tasks.find(one => one.id === out.taskId)

  if (out.attempt < MAX_ATTEMPTS && typeof made === 'object' && made !== null && task !== undefined) {
    await march($, made, task, out.attempt + 1, { answer: out.answer, proof: proof.text })

    return
  }

  await keep($, was => ({ ...was, phase: 'stuck' }))
  await update($, note, () => `Task ${out.taskId} is not proven after ${out.attempt} ${out.attempt === 1 ? 'try' : 'tries'}: ${verdict.line}. Fix it by hand and commit, or send it again.`)
  await tell($, `task ${out.taskId} is stuck: ${verdict.line}`)
}

/** Proves the change once more, and commits it as the task's own. Answers what was done, in a sentence or with the proof. */
const commit = async ($: $): Promise<string> => {
  const held = await read($, quest)

  if (held === null) return HOW_TO
  if (held.march === null || (held.phase !== 'proven' && held.phase !== 'stuck')) return `There is nothing to commit: the quest is ${held.phase}.`

  const out = held.march
  const made = await readPlan($)
  const task = made === null || typeof made === 'string' ? undefined : made.tasks.find(one => one.id === out.taskId)

  if (task === undefined || made === null || typeof made === 'string') return `Task ${out.taskId} is not in the Elrond plan in force: ${typeof made === 'string' ? made : 'set out again.'}`

  await update($, working, () => `Argonath proves task ${task.id} before it is committed…`)

  const proof = await ask($, 'argonath', 'prove')
  const verdict = proof.isError ? { isSettled: false, line: proof.text } : proofVerdict(proof.text)

  await keep($, was => ({ ...was, proof: proof.text, proofLine: verdict.line }))

  if (!verdict.isSettled) return `Task ${task.id} is not committed: ${verdict.line}. Argonath's proof:\n\n${proof.text}`

  await update($, working, () => `Committing task ${task.id}…`)

  const dirty = await git($, ['status', '--porcelain'])
  let sha = ''

  // A task that needed no change is done with no commit
  if (dirty.out !== '') {
    const added = await git($, ['add', '-A'])
    const done = added.ok ? await git($, ['commit', '-m', commitMessage(made, task)]) : added

    if (!done.ok) return `Task ${task.id} could not be committed: ${done.out}`

    sha = (await git($, ['rev-parse', 'HEAD'])).out
  }

  await ask($, 'elrond', 'task', { id: task.id, state: 'done' })

  const after = await keep($, was => ({ ...was, phase: 'ready', march: null, proof: '', proofLine: '', commits: [...was.commits, { taskId: task.id, title: task.title, sha }] }))
  const left = await readPlan($)
  const isArrived = typeof left === 'object' && left !== null && isAllDone(left)

  if (isArrived || after?.isAuto === true) await update($, wanted, () => 'next')

  return `Task ${task.id}, "${task.title}", is committed${sha === '' ? ' (it changed nothing, so it is marked done with no commit)' : ` as ${sha.slice(0, 7)}`} on ${held.branch}. ${
    isArrived ? 'Every task is done: the pull request is next.' : after?.isAuto === true ? 'The next task is sent.' : 'The next task waits for the person: /fellowship next, or the pane.'
  }`
}

/** Pushes the branch and opens the pull request that closes the issue. */
const sail = async ($: $): Promise<string> => {
  const held = await read($, quest)

  if (held === null) return HOW_TO
  if (held.phase === 'sailed') return `The pull request is open: ${held.pr}`
  if (held.phase !== 'arrived') return `The quest has not arrived: it is ${held.phase}. Every task is committed first.`

  const made = await readPlan($)

  if (made === null || typeof made === 'string') return made ?? 'Elrond holds no plan any more.'

  await update($, working, () => `Pushing ${held.branch}…`)

  const pushed = await $.process.run(['git', 'push', '-u', 'origin', held.branch], { cwd: await $.session.cwd(), timeoutMs: FORGE_TIMEOUT_MS }).catch((error: unknown) => ({ exitCode: -1, stdout: '', stderr: errorText(error) }))

  if (pushed.exitCode !== 0) return `${held.branch} could not be pushed: ${pushed.stderr.trim() || `git exited with ${pushed.exitCode}`}`

  await update($, working, () => 'Opening the pull request…')

  const argv = prArgv(made, held)
  const opened = await $.process.run(argv, { cwd: await $.session.cwd(), timeoutMs: FORGE_TIMEOUT_MS }).catch((error: unknown) => ({ exitCode: -1, stdout: '', stderr: errorText(error) }))

  if (opened.exitCode !== 0) return `The pull request could not be opened: ${argv[0]} said ${opened.stderr.trim() || `it exited with ${opened.exitCode}`}`

  const url = [...`${opened.stdout}\n${opened.stderr}`.matchAll(/https?:\/\/\S+/g)].map(found => found[0]).pop() ?? ''

  await keep($, was => ({ ...was, phase: 'sailed', pr: url }))
  await tell($, `the pull request for ${held.ref} is open${url === '' ? '' : `: ${url}`}`)

  return `The Fellowship has sailed: ${held.branch} is pushed and the pull request that closes ${held.ref} is open${url === '' ? '' : ` at ${url}`}.`
}

// Whether the clock is doing what was asked: a proof takes minutes, and the next tick waits for it
let isBusy = false

/** Does what a press or a turn asked for, one thing at a time. */
const tick = async ($: $): Promise<void> => {
  const asked = await read($, wanted)

  if (asked === '' || isBusy) return

  isBusy = true
  await update($, wanted, () => '')

  try {
    if (asked === 'next') await sendNext($)
    else if (asked === 'prove') await prove($)
    else {
      const said = asked === 'set out' ? await setOut($, false) : asked === 'commit' ? await commit($) : await sail($)

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

/** Whether an agent is the companion out: by the id its spawn answered, else, where it answered none, by its type. */
const isCompanion = async ($: $, held: FellowshipQuest | null, agentId: string): Promise<boolean> => {
  if (held === null || held.march === null) return false

  return held.march.agentId !== '' ? agentId === held.march.agentId : (await $.agent.list().catch(() => [])).some(one => one.id === agentId && one.type === AGENT_TYPE && one.status === 'running')
}

const sectionText = (held: FellowshipQuest): string =>
  [
    `The Fellowship mod is on a quest: the Elrond plan for ${held.ref}, built task by task on ${held.branch} by companion subagents, each change proven by Argonath and committed alone. It is ${held.phase}.`,
    held.phase === 'proven'
      ? `Task ${held.march?.taskId ?? ''}'s change is proven and uncommitted: once Argonath's reviews of it have answered and their findings are addressed, call mcp__fellowship__commit.`
      : 'Leave the working tree to the companion while one is out; mcp__fellowship__quest says where the quest stands.',
  ].join(' ')

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'fellowship', description: 'Build the Elrond plan task by task: /fellowship sets out (--auto goes on by itself); next, commit, sail, halt' })
    await $.agent
      .register({
        name: AGENT,
        description: 'Builds one task of an Elrond plan in the working tree and proves it with Argonath. Sent by the Fellowship mod alone.',
        prompt: COMPANION_SYSTEM,
        tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash', 'mcp__argonath__radius', 'mcp__argonath__prove'],
        permissionMode: 'acceptEdits',
        disallowedTools: ['Agent', 'mcp__elrond__task', 'mcp__fellowship__commit', 'mcp__fellowship__sail'],
        model: 'inherit',
      })
      .catch(() => undefined)

    // A host that registers no tools still starts the session
    for (const tool of [view.tool, ...TOOLS]) await $.tool.register(tool).catch(() => undefined)

    $.clock.every(TICK_MS, () => void tick($).catch(() => undefined))

    // A reload loads the module afresh: a pane drawn by the copy before it is drawn again, so its buttons press this one
    $.ui.invalidate('ui.render')

    return next(e)
  })

  // A companion is sent by the Fellowship, never through the Agent tool
  on('agent.offer', { agent: AGENT_TYPE }, () => ({ isOffered: false }))

  // The companion's turn has ended: what it built is proven, outside this hook
  on('turn.complete', async ($, e, next) => {
    const held = await read($, quest)

    if (held?.phase === 'marching' && e.agentId !== undefined && (await isCompanion($, held, e.agentId))) {
      const out = held.march

      if (e.isAborted || e.reason !== 'answer') {
        await keep($, was => ({ ...was, phase: 'stuck', march: out === null ? null : { ...out, answer: e.answer ?? '' } }))
        await update($, note, () => `The companion on task ${out?.taskId ?? ''} ${e.isAborted ? 'was interrupted' : e.reason === 'refusal' ? 'refused' : 'ended on an API error'}: send it again from the pane.`)
      } else {
        await keep($, was => ({ ...was, phase: 'proving', march: out === null ? null : { ...out, answer: e.answer ?? '' } }))
        await update($, wanted, () => 'prove')
      }
    }

    return next(e)
  })

  // The companion builds its task, and leaves the branch, the commits and the plan to the Fellowship
  on('tool.call', async ($, e, next) => {
    const agentId = (e as { agentId?: string }).agentId

    if (agentId === undefined || !(await isCompanion($, await read($, quest), agentId))) return next(e)

    const given = e as unknown as { tool: string; command?: unknown; file_path?: unknown; notebook_path?: unknown }

    if (given.tool === 'Bash' && typeof given.command === 'string' && isForbiddenGit(given.command)) return { deny: 'The Fellowship commits and keeps the branch: leave your change uncommitted, and run no git command that moves HEAD or the index.' }

    const path = typeof given.file_path === 'string' ? given.file_path : typeof given.notebook_path === 'string' ? given.notebook_path : undefined

    if (path !== undefined && isModPath(await $.session.cwd(), path)) return { deny: 'That folder belongs to a mod: a companion changes the project, not what the mods keep.' }

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

  on('tool.call', { tool: 'mcp__fellowship__commit' }, async $ => ({ result: await alone($, () => commit($)) }))

  on('tool.call', { tool: 'mcp__fellowship__sail' }, async $ => ({ result: await alone($, () => sail($)) }))

  on('command.run', { command: 'fellowship' }, async ($, e) => {
    const words = e.args.trim().split(/\s+/).filter(word => word !== '')
    const isAuto = words.includes('--auto')
    const verb = words.find(word => !word.startsWith('--')) ?? ''
    const held = await read($, quest)

    await $.ui.open({ id: PANE, title: TITLE })

    if (verb === 'halt') {
      await keep($, was => ({ ...was, isAuto: false }))

      return { text: held === null ? HOW_TO : 'The Fellowship stops after the task it is on: send the next from the pane, or /fellowship next.' }
    }

    if (verb === 'next') {
      if (held === null || (held.phase !== 'ready' && held.phase !== 'stuck')) return { text: held === null ? HOW_TO : `The quest is ${held.phase}: no task is sent now.` }
      await update($, wanted, () => 'next')

      return { text: 'A companion is sent on the next task.' }
    }

    if (verb === 'commit') return { text: await alone($, () => commit($)) }
    if (verb === 'sail') return { text: await alone($, () => sail($)) }
    if (verb !== '') return { text: `/fellowship knows set out (no word, or --auto), next, commit, sail and halt; not ${verb}.` }

    // A quest under way is shown, and made auto when asked; any other sets out
    if (held !== null && held.phase !== 'sailed' && !isAuto) return { text: questText(held, await read($, plan)) }

    return { text: await alone($, () => setOut($, isAuto)) }
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
                {`${MARK[task.state]} ${task.id}. ${task.title}${commitOf(task.id) !== undefined ? `  · ${commitOf(task.id)?.sha.slice(0, 7) || 'no change'}` : ''}${out?.taskId === task.id ? `  · ${held.phase}` : ''}`}
              </Text>
            ))}
          </Box>
        )}
        {out !== null && (
          <Box flexDirection="column" borderStyle="round" paddingX={1}>
            <Text bold>{`Companion on task ${out.taskId}: ${out.title}`}</Text>
            <Text dimColor>{`try ${out.attempt} of ${MAX_ATTEMPTS} · since ${new Date(out.at).toLocaleTimeString()}`}</Text>
            {held.proofLine !== '' && <Text color={held.phase === 'proven' ? 'success' : 'warning'}>{`Argonath: ${held.proofLine}`}</Text>}
          </Box>
        )}
        {held.pr !== '' && <Text color="success">{`Pull request: ${held.pr}`}</Text>}
        <Box flexDirection="row" gap={1}>
          {(held.phase === 'ready' || held.phase === 'stuck') && (
            <Button key="next" hotkey="n" variant="primary" onPress={() => press('next')}>
              {held.phase === 'stuck' ? 'Send again' : 'Send the next task'}
            </Button>
          )}
          {(held.phase === 'proven' || (held.phase === 'stuck' && out !== null)) && (
            <Button key="commit" hotkey="c" variant={held.phase === 'proven' ? 'primary' : 'secondary'} onPress={() => press('commit')}>
              Prove and commit
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
