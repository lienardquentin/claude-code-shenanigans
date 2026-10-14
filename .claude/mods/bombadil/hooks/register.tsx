import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { BombadilErrand, BombadilPhase, BombadilWanted } from '../types'
import { BOMBADIL_EFFORT, BOMBADIL_MODEL, BOMBADIL_SYSTEM, HOW_TO, MAX_TRIES, NO_ERRAND, branchOf, issueOf, requestArgv, commitMessage, errandPrompt, errandText, isForbiddenGit, isModPath, parseJudgement, prBody, proofVerdict, purposeOf } from './errand'
import { badge } from './kit/badge'
import type { Tone } from './kit/badge'
import { paneView } from './kit/pane-text'

type $ = EngineInterface

const PANE = 'bombadil'
const TITLE = 'Bombadil'
const AGENT = 'tom'
const AGENT_TYPE = `bombadil:${AGENT}`
const TICK_MS = 500
// How long the forge is given to take a push or open a pull request
const FORGE_TIMEOUT_MS = 120_000
// How many ticks pass between two looks at Isildur's judgement
const JUDGE_EVERY = 6

const errand = atom({ plugin: 'bombadil', key: 'errand' } as const, null as BombadilErrand | null)
const note = atom({ plugin: 'bombadil', key: 'note' } as const, '')
const wanted = atom({ plugin: 'bombadil', key: 'wanted' } as const, '' as BombadilWanted)
const working = atom({ plugin: 'bombadil', key: 'working' } as const, '')

const view = paneView({ id: PANE, title: TITLE, command: '/bombadil' })

const TOOLS = [
  {
    name: 'errand',
    description:
      "Sends Tom Bombadil on an issue too small for the Council of Elrond and the Fellowship: on a branch of its own he builds the whole issue in one change, Argonath proves it, Isildur judges it, and it is committed; the pull request then waits for the person's go. He hands an issue back when it is no errand. Call it when the person asks for an issue to be done as an errand.",
    inputSchema: { type: 'object', properties: { issue: { type: 'string', description: 'The issue: its URL, owner/repo#12, or #12 for this repository.' } }, required: ['issue'] },
  },
  {
    name: 'relics',
    description: "The errand Bombadil keeps, as JSON: its issue, branch, base, pull request and phase. For Mount Doom.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'forget',
    description: 'Forgets the errand once its pull request is merged from its branch, which the forge is asked; one not merged is kept. For Mount Doom.',
    inputSchema: { type: 'object', properties: { ref: { type: 'string' }, pr: { type: 'string', description: 'The merged pull request, by its URL.' } }, required: ['ref', 'pr'] },
  },
  {
    name: 'status',
    description: "Where Tom Bombadil's errand stands: its phase, the last proof, Isildur's verdict, the commit and the pull request.",
    inputSchema: { type: 'object', properties: {} },
  },
] as const

const PHASE_TONE: Record<BombadilPhase, Tone> = { singing: 'info', proving: 'info', judging: 'info', home: 'accent', stuck: 'danger', refused: 'warning', sailed: 'success' }

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** A tool of another mod, through the engine's MCP connection: its text, or why it did not answer. */
const ask = async ($: $, server: string, tool: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> => {
  try {
    const got = await $.mcp.call(server, tool, args)

    return { text: got.content.map(block => ('text' in block && typeof block.text === 'string' ? block.text : '')).join('\n'), isError: got.isError }
  } catch (error) {
    return { text: `${server} did not answer ${tool}: ${errorText(error)}`, isError: true }
  }
}

const git = async ($: $, args: readonly string[]): Promise<{ ok: boolean; out: string }> => {
  const ran = await $.process.run(['git', ...args], { cwd: await $.session.cwd() }).catch((error: unknown) => ({ exitCode: -1, stdout: '', stderr: errorText(error) }))

  return { ok: ran.exitCode === 0, out: (ran.exitCode === 0 ? ran.stdout : ran.stderr || ran.stdout).trim() }
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

const keep = async ($: $, change: (was: BombadilErrand) => BombadilErrand): Promise<void> => {
  await update($, errand, was => (was === null ? was : change(was)))
}

const tell = async ($: $, text: string): Promise<void> => {
  $.ui.toast(`Bombadil: ${text}`)
  await $.ui.notify(text, { title: 'Bombadil' }).catch(() => undefined)
}

/** Sends him on an issue: read through Elrond, from a clean tree, on a branch of its own. Answers what was done, in a sentence. */
const begin = async ($: $, input: string): Promise<string> => {
  const held = await read($, errand)

  if (held !== null && held.phase !== 'sailed' && held.phase !== 'refused') return `Bombadil is on ${held.ref} (${held.phase}): see it home, or /bombadil drop it, before another.`

  let issue: { ref?: string; url?: string; title?: string; body?: string; comments?: { author: string; body: string }[]; error?: string }

  try {
    issue = JSON.parse((await ask($, 'elrond', 'issue', { issue: input })).text) as typeof issue
  } catch {
    return 'Elrond did not read the issue: is the Elrond mod loaded?'
  }

  if (issue.error !== undefined || issue.ref === undefined) return issue.error ?? 'Elrond read no issue.'

  const dirty = await git($, ['status', '--porcelain'])

  if (dirty.out !== '') return 'The working tree has uncommitted changes: commit or stash them first. The errand is proven against HEAD and committed alone.'

  const base = (await git($, ['rev-parse', '--abbrev-ref', 'HEAD'])).out
  const branch = branchOf(issue.ref, issue.title ?? '')
  const exists = await git($, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])

  if (exists.ok) return `${branch} is there already: /bombadil drop clears an errand left before, or delete the branch.`

  const switched = await git($, ['switch', '-c', branch])

  if (!switched.ok) return `The errand could not take the branch ${branch}: ${switched.out}`

  const thread = (issue.comments ?? []).map(one => `--- ${one.author}:\n${one.body}`).join('\n\n')
  const made: BombadilErrand = { ref: issue.ref, url: issue.url ?? '', title: issue.title ?? '', body: [issue.body ?? '', thread].filter(one => one.trim() !== '').join('\n\n'), branch, base, phase: 'singing', agentId: '', tries: 0, answer: '', proof: '', proofLine: '', verdictLine: '', minor: [], sha: '', pr: '', at: Date.now() }

  await update($, errand, () => made)
  await update($, note, () => '')
  await $.ui.open({ id: PANE, title: TITLE }).catch(() => undefined)

  return (await send($, 1)) ?? `Tom Bombadil sets off on ${made.ref}, "${made.title}", on ${branch} from ${base}.`
}

/** Sends him, on a first try or a second with what stopped the first. Answers why he could not be sent, if he could not. */
const send = async ($: $, tries: number, retry?: { answer: string; proof?: string; findings?: string[] }): Promise<string | undefined> => {
  const held = await read($, errand)

  if (held === null) return HOW_TO

  const started = await $.agent.spawn({ subagentType: AGENT_TYPE, description: `Bombadil: ${held.ref}`, prompt: errandPrompt(held, retry) }).catch((error: unknown) => ({ deny: errorText(error), agentId: undefined }))

  if (started.deny !== undefined) {
    await keep($, was => ({ ...was, phase: 'stuck' }))
    await update($, note, () => `Bombadil could not be sent: ${started.deny}`)

    return `Bombadil could not be sent: ${started.deny}`
  }

  await keep($, was => ({ ...was, phase: 'singing', tries, agentId: started.agentId ?? '', verdictLine: '' }))

  return undefined
}

/** A try that did not pass: sent again with what stopped it, or, his tries spent, stopped for the person. */
const again = async ($: $, why: { proof?: string; findings?: string[] }, line: string): Promise<void> => {
  const held = await read($, errand)

  if (held === null) return
  if (held.tries < MAX_TRIES) {
    await send($, held.tries + 1, { answer: held.answer, ...why })

    return
  }

  await keep($, was => ({ ...was, phase: 'stuck' }))
  await update($, note, () => `${held.ref} did not pass after ${held.tries} tries: ${line}. Finish it by hand, or /bombadil drop it and take it to /elrond.`)
  await tell($, `${held.ref} is stuck: ${line}`)
}

/** Proves what he built: settled, Isildur judges it; else he tries again. */
const prove = async ($: $): Promise<void> => {
  const held = await read($, errand)

  if (held === null || held.phase !== 'proving') return

  await update($, working, () => `Argonath proves ${held.ref}…`)

  const proof = await ask($, 'argonath', 'prove')
  const verdict = proof.isError ? { isSettled: false, line: proof.text } : proofVerdict(proof.text)

  await keep($, was => ({ ...was, proof: proof.text, proofLine: verdict.line }))

  if (!verdict.isSettled) return again($, { proof: proof.text }, verdict.line)

  await update($, working, () => `Isildur judges ${held.ref}…`)
  await keep($, was => ({ ...was, phase: 'judging', verdictLine: 'judging' }))
  await settle($, parseJudgement((await ask($, 'argonath', 'judgement', { convene: true, json: true, about: purposeOf(held), statues: ['isildur'] })).text))
}

/** What Isildur's verdict comes to: committed when he passes it, sent back when he finds what blocks it. */
const settle = async ($: $, judged: ReturnType<typeof parseJudgement>): Promise<void> => {
  const held = await read($, errand)

  if (held === null || held.phase !== 'judging' || judged.verdict === 'sitting') return
  if (judged.verdict === 'pass') return commit($, judged.minor)
  if (judged.verdict === 'fail') return again($, { findings: judged.blocking }, `${judged.blocking.length} blocking ${judged.blocking.length === 1 ? 'finding' : 'findings'}`)

  if (judged.verdict === 'stale' || judged.verdict === 'unsettled' || judged.verdict === 'none') {
    await keep($, was => ({ ...was, phase: 'proving' }))
    await update($, wanted, () => 'prove')

    return
  }

  await keep($, was => ({ ...was, phase: 'stuck', verdictLine: judged.verdict }))
  await update($, note, () => `Isildur could not judge ${held.ref} (${judged.verdict}).`)
}

/** Commits the change Isildur passed, and waits for the person's go. */
const commit = async ($: $, minor: readonly string[]): Promise<void> => {
  await keep($, was => ({ ...was, minor: [...minor], verdictLine: `passed${minor.length > 0 ? `, ${minor.length} minor` : ''}` }))

  const held = await read($, errand)

  if (held === null) return

  const dirty = await git($, ['status', '--porcelain'])
  let sha = ''

  if (dirty.out !== '') {
    const added = await git($, ['add', '-A'])
    const done = added.ok ? await git($, ['commit', '-m', commitMessage(held)]) : added

    if (!done.ok) {
      await keep($, was => ({ ...was, phase: 'stuck' }))
      await update($, note, () => `The errand could not be committed: ${done.out}`)

      return
    }

    sha = (await git($, ['rev-parse', 'HEAD'])).out
  }

  await keep($, was => ({ ...was, phase: 'home', sha }))
  await tell($, `${held.ref} is done and committed${sha === '' ? '' : ` as ${sha.slice(0, 7)}`}: say go, and /bombadil sail opens its pull request`)
}

/** Pushes the branch and opens the pull request, at the person's word alone. Answers what was done, in a sentence. */
const sail = async ($: $): Promise<string> => {
  const held = await read($, errand)

  if (held === null) return HOW_TO
  if (held.phase === 'sailed') return `The pull request is open: ${held.pr}`
  if (held.phase !== 'home') return `The errand is ${held.phase}: it sails once it is committed.`

  await update($, working, () => `Pushing ${held.branch}…`)

  const cwd = await $.session.cwd()
  const failed = (error: unknown) => ({ exitCode: -1, stdout: '', stderr: errorText(error) })
  const pushed = await $.process.run(['git', 'push', '-u', 'origin', held.branch], { cwd, timeoutMs: FORGE_TIMEOUT_MS }).catch(failed)

  if (pushed.exitCode !== 0) return `${held.branch} could not be pushed: ${pushed.stderr.trim() || `git exited with ${pushed.exitCode}`}`

  await update($, working, () => 'Opening the pull request…')

  const argv = requestArgv({ forge: issueOf(held.ref)?.forge ?? 'github', branch: held.branch, base: held.base, title: held.title, body: prBody(held) })
  const opened = await $.process.run(argv, { cwd, timeoutMs: FORGE_TIMEOUT_MS }).catch(failed)

  if (opened.exitCode !== 0) return `The pull request could not be opened: ${argv[0] ?? ''} said ${opened.stderr.trim() || `it exited with ${opened.exitCode}`}`

  const url = [...`${opened.stdout}\n${opened.stderr}`.matchAll(/https?:\/\/\S+/g)].map(found => found[0]).pop() ?? ''

  await keep($, was => ({ ...was, phase: 'sailed', pr: url }))
  await tell($, `the pull request for ${held.ref} is open${url === '' ? '' : `: ${url}`}`)

  return `The errand has sailed: the pull request that closes ${held.ref} is open${url === '' ? '' : ` at ${url}`}.`
}

/** Drops the errand: back on the branch it started from, its branch deleted, and forgotten. Nothing on the forge is touched. */
const drop = async ($: $): Promise<string> => {
  const held = await read($, errand)

  if (held === null) return 'No errand is kept: there is nothing to drop.'
  if (held.phase === 'singing' || held.phase === 'proving' || held.phase === 'judging') return `The errand is ${held.phase}: wait for it to settle, then drop it.`

  const current = await git($, ['rev-parse', '--abbrev-ref', 'HEAD'])

  if (current.out === held.branch) {
    const dirty = await git($, ['status', '--porcelain'])

    if (dirty.out !== '') return `${held.branch} has uncommitted changes: commit, stash or drop them, then drop the errand.`

    const back = await git($, ['switch', held.base])

    if (!back.ok) return `Could not go back to ${held.base}: ${back.out}`
  }

  const deleted = await git($, ['branch', '-D', held.branch])

  await update($, errand, () => null)
  await update($, note, () => '')

  return `The errand on ${held.ref} is dropped${deleted.ok ? `, and ${held.branch} deleted` : ''}.${held.pr !== '' ? ` Its pull request, ${held.pr}, is left as it is.` : ''}`
}

let isBusy = false
let ticks = 0

/** Does what a turn or a press asked for, one thing at a time; while Isildur sits, looks at his judgement now and then. */
const tick = async ($: $): Promise<void> => {
  if (isBusy) return

  const asked = await read($, wanted)

  if (asked === '') {
    ticks += 1
    if (ticks % JUDGE_EVERY !== 0 || (await read($, errand))?.phase !== 'judging') return
  }

  isBusy = true
  if (asked !== '') await update($, wanted, () => '')

  try {
    if (asked === '') await settle($, parseJudgement((await ask($, 'argonath', 'judgement', { json: true })).text))
    else if (asked === 'prove') await prove($)
    else {
      const said = await sail($)

      await update($, note, () => said)
    }
  } catch (error) {
    await update($, note, () => `The errand stumbled: ${errorText(error)}`)
  } finally {
    isBusy = false
    await update($, working, () => '')
  }
}

const alone = async <T,>($: $, run: () => Promise<T>): Promise<T> => {
  isBusy = true

  try {
    return await run()
  } finally {
    isBusy = false
    await update($, working, () => '')
  }
}

/** Whether an agent is Bombadil on the errand: by the id his spawn answered, else, where it answered none, by his type. */
const isTom = async ($: $, held: BombadilErrand | null, agentId: string): Promise<boolean> => {
  if (held === null || held.phase !== 'singing') return false

  return held.agentId !== '' ? agentId === held.agentId : (await $.agent.list().catch(() => [])).some(one => one.id === agentId && one.type === AGENT_TYPE && one.status === 'running')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'bombadil', description: 'Run a small issue as an errand: /bombadil <issue> builds it in one change; /bombadil sail opens its pull request; /bombadil drop gives it up' })
    await $.agent
      .register({
        name: AGENT,
        description: 'Tom Bombadil: builds a small issue whole in one change, proven by Argonath. Sent by the Bombadil mod alone.',
        prompt: BOMBADIL_SYSTEM,
        tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash', 'mcp__argonath__radius', 'mcp__argonath__prove'],
        permissionMode: 'acceptEdits',
        disallowedTools: ['Agent', 'mcp__argonath__judgement'],
        model: BOMBADIL_MODEL,
        effort: BOMBADIL_EFFORT,
      })
      .catch(() => undefined)

    for (const tool of [view.tool, ...TOOLS]) await $.tool.register(tool).catch(() => undefined)

    $.clock.every(TICK_MS, () => void tick($).catch(() => undefined))
    $.ui.invalidate('ui.render')

    return next(e)
  })

  on('agent.offer', { agent: AGENT_TYPE }, () => ({ isOffered: false }))

  // His turn has ended: what he built is proven, outside this hook; an issue he hands back goes to the Council
  on('turn.complete', async ($, e, next) => {
    const held = await read($, errand)

    if (held !== null && e.agentId !== undefined && (await isTom($, held, e.agentId))) {
      const answer = e.answer ?? ''
      const refused = answer.split('\n').find(line => line.trim().startsWith(NO_ERRAND))

      if (e.isAborted || e.reason !== 'answer') {
        await keep($, was => ({ ...was, phase: 'stuck', answer }))
        await update($, note, () => `Bombadil ${e.isAborted ? 'was interrupted' : e.reason === 'refusal' ? 'refused' : 'ended on an API error'}.`)
      } else if (refused !== undefined) {
        await keep($, was => ({ ...was, phase: 'refused', answer }))
        await update($, note, () => `${refused.trim()} /bombadil drop, then /elrond ${held.ref}.`)
        await tell($, `${held.ref} is no errand: it goes to the Council`)
      } else {
        await keep($, was => ({ ...was, phase: 'proving', answer }))
        await update($, wanted, () => 'prove')
      }
    }

    return next(e)
  })

  // He builds the issue, and leaves the branch, the commit and the mods' folders to the errand
  on('tool.call', async ($, e, next) => {
    const given = e as unknown as { tool: string; agentId?: string; command?: unknown; file_path?: unknown }

    if (given.agentId === undefined || !(await isTom($, await read($, errand), given.agentId))) return next(e)
    if (given.tool === 'Bash' && typeof given.command === 'string' && isForbiddenGit(given.command)) return { deny: 'The errand commits and keeps the branch: leave your change uncommitted, and run no git command that moves HEAD or the index.' }
    if (typeof given.file_path === 'string' && isModPath(await $.session.cwd(), given.file_path)) return { deny: 'That folder belongs to a mod: change the project, not what the mods keep.' }

    return next(e)
  }).catch((_$, e, next) => next(e))

  on('tool.call', { tool: 'mcp__bombadil__pane' }, $ => view.answer(() => $.ui.panes()))

  on('tool.call', { tool: 'mcp__bombadil__errand' }, async ($, e) => ({ result: await alone($, () => begin($, String((e as unknown as { issue?: unknown }).issue ?? ''))) }))

  on('tool.call', { tool: 'mcp__bombadil__relics' }, async $ => {
    const held = await read($, errand)

    return { result: JSON.stringify(held === null ? [] : [{ ref: held.ref, branch: held.branch, base: held.base, pr: held.pr, phase: held.phase }]) }
  })

  on('tool.call', { tool: 'mcp__bombadil__forget' }, async ($, e) => {
    const given = e as unknown as { ref?: unknown; pr?: unknown }
    const held = await read($, errand)

    if (held === null || held.ref !== given.ref) return { result: `No errand on ${String(given.ref ?? '')} is kept.` }
    if (!(await isMergedFrom($, String(given.pr ?? ''), held.branch))) return { result: `${String(given.pr ?? '')} is not a merged pull request from ${held.branch}: the errand is kept.` }

    await update($, errand, () => null)

    return { result: `The errand on ${held.ref} is forgotten.` }
  })

  on('tool.call', { tool: 'mcp__bombadil__status' }, async $ => {
    const held = await read($, errand)

    return { result: held === null ? HOW_TO : errandText(held) }
  })

  // Pushing and opening the pull request reach outside the machine: no tool offers them to Claude, and the person sails
  // with /bombadil sail or the pane
  on('command.run', { command: 'bombadil' }, async ($, e) => {
    const said = e.args.trim()

    await $.ui.open({ id: PANE, title: TITLE })

    if (said === 'sail') return { text: await alone($, () => sail($)) }
    if (said === 'drop') return { text: await alone($, () => drop($)) }

    if (said === '') {
      const held = await read($, errand)

      return { text: held === null ? HOW_TO : errandText(held) }
    }

    return { text: await alone($, () => begin($, said)) }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const held = await read($, errand)
    const problem = await read($, note)
    const busy = await read($, working)

    if (held === null) {
      return view.keep(
        <Box flexDirection="column" gap={1}>
          {badge({ label: 'no errand', tone: 'neutral' })}
          <Text dimColor>{HOW_TO}</Text>
        </Box>,
      )
    }

    return view.keep(
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={2}>
          {badge({ label: held.phase, tone: PHASE_TONE[held.phase] })}
          <Text bold wrap="truncate-end">{held.title}</Text>
        </Box>
        <Text dimColor>{`${held.ref} · ${held.branch} ← ${held.base}${held.tries > 0 ? ` · try ${held.tries} of ${MAX_TRIES}` : ''}`}</Text>
        {busy !== '' && <Text color="suggestion">{busy}</Text>}
        {problem !== '' && <Text color="warning">{problem}</Text>}
        {held.proofLine !== '' && <Text color={held.phase === 'proving' || held.phase === 'stuck' ? 'warning' : 'success'}>{`Argonath's proof: ${held.proofLine}`}</Text>}
        {held.verdictLine !== '' && <Text color={held.verdictLine.startsWith('passed') ? 'success' : 'suggestion'}>{`Isildur: ${held.verdictLine}`}</Text>}
        {held.minor.map(line => (
          <Text key={line} dimColor>{`  ${line}`}</Text>
        ))}
        {held.sha !== '' && <Text color="success">{`Committed as ${held.sha.slice(0, 7)}`}</Text>}
        {held.pr !== '' && <Text color="success">{`Pull request: ${held.pr}`}</Text>}
        <Box flexDirection="row" gap={1}>
          {held.phase === 'home' && (
            <Button key="sail" hotkey="p" variant="primary" onPress={() => update($, wanted, () => 'sail')}>
              Go: push and open the pull request
            </Button>
          )}
          {held.phase !== 'singing' && held.phase !== 'proving' && held.phase !== 'judging' && (
            <Button key="drop" hotkey="d" onPress={() => alone($, () => drop($)).then(said => update($, note, () => said))}>
              Drop the errand
            </Button>
          )}
        </Box>
      </Box>,
    )
  })
}
