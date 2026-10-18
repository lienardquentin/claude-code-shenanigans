import type { EngineInterface, Register } from 'claude-code'

import type { SentAgent } from '../types'
import { FRAMED, FRAME_TOOL, PUMP_TOOL, agentOf, cwdOf, guardRefusalNow, listedRole, recall, refusalOf, registerAgents, registerOffers, remember, pumped, spawned } from './agents'
import { offerTools, rootOf, toolFailed } from './flow'
import { verifyCommand, verifyView, endedVerify, pumpVerify, registerVerify, sectionOfVerify, startVerify } from './verify/register'
import { followUpCommand, followUpView, registerFollowUp, startFollowUp } from './follow-up/register'
import { planCommand, plannerFound, plannerView, endedPlanner, pumpPlanner, registerPlanner, sectionOfPlanner, startPlanner } from './planner/register'
import { buildCommand, endedBuild, buildView, runLeftovers, builderFound, pumpBuild, registerBuild, sectionOfBuild, setBudget, spentBuild, startBuild } from './build/register'
import { endedTestsFirst, testsCommand, testWriterFound, lockRefusal, testsFirstView, registerTestsFirst, sectionOfTestsFirst, startTestsFirst } from './tests-first/register'
import { cleanupCommand, cleanupView, registerCleanup, startCleanup } from './cleanup/register'
import { issuesCommand, issuesView, registerIssues, startIssues } from './issues/register'
import { carryFolder, carryStores } from './stores'
import { sectionOfLag, startLag } from './lag'
import { stumbled, troublesText } from './trouble'
import { doctorOf } from './doctor'
import { doctorText } from '../core/doctor'

// Theseus: one plugin, each of its parts a folder of its own (the issues pane lists the issues, plans, the
// Build builds, the test writer writes tests first, verify prove and judge, the review follow-up reads review, the cleanup
// clears what is merged). The parts call one another as functions; the agents they send are registered, kept and guarded in one place.
// An event every part hears is hooked here once, and handed to each part in turn; a part hooks what is its own alone.

/** Each part's pane, by the name Claude asks it by: the verb of /theseus that opens it. */
const PANES = {
  issues: issuesView,
  plan: plannerView,
  build: buildView,
  tests: testsFirstView,
  verify: verifyView,
  'follow-up': followUpView,
  cleanup: cleanupView,
} as const

/** The names the panes had before /theseus, still read for one release. */
const OLD_PANES: Record<string, keyof typeof PANES> = { planner: 'plan', 'tests-first': 'tests' }

/** Each verb of /theseus that a part answers, and what it does. */
const VERBS = {
  plan: { usage: 'plan <issue | idea> [--again] [--auto]', does: 'plan an issue, or grill an idea into one; alone, the plan' },
  build: { usage: 'build [--auto] | errand <issue> | next | commit | submit | halt | abandon [run]', does: 'build the plan in a worktree, task by task; alone, the runs' },
  tests: { usage: 'tests [<behaviour>]', does: 'write the failing tests of a behaviour first; alone, those written' },
  verify: { usage: 'verify', does: 'the proof of the uncommitted change' },
  'follow-up': { usage: 'follow-up <pr> | answer [--auto] | close', does: "answer a pull request's review and failing checks" },
  cleanup: { usage: 'cleanup [clean [branch | pr]]', does: 'what is kept of merged pull requests; clean removes it' },
  issues: { usage: 'issues', does: 'the open issues' },
  doctor: { usage: 'doctor', does: 'what Theseus needs here, and how to fix what is missing' },
} as const

/** What a verb of /theseus answers: each part's command, called by name, as the engine follows `$` into a call. */
async function answerOf($: EngineInterface, verb: keyof typeof VERBS, args: string): Promise<{ text: string }> {
  switch (verb) {
    case 'plan':
      return planCommand($, args)
    case 'build':
      return buildCommand($, args)
    case 'tests':
      return testsCommand($, args)
    case 'verify':
      return verifyCommand($, args)
    case 'follow-up':
      return followUpCommand($, args)
    case 'cleanup':
      return cleanupCommand($, args)
    case 'issues':
      return issuesCommand($, args)
    case 'doctor':
      return { text: doctorText(await doctorOf($)) }
  }
}

/** What /theseus help answers. */
const HELP = [
  'Theseus takes an issue to a reviewed pull request.',
  '',
  ...[
    ['', 'what is running, and what failed'],
    ...Object.values(VERBS).map(verb => [verb.usage, verb.does]),
    ['troubles', 'what any part failed at this session'],
    ['help', 'this'],
  ].flatMap(([usage, does]) => [`  /theseus ${usage}`.trimEnd(), `      ${does}`]),
].join('\n')

/** What /theseus alone answers: the runs under way, and what failed. */
async function statusOf($: EngineInterface): Promise<string> {
  const runs = await runLeftovers($)
  const failed = troublesText()

  return [
    runs.length === 0 ? 'No run is under way.' : runs.map(run => `${run.ref}: ${run.phase}${run.pr !== '' ? `, ${run.pr}` : ''}`).join('\n'),
    ...(failed.startsWith('No part') ? [] : ['', 'Failed this session:', failed]),
    '',
    '/theseus help lists what it does.',
  ].join('\n')
}

const PANE_TOOL = {
  name: 'pane',
  description:
    'Reads one of the side panes as text: what it shows the person right now, or last showed. Each is opened by /theseus and its name: `issues` the open issues, `plan` the plan, `build` the runs, `tests` the tests written first, `verify` the proof of the change, `follow-up` the review comments, `cleanup` what is merged; `troubles` what any part has failed at this session, `doctor` what Theseus needs here and what is missing. Call it when the person speaks of a pane or of something only it shows, or when Theseus seems stuck.',
  inputSchema: { type: 'object', properties: { pane: { type: 'string', enum: [...Object.keys(PANES), 'troubles', 'doctor'] } }, required: ['pane'] },
} as const

/**
 * An agent of the mod's own that the record lost (sent where its spawn answered no id), found by its type and by the
 * part that sent it, and kept. One whose work cannot be found keeps its role, held to the project's own folder.
 * Nothing for an agent that is not the mod's.
 */
async function lost($: EngineInterface, agentId: string): Promise<SentAgent | undefined> {
  const role = await listedRole($, agentId)

  if (role === undefined) return undefined

  const root = await rootOf($)
  const agent = (role === 'builder' ? await builderFound($, agentId) : role === 'test-writer' ? await testWriterFound($, agentId) : role === 'planner' ? await plannerFound($, agentId) : undefined) ?? { role, root, tree: root }

  await remember($, agentId, agent)

  return agent
}

/**
 * Does what the parts were asked to do that may send an agent, in the hook that calls it: the planner's planner a press
 * asked for, the build's runs, the reviewers the session's own change is owed.
 */
async function pump($: EngineInterface): Promise<void> {
  pumped()
  await pumpPlanner($).catch(stumbled($, 'the planner'))
  await pumpBuild($).catch(stumbled($, 'the build'))
  await pumpVerify($).catch(stumbled($, 'verify'))
}

export const register: Register = (on, options) => {
  setBudget(options)

  on('session.start', async ($, e, next) => {
    // The record of the agents sent before a reload, then their types: a reload loads the module afresh
    await recall($)
    await registerAgents($)
    await carryStores($).catch(stumbled($, 'the store carry'))
    await carryFolder($).catch(stumbled($, 'the folder carry'))
    await offerTools($, [PANE_TOOL, FRAME_TOOL, PUMP_TOOL])
    await $.command.register({ name: 'theseus', description: 'Theseus: plan, build, test first, verify, follow up and clean up. /theseus help lists the verbs' }).catch(stumbled($, 'the /theseus command'))

    // A part the host refuses to start (a command name it holds) is said, and the parts after it start all the same
    await startPlanner($).catch(stumbled($, 'the planner'))
    await startTestsFirst($).catch(stumbled($, 'the test writer'))
    await startVerify($).catch(stumbled($, 'verify'))
    await startBuild($).catch(stumbled($, 'the build'))
    await startFollowUp($).catch(stumbled($, 'the review follow-up'))
    await startCleanup($).catch(stumbled($, 'the cleanup'))
    await startIssues($).catch(stumbled($, 'the issues pane'))
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

    if (agent !== undefined && agent.role !== 'other') await spentBuild($, agent, e).catch(stumbled($, 'the spend record'))

    await endedPlanner($, e).catch(stumbled($, 'the planner'))
    await endedTestsFirst($, e).catch(stumbled($, 'Tests first'))
    await endedVerify($, e).catch(stumbled($, 'verify'))
    await endedBuild($, e).catch(stumbled($, 'the build'))

    return next(e)
  })

  // A turn has ended: what it leads to is done here, where an agent sent is held. The hook that sends one is skipped for
  // that agent's own events, so two take turns: the one that did not send it carries on from its end. The session's
  // own turn sends only the reviewers its change is owed: a run's proof takes minutes, not kept from the person
  for (const reason of [/./, /[^]/]) {
    on('turn.complete', { reason }, async ($, e, next) => {
      await (e.agentId === undefined ? pumpVerify($) : pump($)).catch(stumbled($, 'the turn\'s end'))

      return next(e)
    }).catch((_$, e, next) => next(e))
  }

  // Claude is told what each part holds that bears on its work
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const added = [
      await sectionOfPlanner($).catch(stumbled($, 'the planner')),
      await sectionOfBuild($).catch(stumbled($, 'the build')),
      await sectionOfTestsFirst($).catch(stumbled($, 'Tests first')),
      await sectionOfVerify($).catch(stumbled($, 'verify')),
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
  registerVerify(on)
  registerBuild(on)
  registerFollowUp(on)
  registerCleanup(on)
  registerIssues(on)

  // Answered only from a hook: the clock calls it unanswered
  on('tool.call', { tool: 'mcp__theseus__frame' }, () => ({ result: FRAMED })).catch((_$, _e, next) => toolFailed('frame', next.error))

  // Claude was asked to: what waited outside a hook is done here
  on('tool.call', { tool: 'mcp__theseus__pump' }, async $ => {
    await pump($)

    return { result: 'Done: the panes say how it went.' }
  }).catch((_$, _e, next) => toolFailed('pump', next.error))

  // The one command: a verb each part answers, or what is running, or the help
  on('command.run', { command: 'theseus' }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().split(/\s+/).filter(word => word !== '')

    if (verb === '') return { text: await statusOf($) }
    if (verb === 'help') return { text: HELP }
    if (verb === 'troubles') return { text: troublesText() }
    if (verb in VERBS) return answerOf($, verb as keyof typeof VERBS, rest.join(' '))

    return { text: `/theseus does not know ${verb}.\n\n${HELP}` }
  })

  on('tool.call', { tool: 'mcp__theseus__pane' }, async ($, e) => {
    const named = String((e as unknown as { pane?: unknown }).pane ?? '')

    if (named === 'troubles') return { result: troublesText() }
    if (named === 'doctor') return { result: doctorText(await doctorOf($)) }

    const pane = OLD_PANES[named] ?? named

    const view = pane in PANES ? PANES[pane as keyof typeof PANES] : undefined

    return view === undefined ? { result: `There is no pane named ${named}: ${[...Object.keys(PANES), 'troubles'].join(', ')}.` } : view.answer(() => $.ui.panes())
  }).catch((_$, _e, next) => toolFailed('pane', next.error))
}
