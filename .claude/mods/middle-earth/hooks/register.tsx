import type { EngineInterface, Register } from 'claude-code'

import type { MiddleEarthAgent } from '../types'
import { agentOf, guardRefusalNow, listedRole, recall, refusalOf, registerAgents, registerOffers, remember, spawned } from './agents'
import { rootOf } from './flow'
import { argonathView, endedArgonath, registerArgonath, sectionOfArgonath, startArgonath } from './argonath/register'
import { blackgateView, registerBlackgate, startBlackgate } from './blackgate/register'
import { councilFound, elrondView, endedElrond, registerElrond, sectionOfElrond, startElrond } from './elrond/register'
import { endedFellowship, fellowshipView, memberFound, registerFellowship, sectionOfFellowship, startFellowship } from './fellowship/register'
import { endedLothlorien, galadrielFound, lockRefusal, lothlorienView, registerLothlorien, sectionOfLothlorien, startLothlorien } from './lothlorien/register'
import { mountdoomView, registerMountdoom, startMountdoom } from './mountdoom/register'
import { carryStores } from './stores'

// The Middle-earth mod: one plugin, each of its parts a folder of its own (Elrond plans, the Fellowship builds,
// Lothlórien writes tests first, the Argonath prove and judge, the Black Gate reads review, Mount Doom clears what is
// merged). The parts call one another as functions; the agents they send are registered, kept and guarded in one place.
// An event every part hears is hooked here once, and handed to each part in turn; a part hooks what is its own alone.

/** Each part's pane, by the name Claude asks it by, and the command that opens it. */
const PANES = {
  elrond: elrondView,
  fellowship: fellowshipView,
  lothlorien: lothlorienView,
  argonath: argonathView,
  blackgate: blackgateView,
  mountdoom: mountdoomView,
} as const

const PANE_TOOL = {
  name: 'pane',
  description:
    'Reads one of the side panes as text: what it shows the person right now, or last showed. `elrond` the plan (/elrond), `fellowship` the quests (/fellowship), `lothlorien` the tests written first (/mirror), `argonath` the proof of the change (/argonath), `blackgate` the review comments (/blackgate), `mountdoom` what is merged (/mountdoom). Call it when the person speaks of a pane or of something only it shows.',
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
  const agent = (role === 'member' ? await memberFound($, agentId) : role === 'galadriel' ? await galadrielFound($, agentId) : role === 'council' ? await councilFound($, agentId) : undefined) ?? { role, root, tree: root }

  await remember($, agentId, agent)

  return agent
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // The record of the agents sent before a reload, then their types: a reload loads the module afresh
    await recall($)
    await registerAgents($)
    await carryStores($).catch(() => undefined)
    // A host that registers no tools still starts the session
    await $.tool.register(PANE_TOOL).catch(() => undefined)

    await startElrond($)
    await startLothlorien($)
    await startArgonath($)
    await startFellowship($)
    await startBlackgate($)
    await startMountdoom($)

    // A reload loads the module afresh: a pane drawn by the copy before it is drawn again, so its buttons press this one
    $.ui.invalidate('ui.render')

    return next(e)
  })

  // A turn has ended, the session's or an agent's: each part reads what is its own of it, one part's stumble none other's
  on('turn.complete', async ($, e, next) => {
    await endedElrond($, e).catch(() => undefined)
    await endedLothlorien($, e).catch(() => undefined)
    await endedArgonath($, e).catch(() => undefined)
    await endedFellowship($, e).catch(() => undefined)

    return next(e)
  })

  // Claude is told what each part holds that bears on its work
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const added = [
      await sectionOfElrond($).catch(() => undefined),
      await sectionOfFellowship($).catch(() => undefined),
      await sectionOfLothlorien($).catch(() => undefined),
      await sectionOfArgonath($).catch(() => undefined),
    ].filter(one => one !== undefined)

    return added.length === 0 ? composed : { sections: [...composed.sections, ...added.map(one => ({ ...one, scope: 'session' as const }))] }
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)

    await spawned($, started.agentId, e.cwd)

    return started
  }).catch((_$, e, next) => next(e))

  // The one guard, then the lock on Galadriel's tests. Where it could not look, the record alone holds each agent
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
  registerElrond(on)
  registerLothlorien(on)
  registerArgonath(on)
  registerFellowship(on)
  registerBlackgate(on)
  registerMountdoom(on)

  on('tool.call', { tool: 'mcp__middle-earth__pane' }, async ($, e) => {
    const named = String((e as unknown as { pane?: unknown }).pane ?? '')
    const view = named in PANES ? PANES[named as keyof typeof PANES] : undefined

    return view === undefined ? { result: `There is no pane named ${named}: ${Object.keys(PANES).join(', ')}.` } : view.answer(() => $.ui.panes())
  })
}
