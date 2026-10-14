import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { MountdoomRelic } from '../types'
import { HOW_TO, KEEPERS, findArgv, foundUrl, gathered, isIssueRef, relicLine, relicsText } from './doom'
import { badge } from './kit/badge'
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

const PANE = 'mountdoom'
const TITLE = 'Mount Doom'
// How often the forge is asked whether what is kept is merged
const WATCH_MS = 10 * 60_000
// The first look waits for the other mods to have registered their tools
const FIRST_LOOK_MS = 30_000
const FORGE_TIMEOUT_MS = 60_000

const relics = atom({ plugin: 'mountdoom', key: 'relics' } as const, [] as MountdoomRelic[])
const told = atom({ plugin: 'mountdoom', key: 'told' } as const, [] as string[])
const note = atom({ plugin: 'mountdoom', key: 'note' } as const, '')
const wanted = atom({ plugin: 'mountdoom', key: 'wanted' } as const, '')

// How often the clock looks for what a command asked of it
const TICK_MS = 500
const working = atom({ plugin: 'mountdoom', key: 'working' } as const, '')

const view = paneView({ id: PANE, title: TITLE, command: '/mountdoom' })

const TOOLS = [
  {
    name: 'relics',
    description: "What Mount Doom watches: each branch the Fellowship, Bombadil or the Black Gate keeps work of, its pull request, and whether it is merged and ready for the fire. Casting it is the person's: /mountdoom cast.",
    inputSchema: { type: 'object', properties: {} },
  },
] as const

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const ask = async ($: $, server: string, tool: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> => {
  try {
    const got = await $.mcp.call(server, tool, args)

    return { text: got.content.map(block => ('text' in block && typeof block.text === 'string' ? block.text : '')).join('\n'), isError: got.isError }
  } catch (error) {
    return { text: `${server} did not answer ${tool}: ${errorText(error)}`, isError: true }
  }
}

/** Has a mod forget what it keeps of a relic, and says whether it did, as the mod answers it in JSON. */
const forgets = async ($: $, keeper: string, args: Record<string, unknown>): Promise<boolean> => {
  const got = await ask($, keeper, 'forget', { ...args, json: true })

  try {
    return !got.isError && (JSON.parse(got.text) as { forgotten?: unknown }).forgotten === true
  } catch {
    return false
  }
}

const run = async ($: $, argv: readonly string[]): Promise<{ ok: boolean; out: string }> => {
  const ran = await $.process.run(argv, { cwd: await rootOf($), timeoutMs: FORGE_TIMEOUT_MS }).catch((error: unknown) => ({ exitCode: -1, stdout: '', stderr: errorText(error) }))

  return { ok: ran.exitCode === 0, out: (ran.exitCode === 0 ? ran.stdout : ran.stderr || ran.stdout).trim() }
}

const git = ($: $, args: readonly string[]) => run($, ['git', ...args])

/** Whether the forge says a pull request is merged from a branch. */
const isMergedFrom = async ($: $, url: string, branch: string): Promise<boolean> => {
  if (!/^https?:\/\//.test(url)) return false

  const isGithub = /\/\/github\.com\//.test(url)
  const got = await run($, isGithub ? ['gh', 'pr', 'view', url, '--json', 'state,headRefName'] : ['glab', 'mr', 'view', url, '--output', 'json'])

  if (!got.ok) return false

  try {
    const held = JSON.parse(got.out) as { state?: unknown; headRefName?: unknown; source_branch?: unknown }

    return (held.state === 'MERGED' || held.state === 'merged') && (isGithub ? held.headRefName : held.source_branch) === branch
  } catch {
    return false
  }
}

/** Looks at what the mods keep, and asks the forge whether each is merged; tells the person of each newly merged once. */
const watch = async ($: $): Promise<MountdoomRelic[]> => {
  const answers = []

  for (const keeper of KEEPERS) {
    const got = await ask($, keeper, 'relics')

    if (!got.isError) answers.push({ keeper, text: got.text })
  }

  const origin = (await git($, ['remote', 'get-url', 'origin'])).out
  const forge = origin.includes('github') ? 'github' : 'gitlab'
  const found = gathered(answers)

  for (const relic of found) {
    // A pull request a mod did not open, the forge finds by its branch
    if (relic.pr === '') {
      const listed = await run($, findArgv(forge, relic.branch))

      relic.pr = listed.ok ? foundUrl(listed.out) : ''
    }

    relic.isMerged = await isMergedFrom($, relic.pr, relic.branch)
  }

  await update($, relics, () => found)

  const already = await read($, told)
  const fresh = found.filter(relic => relic.isMerged && !already.includes(relic.pr))

  if (fresh.length > 0) {
    await update($, told, was => [...was, ...fresh.map(relic => relic.pr)])
    $.ui.toast(`Mount Doom: ${fresh.map(relic => relic.ref || relic.branch).join(', ')} merged: /mountdoom cast throws ${fresh.length === 1 ? 'it' : 'them'} into the fire`)
    await $.ui.notify(`${fresh.length === 1 ? 'A pull request is' : `${fresh.length} pull requests are`} merged: /mountdoom cast throws what is kept of ${fresh.length === 1 ? 'it' : 'them'} into the fire`, { title: 'Mount Doom' }).catch(() => undefined)
  }

  return found
}

/**
 * Throws a merged relic into the fire: back on its base, brought up to date, its local branch deleted, and every mod
 * made to forget it. Each forgets only once the forge says it is merged; a remote branch is the forge's to remove.
 */
const burn = async ($: $, relic: MountdoomRelic): Promise<string> => {
  if (!(await isMergedFrom($, relic.pr, relic.branch))) return `${relic.ref || relic.branch}: ${relic.pr || 'no pull request'} is not merged from ${relic.branch}, and nothing is cast.`

  const said: string[] = []
  const current = (await git($, ['rev-parse', '--abbrev-ref', 'HEAD'])).out

  if (current === relic.branch) {
    if ((await git($, ['status', '--porcelain'])).out !== '') return `${relic.branch} is checked out with uncommitted changes: commit, stash or drop them, and cast again.`

    const back = await git($, ['switch', relic.base])

    if (!back.ok) return `Could not go back to ${relic.base}: ${back.out}`
    said.push(`back on ${relic.base}`)
  }

  if ((await git($, ['rev-parse', '--abbrev-ref', 'HEAD'])).out === relic.base) {
    const pulled = await git($, ['pull', '--ff-only', 'origin', relic.base])

    if (pulled.ok) said.push(`${relic.base} brought up to date`)
  }

  if ((await git($, ['rev-parse', '--verify', '--quiet', `refs/heads/${relic.branch}`])).ok) {
    const deleted = await git($, ['branch', '-D', relic.branch])

    said.push(deleted.ok ? `${relic.branch} deleted` : `${relic.branch} could not be deleted: ${deleted.out}`)
  }

  const forgotten: string[] = []

  for (const keeper of relic.keepers) if (await forgets($, keeper, { ref: relic.ref, pr: relic.pr })) forgotten.push(keeper)

  // The plan of the issue, and what the Mirror showed of it: of this issue alone
  if (isIssueRef(relic.ref) && (await forgets($, 'elrond', { ref: relic.ref, pr: relic.pr }))) forgotten.push('elrond')
  if (relic.keepers.includes('fellowship') && (await forgets($, 'lothlorien', { ref: relic.ref }))) forgotten.push('lothlorien')

  return `${relic.ref || relic.branch} is cast into the fire: ${[...said, forgotten.length > 0 ? `forgotten by ${forgotten.join(', ')}` : ''].filter(one => one !== '').join(', ')}.`
}

/** Casts every merged relic, or the one named by its branch, ref or pull request. */
const cast = async ($: $, named: string): Promise<string> => {
  await update($, working, () => 'Asking the forge what is merged…')

  try {
    const found = await watch($)
    const chosen = found.filter(relic => relic.isMerged && (named === '' || [relic.branch, relic.ref, relic.pr].includes(named)))

    if (chosen.length === 0) return named === '' ? `Nothing kept is merged yet.${found.length > 0 ? `\n${found.map(relicLine).join('\n')}` : ''}` : `Nothing merged is kept under ${named}.`

    const said: string[] = []

    await git($, ['fetch', '--prune', 'origin'])

    for (const relic of chosen) {
      await update($, working, () => `Casting ${relic.ref || relic.branch} into the fire…`)
      said.push(await burn($, relic))
    }

    await watch($)

    return said.join('\n')
  } finally {
    await update($, working, () => '')
  }
}

let isBusy = false

/** Looks or casts as /mountdoom asked, outside its hooks: what came of it is told as well as kept in the pane. */
const tick = async ($: $): Promise<void> => {
  const asked = await read($, wanted)

  if (isBusy || asked === '') return

  isBusy = true
  await update($, wanted, () => '')

  try {
    const said = asked === 'look' ? relicsText(await watch($)) : await cast($, asked.replace(/^cast\s*/, ''))

    $.ui.toast(`Mount Doom: ${said.split('\n')[0] ?? ''}`)
    await update($, note, () => said)
  } catch (error) {
    await update($, note, () => `Mount Doom stumbled: ${errorText(error)}`)
  } finally {
    isBusy = false
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'mountdoom', description: 'Throw what is kept of a merged pull request into the fire: /mountdoom shows what is watched; /mountdoom cast [branch or pr] casts' })

    for (const tool of [view.tool, ...TOOLS]) await $.tool.register(tool).catch(() => undefined)

    $.clock.after(FIRST_LOOK_MS, () => void watch($).catch(() => undefined))
    $.clock.every(WATCH_MS, () => void watch($).catch(() => undefined))
    $.clock.every(TICK_MS, () => void tick($).catch(() => undefined))
    $.ui.invalidate('ui.render')

    return next(e)
  })

  on('tool.call', { tool: 'mcp__mountdoom__pane' }, $ => view.answer(() => $.ui.panes()))

  on('tool.call', { tool: 'mcp__mountdoom__relics' }, async $ => ({ result: relicsText(await watch($)) }))

  // Casting deletes branches and has every mod forget: no tool offers it to Claude, and the person casts
  on('command.run', { command: 'mountdoom' }, async ($, e) => {
    const words = e.args.trim().split(/\s+/).filter(word => word !== '')

    await $.ui.open({ id: PANE, title: TITLE })

    if (words.length > 0 && words[0] !== 'cast') return { text: `/mountdoom knows cast; not ${words[0] ?? ''}.` }

    // Looking and casting ask the other mods, whose hooks answer no call made beneath a command's: the clock does both
    await update($, wanted, () => (words[0] === 'cast' ? `cast ${words.slice(1).join(' ')}`.trim() : 'look'))

    return { text: words[0] === 'cast' ? 'Mount Doom casts what is merged: the pane says what went into the fire.' : `${relicsText(await read($, relics))}\n\nLooking again: the pane says what the forge answers.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const held = await read($, relics)
    const problem = await read($, note)
    const busy = await read($, working)
    const merged = held.filter(relic => relic.isMerged)

    return view.keep(
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={2}>
          {badge({ label: merged.length > 0 ? `${merged.length} merged` : held.length > 0 ? 'watching' : 'nothing kept', tone: merged.length > 0 ? 'danger' : 'neutral' })}
          <Button key="look" hotkey="l" onPress={() => watch($).then(() => undefined)}>
            Look again
          </Button>
        </Box>
        {busy !== '' && <Text color="suggestion">{busy}</Text>}
        {problem !== '' && <Text>{problem}</Text>}
        {held.length === 0 && <Text dimColor>{HOW_TO}</Text>}
        {held.map(relic => (
          <Text key={relic.branch} color={relic.isMerged ? 'error' : undefined} dimColor={!relic.isMerged} wrap="truncate-end">
            {relicLine(relic)}
          </Text>
        ))}
        {merged.length > 0 && (
          <Button key="cast" hotkey="c" variant="primary" onPress={() => cast($, '').then(said => update($, note, () => said))}>
            Cast them into the fire
          </Button>
        )}
      </Box>,
    )
  })
}
