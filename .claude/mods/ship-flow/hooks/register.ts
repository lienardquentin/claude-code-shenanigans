import type { EngineInterface, Register } from 'claude-code'

import { fillOf, settingsOf } from './budget'
import { readFolders } from './folders'
import type { Host } from './host'
import { SCRATCH } from './run'
import { IMPLEMENTER, IMPLEMENTER_PROMPT, IMPLEMENTER_TOOLS, checkTool, complete, measure, resume } from './runner'
import { statusText } from './status'

const USAGE = 'Usage: /ship status, or /ship resume [feature]. Starting a run from an idea is not built yet.'

// The engine as the rest of the mod uses it: `$` is followed only inside this file, so it stops here
const hostOf = ($: EngineInterface): Host => ({
  exists: path => $.fs.exists(path),
  read: path => $.fs.read(path),
  write: (path, text) => $.fs.write(path, text),
  list: async path => (await $.fs.list(path)).map(entry => ({ name: entry.name, isDir: entry.kind === 'dir' })),
  run: (argv, timeoutMs) => $.process.run(argv, timeoutMs === undefined ? {} : { timeoutMs }),
  spawn: async agent => {
    const { agentId, model, deny } = await $.agent.spawn(agent)

    return { ...(agentId !== undefined ? { agentId } : {}), ...(model !== undefined ? { model } : {}), ...(deny !== undefined ? { deny } : {}) }
  },
  abort: turnId => $.turn.abort({ turnId }),
  agents: async () =>
    (await $.agent.list()).map(agent => ({ id: agent.id, type: agent.type, isRunning: agent.status === 'running' })),
  usage: async () => {
    const { context, rateLimits } = await $.session.usage()

    return {
      ...(context.percent !== undefined ? { contextPercent: context.percent } : {}),
      quota: rateLimits.map(({ kind, percentUsed, resetsAt }) => ({
        kind,
        percentUsed,
        ...(resetsAt !== undefined ? { resetsAt } : {}),
      })),
    }
  },
  now: async () => $.clock.now(),
  cwd: () => $.session.cwd(),
  log: text => $.ui.log(text),
  // Sent or not is the person's own setting: the run does not wait to know
  notify: text => void $.ui.notify(text, { title: 'ship-flow' }).catch(() => undefined),
  after: (ms, fn) => void $.clock.after(ms, fn),
})

export const register: Register = (on, options) => {
  const settings = settingsOf(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'ship',
      description: 'Takes one feature from an idea or an issue to a pull request',
      argumentHint: 'status | resume [feature]',
    })
    await $.agent.register({
      name: IMPLEMENTER,
      description: 'Builds one ticket of a ship-flow run. Started by the run itself, never by hand.',
      prompt: IMPLEMENTER_PROMPT,
      tools: IMPLEMENTER_TOOLS,
      model: settings.implementerModel,
    })

    return next(e)
  })

  // The implementer is the run's to start: the model is never offered it
  on('agent.offer', { agent: 'ship-flow:implementer' }, () => ({ isOffered: false })).catch(() => ({ isOffered: false }))

  on('command.run', { command: 'ship' }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().split(/\s+/)

    if (verb === 'status') return { text: statusText(await readFolders(hostOf($))) }
    if (verb === 'resume') return { text: await resume(hostOf($), settings, rest.join(' ')) }

    return { text: USAGE }
  })
    // What went wrong is said in the answer: a hook that throws is skipped without a word
    .catch(() => ({ text: `ship-flow could not read or write the run's files under ${SCRATCH}.` }))

  // Every tool call of a run's implementer is decided here, so that none is ever put to a person who is not there
  on('tool.check', async ($, e, next) => {
    const decided = e.agentId === undefined ? undefined : await checkTool(hostOf($), e.agentId, e.tool, e.input)

    return decided ?? next(e)
  })
    // A run whose files cannot be read decides nothing: the session's own decision stands
    .catch(($, e, next) => next(e))

  // Each response of a subagent says how full its context was: an implementer past its budget is stopped there
  on('turn.step', async function* ($, e, next) {
    const response = yield* next(e)

    if (e.agentId !== undefined && response.usage) {
      await measure(hostOf($), settings, { agentId: e.agentId, turnId: e.turnId, tokens: fillOf(response.usage) })
    }

    return response
  })
    // A response is never held back by the run: what the model answered stands
    .catch(async function* ($, e, next) {
      return yield* next(e)
    })

  on('turn.complete', async ($, e, next) => {
    const completed = await next(e)

    if (e.agentId !== undefined) await complete(hostOf($), settings, { agentId: e.agentId, reason: e.reason })

    return completed
  })
}
