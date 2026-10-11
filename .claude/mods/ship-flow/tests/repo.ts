import { mock } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

type On = Parameters<TestBody>[1]

/** A ticket file's text. */
export const ticket = (number: string, title: string, fields: readonly string[]) =>
  [`# ${number}: ${title}`, '', '**What to build:** Something.', '', ...fields.flatMap(field => [field, ''])].join('\n')

/** A spec's text, with a Verification section when commands are given. */
export const spec = (commands: readonly string[] = []) =>
  ['# Spec', '', '## Solution', '', 'Something.', ...(commands.length > 0 ? ['', '## Verification', '', '```', ...commands, '```'] : []), ''].join(
    '\n',
  )

/**
 * Stands for the engine beneath the mod: a repo's files by path, its git, its shell, the session's figures and its
 * agents. A test reads back what the mod did from `files`, `ran`, `spawned` and `logged`.
 */
export const answerRepo = (
  on: On,
  given: {
    files: Readonly<Record<string, string>>
    /** What `git status --porcelain` prints: empty for a clean tree. */
    porcelain?: string
    /** The exit code of each verification command, by its text; 0 for one not named. */
    exits?: Readonly<Record<string, number>>
    isIgnored?: boolean
    /** The branch the repo is on; `checkout-feature` when not given. */
    branch?: string
    /** How many commits the branch already has that `main` lacks, before the run makes any. */
    ahead?: number
    /** The repo's issues on GitHub, by number. */
    issues?: Readonly<Record<number, { title: string; body: string; labels?: readonly string[] }>>
    /** Where the session's clock starts, in milliseconds. */
    now?: number
    /** How full each quota window is, in percent, and when the short one resets. */
    quota?: { short: number; weekly: number; resetsAt?: string }
  },
) => {
  const clock = mock.clock(on, { now: given.now ?? 1000 })
  const quota = { short: 40, resetsAt: '2026-10-11T20:00:00.000Z', ...given.quota }
  const notified: string[] = []
  const files: Record<string, string> = { ...given.files }
  const ran: string[] = []
  const spawned: { subagentType: string; description: string; model?: string; prompt: string }[] = []
  const logged: string[] = []
  const state = { porcelain: given.porcelain ?? '', commits: 0, branch: given.branch ?? 'checkout-feature' }
  // How full the main conversation's window is, in percent
  const context = { percent: 12 }
  const prompts: string[] = []
  const compacted: string[] = []
  const github: {
    issues: { title: string; body: string }[]
    pr?: { url: string; isDraft: boolean }
    body: string
    title: string
    base: string
    failsToPush: boolean
    failsToOpen: boolean
  } = { issues: [], body: '', title: '', base: '', failsToPush: false, failsToOpen: false }
  const exits: Record<string, number> = { ...given.exits }
  const isDir = (path: string) => Object.keys(files).some(file => file.startsWith(`${path}/`))
  // The engine hands a hook the path made absolute under the working directory, in the machine's own spelling
  const inRepo = (path: string) => path.replaceAll('\\', '/').replace(/^.*?(?=\.scratch(\/|$)|\.gitignore$)/, '')
  const exited = (exitCode: number, stdout = '', stderr = '') => ({
    value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
  })

  on('fs.exists', (_, e) => ({ value: inRepo(e.path) in files || isDir(inRepo(e.path)) }) as never)
  on('fs.read', (_, e) => ({ value: files[inRepo(e.path)] }) as never)
  on('fs.write', (_, e) => {
    files[inRepo(e.path)] = e.text

    return { value: undefined } as never
  })
  on('fs.list', (_, e) => {
    const dir = inRepo(e.path)
    const names = new Set(
      Object.keys(files)
        .filter(file => file.startsWith(`${dir}/`))
        .map(file => file.slice(dir.length + 1).split('/')[0] ?? ''),
    )

    return {
      value: Array.from(names, name => ({
        name,
        kind: isDir(`${dir}/${name}`) ? 'dir' : 'file',
        size: 0,
        mtimeMs: 0,
        isLink: false,
      })),
    } as never
  })
  on('process.run', (_, e) => {
    const line = e.argv.join(' ')

    ran.push(line)
    if (e.argv[0] === 'gh') {
      // GitHub, as its CLI answers: the branch's pull request, once one was opened
      const body = e.init?.stdin ?? ''

      if (e.argv[1] === 'issue' && e.argv[2] === 'view') {
        const issue = given.issues?.[Number(e.argv[3])]

        return (issue ? exited(0, JSON.stringify({ number: Number(e.argv[3]), ...issue, labels: (issue.labels ?? []).map(name => ({ name })) })) : exited(1, '', 'GraphQL: Could not resolve to an Issue')) as never
      }
      if (e.argv[1] === 'issue' && e.argv[2] === 'create') {
        if (github.failsToOpen) return exited(1, '', 'GraphQL: not authorized') as never
        github.issues.push({ title: e.argv[e.argv.indexOf('--title') + 1] ?? '', body })

        return exited(0, `https://github.com/dev/repo/issues/${30 + github.issues.length}\n`) as never
      }
      if (e.argv[2] === 'view') return (github.pr ? exited(0, JSON.stringify(github.pr)) : exited(1, '', 'no pull requests found')) as never
      if (e.argv[2] === 'create') {
        if (github.failsToOpen) return exited(1, '', 'GraphQL: not authorized') as never
        github.pr = { url: 'https://github.com/dev/repo/pull/7', isDraft: e.argv.includes('--draft') }
        github.body = body
        github.title = e.argv[e.argv.indexOf('--title') + 1] ?? ''
        github.base = e.argv[e.argv.indexOf('--base') + 1] ?? ''

        return exited(0, `Creating pull request\n${github.pr.url}\n`) as never
      }
      if (e.argv[2] === 'edit') github.body = body
      if (e.argv[2] === 'ready' && github.pr) github.pr.isDraft = e.argv.includes('--undo')

      return exited(0) as never
    }
    if (e.argv[0] !== 'git') {
      const exitCode = exits[e.argv.at(-1) ?? ''] ?? 0

      return exited(exitCode, exitCode === 0 ? 'ok' : 'expected 2 but got 3') as never
    }
    if (e.argv[1] === 'check-ignore') return exited(given.isIgnored === false ? 1 : 0) as never
    if (line === 'git status --porcelain') return exited(0, state.porcelain) as never
    if (line === 'git rev-parse --abbrev-ref HEAD') return exited(0, `${state.branch}\n`) as never
    if (e.argv[1] === 'checkout') state.branch = e.argv.at(-1) ?? state.branch
    // Each commit has a name of its own: the first the run makes is abc1234
    if (line === 'git rev-parse --short HEAD') return exited(0, `abc${1233 + state.commits}\n`) as never
    if (e.argv[1] === 'symbolic-ref') return exited(0, 'origin/main\n') as never
    if (e.argv[1] === 'rev-list') return exited(0, `${(given.ahead ?? 0) + state.commits}\n`) as never
    if (e.argv[1] === 'push') return (github.failsToPush ? exited(1, '', 'remote: Permission denied') : exited(0)) as never
    if (e.argv[1] === 'commit') state.commits += 1
    // A commit and a discard both leave the working tree clean
    if (e.argv[1] === 'commit' || e.argv[1] === 'reset') state.porcelain = ''

    return exited(0) as never
  })
  on('session.cwd', () => ({ value: '/home/dev/repo' }) as never)
  on('session.usage', () =>
    ({
      value: {
        startedAt: 0,
        context: { window: 200000, tokens: context.percent * 2000, percent: context.percent },
        rateLimits: [
          { kind: 'five_hour', percentUsed: quota.short, resetsAt: quota.resetsAt },
          ...(quota.weekly !== undefined ? [{ kind: 'seven_day', percentUsed: quota.weekly, resetsAt: '2026-10-15T19:00:00.000Z' }] : []),
        ],
      },
    }) as never,
  )
  const aborted: string[] = []
  // How many tokens the next response of a subagent is answered over
  const step = { tokens: 20_000 }

  on('turn.abort', (_, e) => {
    aborted.push(e.turnId)

    return { value: undefined } as never
  })
  // The model's response beneath the mod: no pieces, and a usage that says how full the context was
  on('turn.step', async function* (_, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'tool_use',
      usage: {
        model: e.model,
        input_tokens: 1_000,
        output_tokens: 500,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: step.tokens - 1_000,
      },
    } as never
  })
  // A session as it starts, and what the mod declares to it; a file read, which the session lets through
  on('session.start', () => ({ cwd: '/home/dev/repo' }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('agent.register', () => ({ value: undefined }) as never)
  on('tool.call', () => ({ result: '', text: '' }) as never)
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)

    return { text: e.text } as never
  })
  // A compaction beneath the mod: nothing is summarised, and the session says so
  on('session.compact', (_, e) => {
    compacted.push(e.instructions ?? '')

    return { skip: 'a test compacts nothing' } as never
  })
  on('ui.notify', (_, e) => {
    notified.push(e.text)

    return { value: { isSent: true, channel: 'terminal_bell' } } as never
  })
  // The test kit keeps the id out of a spawn's answer, as the engine does for a hook's: the mod finds it here
  on('agent.list', () =>
    ({
      value: spawned.map((agent, index) => ({
        id: `agent-${index + 1}`,
        description: agent.description,
        type: agent.subagentType,
        status: 'running',
      })),
    }) as never,
  )
  // Beneath the plugins a spawn is the Agent tool's call, in that tool's own spelling
  on('agent.spawn', (_, e) => {
    const call = e as unknown as { subagent_type: string; description: string; prompt: string; model?: string }

    spawned.push({
      subagentType: call.subagent_type,
      description: call.description,
      prompt: call.prompt,
      ...(call.model ? { model: call.model } : {}),
    })

    return { model: call.model ?? 'inherit' } as never
  })
  // The session's own answers, beneath the mod's: a turn ends as it ended, and a tool call is put to the person
  on('turn.complete', (_, e) => ({ text: e.answer }) as never)
  on('tool.check', () => ({ decision: 'ask' }) as never)
  on('ui.log', (_, e) => {
    logged.push(e.text)

    return { value: undefined } as never
  })

  return {
    files,
    ran,
    spawned,
    logged,
    notified,
    /** The prompts the mod handed the model, and the instructions of each compaction it asked for. */
    prompts,
    compacted,
    /** How full the main conversation's window is, in percent: a test raises it. */
    context,
    /** The branch the repo is on now. */
    branch: () => state.branch,
    /** GitHub as the mod left it: the branch's pull request, its title, base and body; and what a test makes fail. */
    github,
    /** The turns the mod stopped, by id. */
    aborted,
    /** How full a subagent's context is at its next response, in tokens: a test raises it. */
    step,
    /** The session's clock, which moves only when the test moves it. */
    clock,
    /** How full each quota window is: a test changes one between tickets. */
    quota: quota as { short: number; weekly?: number; resetsAt: string },
    /** The exit code of each verification command, by its text: a test changes one between attempts. */
    exits,
    /** What the implementer leaves in the working tree, as `git status --porcelain` then prints it. */
    change: (porcelain: string) => {
      state.porcelain = porcelain
    },
    record: (feature: string) => JSON.parse(files[`.scratch/${feature}/run.json`] ?? '{}') as Record<string, unknown>,
    statusOf: (path: string) => /^\*\*Status:\*\* (.*)$/m.exec(files[path] ?? '')?.[1],
  }
}
