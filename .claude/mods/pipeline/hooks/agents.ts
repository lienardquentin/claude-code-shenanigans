import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { BuilderName, SentAgent, AgentRole } from '../types'
import { REVIEWERS, REVIEWER_EFFORT, REVIEWER_MODEL, reviewerSystem } from '../core/review'
import { PLANNER_SYSTEM, isPlanPath } from '../core/plan'
import { resolvedFrom } from '../core/paths'
import { BUILDERS, isModSource, isOutside, builderSystem, reachesOut } from '../core/run'
import { isChanging, isForbiddenGit, isModPath, isPrivatePath, privateRefusal, rootOf } from './flow'
import { TEST_WRITER_EFFORT, TEST_WRITER_LIGHT_MODEL, TEST_WRITER_MODEL, TEST_WRITER_SYSTEM, isTestPath } from '../core/tests-first'
import type { Trees } from './kit/trees'
import { stumbled } from './trouble'

// Every agent the mod sends, in one place: the types it registers, the record of each one sent, and the one guard that
// holds each to what its part allows. None of them has a permission mode of its own: each works under the session's,
// held by this guard. The guard knows an agent by the record, else by the type the session lists it as: one it can
// place by neither (the record lost it and the list could not be read) is held to nothing more than the session's own
// mode, so each agent is recorded as it is sent. Its rules read a command's words: a fence for agents that mean well,
// not a sandbox.
// A helper that takes `$` is a function declaration: past an import, the engine follows `$` into no other kind.

type $ = EngineInterface
type On = Parameters<import('claude-code').Register>[0]

/** The plugin's name: its agent types are `pipeline:<name>`, its tools `mcp__pipeline__<name>`. */
export const PLUGIN = 'pipeline'

/** An agent type of the mod, by its name. */
export const typeOf = (name: string): string => `${PLUGIN}:${name}`

/** A tool of the mod, as Claude and the agents call it. */
export const toolOf = (name: string): string => `mcp__${PLUGIN}__${name}`

export const PLANNER = 'planner'
export const TEST_WRITER = 'test-writer'
// It gazes on Sonnet for a task that is not heavy: the same charge, a lighter model
export const TEST_WRITER_LIGHT = 'test-writer-light'

// How many agents are kept: a run's agents are few, and an old one is never asked of again
const KEPT = 64

const agents = atom({ plugin: 'pipeline', key: 'agents' } as const, {} as Record<string, SentAgent>)

// The record, kept where no `$` call is needed to read it: the guard is asked of calls raised beneath one of the mod's
// own, where it can make none, and holds every agent the mod sent alike. The state above carries it across a reload
const known = new Map<string, SentAgent>()

const tidy = (path: string): string => path.replace(/\/+$/, '')

/** Keeps an agent the mod sent, or saw spawned in a folder, by its id. */
export async function remember($: $, agentId: string, agent: SentAgent): Promise<void> {
  if (agentId === '') return

  const kept = { ...agent, root: tidy(agent.root), tree: tidy(agent.tree) }

  known.delete(agentId)
  known.set(agentId, kept)
  while (known.size > KEPT) known.delete(known.keys().next().value as string)
  await update($, agents, was => Object.fromEntries([...Object.entries(was).filter(([id]) => id !== agentId), [agentId, kept] as const].slice(-KEPT)))
}

/** Stops an agent the mod sent: every tool it calls from now on is refused with why, so it ends its turn. */
export async function stopAgent($: $, agentId: string, why: string): Promise<void> {
  const was = known.get(agentId)

  if (was !== undefined) await remember($, agentId, { ...was, stopped: why })
}

/** The agent of an id, as the record holds it; nothing for one the mod neither sent nor saw spawned in a folder. */
export const agentOf = (agentId: string | undefined): SentAgent | undefined => (agentId === undefined ? undefined : known.get(agentId))

/** The folder each agent works in, by its id: a call of one sent to a run's worktree is about that worktree. */
export const treesOf = (): Trees => Object.fromEntries([...known].map(([id, agent]) => [id, agent.tree]))

/** The role an agent type of the mod is sent in; nothing for any other type. */
export const roleOfType = (type: string): AgentRole | undefined => {
  if (!type.startsWith(`${PLUGIN}:`)) return undefined

  const name = type.slice(PLUGIN.length + 1)

  return name === PLANNER ? 'planner' : name === TEST_WRITER || name === TEST_WRITER_LIGHT ? 'test-writer' : name in BUILDERS ? 'builder' : REVIEWERS.some(one => one.name === name) ? 'reviewer' : undefined
}

// The agents found to be none of the mod's: each is looked up once
const strangers = new Set<string>()

/**
 * The role of an agent the record does not hold, by the type the session lists it as (one sent where its spawn
 * answered no id); nothing for one that is not the mod's. Its part then finds where it works.
 */
export async function listedRole($: $, agentId: string): Promise<AgentRole | undefined> {
  if (strangers.has(agentId)) return undefined

  const listed = (await $.agent.list()).find(one => one.id === agentId)
  const role = roleOfType(listed?.type ?? '')

  // An agent the session does not list yet is asked about again on its next call
  if (role === undefined && listed !== undefined) strangers.add(agentId)

  return role
}

export const PLANNER_READS = 'The planner reads the codebase and changes nothing: run only commands that read. The plan goes to its file with Write.'
export const REVIEWER_READS = 'A reviewer judges the change and changes nothing: run only commands that read.'

type Call = { tool?: unknown; command?: unknown; file_path?: unknown; notebook_path?: unknown; path?: unknown; dangerouslyDisableSandbox?: unknown }

/** The file a tool reads or changes, or the folder Grep and Glob search; nothing for a call that names none. */
const namedOf = (given: Call): string | undefined =>
  [given.file_path, given.notebook_path, given.tool === 'Grep' || given.tool === 'Glob' ? given.path : undefined].find((one): one is string => typeof one === 'string' && one !== '')

const withinOf = (tree: string, path: string): string => (path.startsWith(`${tree}/`) ? path.slice(tree.length + 1) : path.replace(/^\.\//, ''))

/** Why a builder's call is refused: it builds in its run's worktree, and leaves the branch, the commits and the mods' folders alone. */
const builderRefusal = (agent: SentAgent, given: Call): string | undefined => {
  if (given.tool === 'Bash' && typeof given.command === 'string') {
    if (isForbiddenGit(given.command)) return "The build commits and keeps the branch: leave your change uncommitted, run no git command that moves HEAD or the index, and leave git's config as it is."
    // A cd into the person's checkout would build the run there, and move where the mod looks with it
    if (reachesOut(agent.root, agent.tree, given.command)) return `You work in the run's worktree, ${agent.tree}: name no path of the person's checkout outside it, and use paths relative to your working directory.`
  }

  const named = namedOf(given)

  if (named === undefined) return undefined

  const path = resolvedFrom(agent.tree, named)

  if (isOutside(agent.tree, path)) return `You work in the run's worktree, ${agent.tree}: read and change files there alone.`
  if (isModPath(agent.tree, path)) return 'That folder belongs to a mod: a builder changes the project, not what the mods keep.'
  if (isModSource(agent.tree, path, { files: agent.files ?? [] })) return "That is a mod's source, and your task is not about a mod: say in your account what of it stood in your way, and leave it as it is."

  return undefined
}

/** Why a call of the test writer's is refused: it writes tests in the place it writes in, and runs only what tests or reads. */
const testWriterRefusal = (agent: SentAgent, given: Call): string | undefined => {
  if (given.tool === 'Bash' && typeof given.command === 'string' && isChanging(given.command)) return 'The test writer writes its tests with Write and Edit, and runs only what tests or reads.'
  if ((given.tool !== 'Edit' && given.tool !== 'Write') || typeof given.file_path !== 'string') return undefined

  const whole = resolvedFrom(agent.tree, given.file_path)

  if (whole !== agent.tree && !whole.startsWith(`${agent.tree}/`)) return `The tests are written in ${agent.tree}: write yours there alone.`
  if (!isTestPath(withinOf(agent.tree, whole))) return 'Tests first show what is to come: write only in test files, and leave the source for whoever builds it.'

  return undefined
}

/** Why an agent the mod sent may not make a call; nothing when its role allows it. */
export const refusalOf = (agent: SentAgent, e: unknown): string | undefined => {
  const given = e as Call

  // An agent stopped is refused whatever it calls: the engine has no call that ends a subagent's turn
  if (agent.stopped !== undefined) return `${agent.stopped} Call no more tools: end your turn now, saying what you built so far.`

  // An agent seen spawned in a folder, of no type of the mod's, is the session's to hold
  return agent.role === 'other' ? undefined : (machineRefusal(agent, given) ?? roleRefusal(agent, given))
}

/** Why no agent the mod sent may make a call, whatever its role: it leaves the sandbox, or reaches what is private on the machine. */
const machineRefusal = (agent: SentAgent, given: Call): string | undefined => {
  if (given.tool === 'Bash' && given.dangerouslyDisableSandbox === true) return 'Run every command in the sandbox: an agent the mod sends never leaves it.'
  if (given.tool === 'Bash' && typeof given.command === 'string') return privateRefusal(agent.root, agent.tree, given.command)

  const named = namedOf(given)

  return named !== undefined && isPrivatePath(agent.root, agent.tree, named) ? `${named} is outside the project, somewhere private on the machine: read only what the project holds.` : undefined
}

/** Why an agent the mod sent may not make a call in its role. */
const roleRefusal = (agent: SentAgent, given: Call): string | undefined => {
  switch (agent.role) {
    case 'planner':
      if (given.tool === 'Bash' && typeof given.command === 'string' && isChanging(given.command)) return PLANNER_READS
      if (given.tool === 'Write' && typeof given.file_path === 'string' && !isPlanPath(agent.root, given.file_path)) return `The planner writes its plan to ${agent.files?.[0] ?? 'its file in .pipeline/plans'} and nothing else.`

      return undefined
    case 'reviewer':
      return given.tool === 'Bash' && typeof given.command === 'string' && isChanging(given.command) ? REVIEWER_READS : undefined
    case 'builder':
      return builderRefusal(agent, given)
    case 'test-writer':
      return testWriterRefusal(agent, given)
    default:
      return undefined
  }
}

/** Registers every agent type the mod sends, at the session's start. */
export async function registerAgents($: $): Promise<void> {
  // Each of them is hidden from the model by `registerOffers`, and sent by the mod alone
  await $.agent
    .register({
      name: PLANNER,
      description: 'Plans a GitHub or GitLab issue against this codebase as tasks, read-only. Sent by the planner part alone.',
      prompt: PLANNER_SYSTEM,
      // It writes one file, its plan, and runs only what reads: the guard holds it to that
      tools: ['Read', 'Grep', 'Glob', 'Bash', 'Write'],
      disallowedTools: ['Edit', 'NotebookEdit'],
      model: 'inherit',
    })
    .catch(stumbled($, 'the agent types'))

  for (const [name, member] of Object.entries(BUILDERS) as [BuilderName, (typeof BUILDERS)[BuilderName]][]) {
    await $.agent
      .register({
        name,
        description: `${member.title} of the build: builds one task of a run in its worktree, proven and reviewed. Sent by the build alone.`,
        prompt: builderSystem(name),
        // The guard holds it to its fence: its worktree, no git that moves the branch, no mod's folder
        tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash', toolOf('radius'), toolOf('prove'), toolOf('amend_test')],
        disallowedTools: ['Agent', toolOf('task'), toolOf('review'), toolOf('commit')],
        model: member.model,
        effort: member.effort,
      })
      .catch(stumbled($, 'the agent types'))
  }

  for (const [name, model] of [[TEST_WRITER, TEST_WRITER_MODEL], [TEST_WRITER_LIGHT, TEST_WRITER_LIGHT_MODEL]] as const) {
    await $.agent
      .register({
        name,
        description: 'Test writer: writes the failing tests of a behaviour before it is built, and only tests. Sent by tests first alone.',
        prompt: TEST_WRITER_SYSTEM,
        // What it may write (tests, in the place it writes in) and run (what tests or reads) is the guard's
        tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'],
        disallowedTools: ['Agent', 'NotebookEdit'],
        model,
        effort: TEST_WRITER_EFFORT,
      })
      .catch(stumbled($, 'the agent types'))
  }

  for (const reviewer of REVIEWERS) {
    await $.agent
      .register({
        name: reviewer.name,
        description: `${reviewer.title}: judges a change every integration test pins, read-only. Sent by verify alone.`,
        prompt: reviewerSystem(reviewer.title),
        tools: ['Read', 'Grep', 'Glob', 'Bash', 'Skill'],
        disallowedTools: ['Edit', 'Write', 'NotebookEdit', 'Agent'],
        model: REVIEWER_MODEL,
        effort: REVIEWER_EFFORT,
      })
      .catch(stumbled($, 'the agent types'))
  }
}

// The engine holds an agent the mod sends to the mod's hooks (the guard, its tools, its turn's end) only when it is
// spawned inside one of them, awaited, and from none the agent needs: one spawned from the clock, or after its hook
// returned, runs with every hook of the mod skipped. And it drops the `cwd` a spawn names: the mod's own `agent.spawn`
// hook sets it again. So the mod asks, before it sends one, whether it stands in a hook: its own tool, called through
// the engine, is answered from one, and is not from the clock.

/** The tool the mod asks itself through, to know whether it stands in a hook. */
export const FRAME_TOOL = {
  name: 'frame',
  description: 'Internal to the pipeline mod: answers whether a call stands in one of its hooks. Never call it.',
  inputSchema: { type: 'object', properties: {} },
} as const

/** What the frame tool answers from a hook. */
export const FRAMED = 'framed'

/** Whether the mod stands in one of its hooks now, where an agent it sends is held. */
export async function inFrame($: $): Promise<boolean> {
  // Outside a hook the call is refused, which is the answer
  const answered = await $.tool.call({ tool: toolOf(FRAME_TOOL.name) } as never).catch(() => undefined)

  return (answered as { result?: unknown } | undefined)?.result === FRAMED
}

/** The tool Claude is asked to call when the mod has work it can do in a hook alone, and no hook comes by itself. */
export const PUMP_TOOL = {
  name: 'pump',
  description: 'Does what the pipeline mod was asked to do outside its hooks (a pane press, a clock), where the agents it sends are held. Call it when the mod asks you to.',
  inputSchema: { type: 'object', properties: {} },
} as const

// Whether Claude was asked to call the pump tool, and has not yet: asked once, however often the clock looks
let isAskedToPump = false

/**
 * Asks Claude, once until it is done, to call the pump tool: what was asked outside a hook (a press, the clock) waits
 * for one, and none may come by itself while no agent is out.
 */
export async function askToPump($: $, what: string): Promise<void> {
  if (isAskedToPump) return

  isAskedToPump = true
  await $.prompt.submit({ text: `The pipeline mod: ${what} It is done where the agents it sends are held: call ${toolOf(PUMP_TOOL.name)}.` }).catch((error: unknown) => {
    isAskedToPump = false
    stumbled($, 'the pipeline')(error)
  })
}

/** The mod has pumped in a hook: what was waiting is done, and Claude may be asked again. */
export const pumped = (): void => {
  isAskedToPump = false
}

// The folder each spawn asked to run in, by its prompt, until the mod's `agent.spawn` hook sets it
const cwds = new Map<string, string>()

/** The folder a spawn the mod made asked to run in, taken once; nothing for one it named none for. */
export const cwdOf = (prompt: string): string | undefined => {
  const cwd = cwds.get(prompt)

  cwds.delete(prompt)

  return cwd
}

type Spawn = Parameters<$['agent']['spawn']>[0]
type Spawned = Awaited<ReturnType<$['agent']['spawn']>>

/**
 * Sends an agent of the mod's, in a folder of its own when one is named; refused, and nothing sent, where the mod stands
 * in none of its hooks, as such an agent would run unheld.
 */
export async function spawnIn($: $, spawn: Spawn): Promise<Spawned> {
  if (!(await inFrame($))) return { deny: 'the mod stands in none of its hooks, where the agent would run unheld: it is sent from the next one' } as Spawned

  if (spawn.cwd !== undefined) cwds.set(spawn.prompt, spawn.cwd)

  try {
    return await $.agent.spawn(spawn)
  } finally {
    cwds.delete(spawn.prompt)
  }
}

/** The record as the state carries it across a reload: the module's own copy starts empty. */
export async function recall($: $): Promise<void> {
  for (const [id, agent] of Object.entries(await read($, agents))) if (!known.has(id)) known.set(id, agent)
}

/**
 * An agent spawned in a folder of its own (a run's worktree) is about that folder: what it asks of the mod is
 * answered there, and one of the mod's types is held to its role from its first call, before its part keeps it as
 * sent (a spawn may answer its sender no id). One the mod sent is kept as it was sent, which this never overwrites.
 */
export async function spawned($: $, agentId: string | undefined, cwd: string | undefined, type = ''): Promise<void> {
  if (cwd !== undefined && agentId !== undefined && agentId !== '' && known.get(agentId) === undefined) await remember($, agentId, { role: roleOfType(type) ?? 'other', root: await rootOf($), tree: cwd })
}

/** The role of an agent: as the record holds it, else by the type the session lists it as; nothing for one not the mod's. */
export async function roleOf($: $, agentId: string | undefined): Promise<AgentRole | undefined> {
  if (agentId === undefined) return undefined

  return agentOf(agentId)?.role ?? (await listedRole($, agentId))
}

/** The guard as the record alone decides it, where nothing more can be looked at: each agent held to what its role allows. */
export const guardRefusalNow = (e: unknown): string | undefined => {
  const agent = agentOf((e as { agentId?: string }).agentId)

  return agent === undefined ? undefined : refusalOf(agent, e)
}

export function registerOffers(on: On): void {
  // Every agent type of the mod answers in a shape its part reads: Claude reaches them through the mod's tools, never
  // through the Agent tool
  for (const name of [PLANNER, TEST_WRITER, TEST_WRITER_LIGHT, ...Object.keys(BUILDERS), ...REVIEWERS.map(one => one.name)]) on('agent.offer', { agent: typeOf(name) }, () => ({ isOffered: false })).catch(() => ({ isOffered: false }))
}
