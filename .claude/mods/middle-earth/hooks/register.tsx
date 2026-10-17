import type { EngineInterface, Register } from 'claude-code'

import type { MiddleEarthAgent } from '../types'
import { FRAMED, FRAME_TOOL, PUMP_TOOL, agentOf, cwdOf, guardRefusalNow, listedRole, recall, refusalOf, registerAgents, registerOffers, remember, pumped, spawned } from './agents'
import { errorText, rootOf, toolFailed } from './flow'
import { argonathView, endedArgonath, pumpArgonath, registerArgonath, sectionOfArgonath, startArgonath } from './argonath/register'
import { followUpView, registerFollowUp, startFollowUp } from './follow-up/register'
import { plannerFound, plannerView, endedPlanner, pumpPlanner, registerPlanner, sectionOfPlanner, startPlanner } from './planner/register'
import { endedFellowship, fellowshipView, memberFound, pumpFellowship, registerFellowship, sectionOfFellowship, spentFellowship, startFellowship } from './fellowship/register'
import { endedTestsFirst, testWriterFound, lockRefusal, testsFirstView, registerTestsFirst, sectionOfTestsFirst, startTestsFirst } from './tests-first/register'
import { cleanupView, registerCleanup, startCleanup } from './cleanup/register'
import { issuesView, registerIssues, startIssues } from './issues/register'
import { carryStores } from './stores'
import { sectionOfLag, startLag } from './lag'

// The Middle-earth mod: one plugin, each of its parts a folder of its own (the issues pane lists the issues, plans, the
// Fellowship builds, the test writer writes tests first, the Argonath prove and judge, the review follow-up reads review, the cleanup
// clears what is merged). The parts call one another as functions; the agents they send are registered, kept and guarded in one place.
// An event every part hears is hooked here once, and handed to each part in turn; a part hooks what is its own alone.

/** Each part's pane, by the name Claude asks it by, and the command that opens it. */
const PANES = {
  issues: issuesView,
  planner: plannerView,
  fellowship: fellowshipView,
  'tests-first': testsFirstView,
  argonath: argonathView,
  'follow-up': followUpView,
  cleanup: cleanupView,
} as const

const PANE_TOOL = {
  name: 'pane',
  description:
    'Reads one of the side panes as text: what it shows the person right now, or last showed. `issues` the open issues (/issues), `planner` the plan (/planner), `fellowship` the quests (/fellowship), `tests-first` the tests written first (/tests), `argonath` the proof of the change (/argonath), `follow-up` the review comments (/follow-up), `cleanup` what is merged (/cleanup). Call it when the person speaks of a pane or of something only it shows.',
  inputSchema: { type: 'object', properties: { pane: { type: 'string', enum: Object.keys(PANES) } }, required: ['pane'] },
} as const

/**
 * An agent of the mod's own that the record lost (sent where its spawn answered no id), found by its type and by the
 * part that sent it, and kept. One whose work cannot be found keeps its role, held to the project's own folder.
 * Nothing for an agent that is not the mod's.
 */
async function lost($: EngineInterface, agentId: string): Promise<MiddleEarthAgent | undefined> {
  const role = await listedRole($, agentId)

  if (role === undefined) return undefined

  const root = await rootOf($)
  const agent = (role === 'member' ? await memberFound($, agentId) : role === 'test-writer' ? await testWriterFound($, agentId) : role === 'planner' ? await plannerFound($, agentId) : undefined) ?? { role, root, tree: root }

  await remember($, agentId, agent)

  return agent
}

// The last failure each part was found in: said once, and again only when it fails otherwise, so a part that keeps
// failing alike is not said at every turn
const stumbles = new Map<string, string>()

/** What a part's failure comes to: a toast that says it, once while it fails alike. It answers nothing in the part's place. */
function stumbled($: EngineInterface, part: string): (error: unknown) => undefined {
  return error => {
    const why = errorText(error)

    if (stumbles.get(part) !== why) {
      stumbles.set(part, why)
      $.ui.toast(`Middle-earth: ${part} stumbled: ${why.split('\n')[0] ?? why}`)
    }

    return undefined
  }
}

/**
 * Does what the parts were asked to do that may send an agent, in the hook that calls it: the planner's planner a press
 * asked for, the Fellowship's quests, the statues the session's own change is owed.
 */
async function pump($: EngineInterface): Promise<void> {
  pumped()
  await pumpPlanner($).catch(stumbled($, 'the planner'))
  await pumpFellowship($).catch(stumbled($, 'the Fellowship'))
  await pumpArgonath($).catch(stumbled($, 'the Argonath'))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // The record of the agents sent before a reload, then their types: a reload loads the module afresh
    await recall($)
    await registerAgents($)
    await carryStores($).catch(stumbled($, 'the stores'))
    // A host that registers no tools still starts the session
    await $.tool.register(PANE_TOOL).catch(() => undefined)
    await $.tool.register(FRAME_TOOL).catch(() => undefined)
    await $.tool.register(PUMP_TOOL).catch(() => undefined)

    await startPlanner($)
    await startTestsFirst($)
    await startArgonath($)
    await startFellowship($)
    await startFollowUp($)
    await startCleanup($)
    await startIssues($)
    // A plugin of the marketplace that lags its folder is said, to the person and to Claude
    await startLag($).catch(stumbled($, 'the lag check'))

    // A reload loads the module afresh: a pane drawn by the copy before it is drawn again, so its buttons press this one
    $.ui.invalidate('ui.render')

    return next(e)
  })

  // A turn has ended, the session's or an agent's: each part reads what is its own of it, one part's stumble none other's
  on('turn.complete', async ($, e, next) => {
    // What a turn of an agent the mod sent cost is counted, whichever part sent it
    const agent = agentOf(e.agentId)

    if (agent !== undefined && agent.role !== 'other') await spentFellowship($, agent, e).catch(stumbled($, 'the spend record'))

    await endedPlanner($, e).catch(stumbled($, 'the planner'))
    await endedTestsFirst($, e).catch(stumbled($, 'Tests first'))
    await endedArgonath($, e).catch(stumbled($, 'the Argonath'))
    await endedFellowship($, e).catch(stumbled($, 'the Fellowship'))

    return next(e)
  })

  // A turn has ended: what it leads to is done here, where an agent sent is held. The hook that sends one is skipped for
  // that agent's own events, so two take turns: the one that did not send it carries on from its end. The session's
  // own turn sends only the statues its change is owed: a quest's proof takes minutes, not kept from the person
  for (const reason of [/./, /[^]/]) {
    on('turn.complete', { reason }, async ($, e, next) => {
      await (e.agentId === undefined ? pumpArgonath($) : pump($)).catch(stumbled($, 'the turn\'s end'))

      return next(e)
    }).catch((_$, e, next) => next(e))
  }

  // Claude is told what each part holds that bears on its work
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const added = [
      await sectionOfPlanner($).catch(stumbled($, 'the planner')),
      await sectionOfFellowship($).catch(stumbled($, 'the Fellowship')),
      await sectionOfTestsFirst($).catch(stumbled($, 'Tests first')),
      await sectionOfArgonath($).catch(stumbled($, 'the Argonath')),
      sectionOfLag(),
    ].filter(one => one !== undefined)

    return added.length === 0 ? composed : { sections: [...composed.sections, ...added.map(one => ({ ...one, scope: 'session' as const }))] }
  })

  // The engine drops the folder a spawn names: one the mod sent asked for it, and is given it here
  on('agent.spawn', async ($, e, next) => {
    const cwd = e.cwd ?? cwdOf(e.prompt)
    const started = await next(cwd === undefined ? e : { ...e, cwd })

    // The engine names the type `subagentType`; a classic hook's shape, `subagent_type`
    await spawned($, started.agentId, cwd, e.subagentType ?? (e as unknown as { subagent_type?: string }).subagent_type)

    return started
  }).catch((_$, e, next) => next(e))

  // The one guard, then the lock on the tests written first. Where it could not look, the record alone holds each agent
  on('tool.call', async ($, e, next) => {
    const agentId = (e as { agentId?: string }).agentId
    const agent = agentId === undefined ? undefined : (agentOf(agentId) ?? (await lost($, agentId)))
    const why = (agent === undefined ? undefined : refusalOf(agent, e)) ?? ((await lockRefusal($, e)) || undefined)

    return why === undefined ? next(e) : { deny: why }
  }).catch((_$, e, next) => {
    const why = next.called ? undefined : guardRefusalNow(e)

    return why === undefined ? next(e) : { deny: why }
  })

  registerOffers(on)
  registerPlanner(on)
  registerTestsFirst(on)
  registerArgonath(on)
  registerFellowship(on)
  registerFollowUp(on)
  registerCleanup(on)
  registerIssues(on)

  // Answered only from a hook: the clock calls it unanswered
  on('tool.call', { tool: 'mcp__middle-earth__frame' }, () => ({ result: FRAMED })).catch((_$, _e, next) => toolFailed('frame', next.error))

  // Claude was asked to: what waited outside a hook is done here
  on('tool.call', { tool: 'mcp__middle-earth__pump' }, async $ => {
    await pump($)

    return { result: 'Done: the panes say how it went.' }
  }).catch((_$, _e, next) => toolFailed('pump', next.error))

  on('tool.call', { tool: 'mcp__middle-earth__pane' }, async ($, e) => {
    const named = String((e as unknown as { pane?: unknown }).pane ?? '')
    const view = named in PANES ? PANES[named as keyof typeof PANES] : undefined

    return view === undefined ? { result: `There is no pane named ${named}: ${Object.keys(PANES).join(', ')}.` } : view.answer(() => $.ui.panes())
  }).catch((_$, _e, next) => toolFailed('pane', next.error))
}
