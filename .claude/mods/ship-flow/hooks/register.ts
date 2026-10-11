import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { afterTurn, begin, noteRead, reminder } from './attended'
import { fillOf, settingsOf } from './budget'
import { REVIEWER, REVIEWER_PROMPT, REVIEWER_TOOLS } from './finisher'
import { readFolders } from './folders'
import type { Host } from './host'
import { PANE, paneOf } from './pane'
import { reader } from './reading'
import { SCRATCH } from './run'
import { IMPLEMENTER, IMPLEMENTER_PROMPT, IMPLEMENTER_TOOLS, checkTool, complete, measure, resume } from './runner'
import { statusText } from './status'

// How many times a run wrote its files this session: the pane reads it, so each write draws the pane again
const changes = atom({ plugin: 'ship-flow', key: 'changes' } as const, 0)

const USAGE = [
  'Usage:',
  '  /ship <idea>            start a run from an idea',
  '  /ship #<issue>          start a run from a GitHub issue',
  '  /ship resume [feature]  approve the checkpoint, or take a run up again',
  '  /ship status            how every run of this repo stands',
  '  /ship pane              the same, live, in a pane',
].join('\n')

// The engine as the rest of the mod uses it: `$` is followed only inside this file, so it stops here
const hostOf = ($: EngineInterface): Host => ({
  exists: path => $.fs.exists(path),
  read: path => $.fs.read(path),
  write: (path, text) => $.fs.write(path, text),
  list: async path => (await $.fs.list(path)).map(entry => ({ name: entry.name, isDir: entry.kind === 'dir' })),
  run: (argv, init) => $.process.run(argv, init ?? {}),
  spawn: async agent => {
    const { agentId, model, deny } = await $.agent.spawn(agent)

    return { ...(agentId !== undefined ? { agentId } : {}), ...(model !== undefined ? { model } : {}), ...(deny !== undefined ? { deny } : {}) }
  },
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
  root: $.plugin.root,
  changed: () => void update($, changes, count => count + 1).catch(() => undefined),
  // Both wait on the session being idle, which it is not inside the command's own hook: the engine refuses them
  // there, so they are made from a timer, once the hook has returned
  prompt: text =>
    void $.clock.after(0, () => {
      void $.prompt.submit({ text }).catch((error: unknown) => $.ui.log(`the prompt was not taken: ${String(error)}`))
    }),
  compact: instructions =>
    void $.clock.after(0, () => {
      void $.session
        .compact({ instructions })
        .catch((error: unknown) => $.ui.log(`the conversation was not compacted: ${String(error)}`))
    }),
  log: text => $.ui.log(text),
  // Sent or not is the person's own setting: the run does not wait to know
  notify: text => void $.ui.notify(text, { title: 'ship-flow' }).catch(() => undefined),
  after: (ms, fn) => void $.clock.after(ms, fn),
})

export const register: Register = (on, options) => {
  const settings = settingsOf(options)
  // What the pane read of the repo, kept by commit
  const repo = reader()

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'ship',
      description: 'Takes one feature from an idea or an issue to a pull request',
      argumentHint: '<idea> | #<issue> | resume [feature] | status',
    })
    await $.agent.register({
      name: IMPLEMENTER,
      description: 'Builds one ticket of a ship-flow run. Started by the run itself, never by hand.',
      prompt: IMPLEMENTER_PROMPT,
      tools: IMPLEMENTER_TOOLS,
      model: settings.implementerModel,
    })
    await $.agent.register({
      name: REVIEWER,
      description: 'Reviews the branch of a ship-flow run against its spec. Started by the run itself, never by hand.',
      prompt: REVIEWER_PROMPT,
      tools: REVIEWER_TOOLS,
      model: settings.strongModel,
    })

    const started = await next(e)
    // A run that is not building is said once, as the session starts; saying it must never keep a session from starting
    const told = await reminder(hostOf($)).catch(() => undefined)

    if (told !== undefined) $.ui.log(told)

    return started
  })

  on('ui.render', { component: 'Pane', requestId: 'ship-flow' }, async ($, e) => {
    // Read so that the pane is drawn again each time a run writes
    await read($, changes)

    const host = hostOf($)

    const folders = await readFolders(host)
    // The repo is read only for a card that shows a radius, and a failed read leaves the reach as declared files alone
    const reading = folders.some(folder => folder.record?.phase !== 'ended' && folder.tickets.some(ticket => ticket.touches !== undefined))
      ? await repo.read(host).catch(() => undefined)
      : undefined

    return paneOf($.ui.resolve(e), {
      folders,
      ...(reading ? { reading } : {}),
      width: e.props.bodyColumns ?? 80,
      settings,
      onResume: feature =>
        void resume(host, settings, feature)
          .then(text => $.ui.log(text))
          .catch(() => $.ui.log(`${feature}: could not be taken up from the pane. /ship resume ${feature}.`)),
      onRefresh: () => {
        repo.forget()
        host.changed()
      },
    })
  })

  // The model reading one of the mod's step texts is how the attended phase is seen to pass from a step to the next
  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    await noteRead(hostOf($), e.file_path).catch(() => undefined)

    return next(e)
  })
    // A read is never held back by the run
    .catch(($, e, next) => next(e))

  // The run's agents are the run's to start: the model is never offered them
  on('agent.offer', { agent: 'ship-flow:implementer' }, () => ({ isOffered: false })).catch(() => ({ isOffered: false }))
  on('agent.offer', { agent: 'ship-flow:reviewer' }, () => ({ isOffered: false })).catch(() => ({ isOffered: false }))

  on('command.run', { command: 'ship' }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().split(/\s+/)

    if (verb === 'status') return { text: statusText(await readFolders(hostOf($))) }
    if (verb === '') return { text: USAGE }
    if (verb === 'pane') {
      const { isPlaced } = await $.ui.open({ id: PANE, title: 'ship-flow' })

      return { text: isPlaced ? 'The ship-flow pane is open.' : 'The ship-flow pane will show once there is room for it.' }
    }

    // A run that starts or goes on is worth watching: its pane opens beside it, where there is room
    void $.ui.open({ id: PANE, title: 'ship-flow' }).catch(() => undefined)

    if (verb === 'resume') return { text: await resume(hostOf($), settings, rest.join(' ')) }

    return { text: await begin(hostOf($), settings, e.args.trim()) }
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
      await measure(hostOf($), settings, { agentId: e.agentId, tokens: fillOf(response.usage) })
    }

    return response
  })
    // A response is never held back by the run: what the model answered stands
    .catch(async function* ($, e, next) {
      return yield* next(e)
    })

  on('turn.complete', async ($, e, next) => {
    const completed = await next(e)

    if (e.agentId !== undefined) {
      await complete(hostOf($), settings, { agentId: e.agentId, reason: e.reason, answer: e.answer })
    } else {
      await afterTurn(hostOf($), settings)
    }

    return completed
  })
}
