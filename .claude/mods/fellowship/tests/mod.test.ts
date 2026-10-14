import { describe, expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { branchOf, closingLine, commitMessage, companionPrompt, isForbiddenGit, isModPath, issueOf, nextTask, parsePlan, prArgv, proofVerdict, unsettledOf } from '../hooks/quest'
import type { FellowshipPlan, FellowshipQuest } from '../types'

type Engine = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

const CWD = '/proj'

const PLAN = {
  ref: 'github:lienardquentin/claude-code-shenanigans#12',
  url: 'https://github.com/lienardquentin/claude-code-shenanigans/issues/12',
  title: 'Beacons answer how long they have burned',
  summary: 'A lit beacon answers how long it has burned.',
  approach: 'Keep when a beacon was lit, and answer the seconds since.',
  tasks: [
    { id: 1, title: 'Keep when a beacon is lit', why: 'Nothing records it yet.', steps: ['Add lit_at'], files: ['beacons/gondor/app.py'], dependsOn: [], acceptance: 'lit_at is set on light', state: 'todo' },
    { id: 2, title: 'Answer the seconds burned', why: 'What the issue asks.', steps: ['Add burned_for'], files: ['beacons/gondor/app.py'], dependsOn: [1], acceptance: 'A test reads burned_for', state: 'todo' },
  ],
  questions: [{ text: 'Is an unlit beacon 0 or null?', options: ['null', '0'], answer: 'null' }],
  decided: [],
  risks: [],
  accepted: ['Clock skew between hosts'],
  at: 1,
}

const plan = (change: Partial<FellowshipPlan> = {}): FellowshipPlan => ({ ...(parsePlan(JSON.stringify(PLAN)) as FellowshipPlan), ...change })

const PINNED = ['gondor: 1 kept request changed · 1 pinned.', '', 'pinned: GET /beacons/minas-tirith', '  pinned by test_burned: it fails on the commit\'s source and passes on the working tree.'].join('\n')
const BARE = ['gondor: 1 kept request changed · 1 bare.', '', 'bare: GET /beacons/minas-tirith', '  no test is marked on it.'].join('\n')

describe('the plan Elrond answers', () => {
  test('is read from its JSON, and is none when Elrond holds none', () => {
    expect(plan().tasks[1]).toMatchObject({ id: 2, dependsOn: [1], state: 'todo' })
    expect(parsePlan('null')).toBeNull()
    expect(parsePlan('No plan is in force.')).toMatch(/no plan Fellowship can read/)
  })

  test('is not set out on while a question is open or a risk undecided', () => {
    expect(unsettledOf(plan())).toEqual([])
    expect(unsettledOf(plan({ questions: [{ text: 'Q', options: [], answer: '' }], risks: [{ text: 'R', severity: 'high', mitigation: '', tasks: [1], wantsTask: false }] }))).toEqual(['1 unanswered question', '1 undecided risk (accept each, or have it covered or asked about)'])
  })

  test('sends the task begun first, else the first whose dependencies are done', () => {
    expect(nextTask(plan())?.id).toBe(1)

    const [first, second] = plan().tasks

    expect(nextTask(plan({ tasks: [{ ...first!, state: 'done' }, second!] }))?.id).toBe(2)
    expect(nextTask(plan({ tasks: [first!, { ...second!, dependsOn: [], state: 'doing' }] }))?.id).toBe(2)
  })
})

describe('the issue and its branch', () => {
  test('are read from Elrond\'s short spelling, self-hosted or not', () => {
    expect(issueOf('github:o/r#12')).toEqual({ forge: 'github', server: 'github.com', repo: 'o/r', number: 12 })
    expect(issueOf('gitlab:git.corp.io/g/sub/p#3')).toEqual({ forge: 'gitlab', server: 'git.corp.io', repo: 'g/sub/p', number: 3 })
    expect(branchOf(plan())).toBe('fellowship/12-beacons-answer-how-long-they-have-burned')
    expect(closingLine('gitlab:g/p#3')).toBe('Closes g/p#3')
  })

  test('name the commit and the pull request that closes it, on either forge', () => {
    expect(commitMessage(plan(), plan().tasks[0]!)).toMatch(/^#12: Keep when a beacon is lit\n\nTask 1 of the Elrond plan for https:\/\/github\.com\/.*\/issues\/12[\s\S]*Co-Authored-By: Claude/)

    const quest = { base: 'main', branch: 'fellowship/12-x', commits: [{ taskId: 1, title: 'Keep', sha: 'abcdef1234' }] } as FellowshipQuest

    expect(prArgv(plan(), quest).slice(0, 7)).toEqual(['gh', 'pr', 'create', '--base', 'main', '--head', 'fellowship/12-x'])
    expect(prArgv(plan(), quest).at(-1)).toMatch(/- abcdef1 1\. Keep[\s\S]*Closes lienardquentin\/claude-code-shenanigans#12/)
    expect(prArgv(plan({ ref: 'gitlab:g/p#3' }), quest)).toContain('--target-branch')
  })
})

describe('Argonath\'s proof', () => {
  test('settles the change only when every changed run is pinned and nothing turned', () => {
    expect(proofVerdict(PINNED)).toEqual({ isSettled: true, line: 'every changed run is pinned' })
    expect(proofVerdict('gondor: …\nNothing a kept run does changed: no integration test is owed.')).toEqual({ isSettled: true, line: 'no kept run changed: nothing to pin' })
    expect(proofVerdict(`${PINNED}\n\n―――\n\n${BARE}`)).toEqual({ isSettled: false, line: 'not pinned yet: 1 bare' })
    expect(proofVerdict(`${PINNED}\n\nPassing on the commit's source and failing on the working tree: test_old.`).isSettled).toBe(false)
    expect(proofVerdict('gondor could not be looked at: boom').isSettled).toBe(false)
  })
})

describe('a companion', () => {
  test('is sent with its task, the risks that threaten it, and on a retry what the last proof found', () => {
    const made = plan({ risks: [{ text: 'Old beacons have no lit_at', severity: 'medium', mitigation: 'Default to null', tasks: [2], wantsTask: false }] })
    const prompt = companionPrompt(made, made.tasks[1]!, { attempt: 2, answer: 'Added burned_for.', proof: BARE })

    expect(prompt).toMatch(/Risks that threaten this task:\n- \(medium\) Old beacons have no lit_at Mitigation: Default to null/)
    expect(prompt).toMatch(/Task 2: Answer the seconds burned[\s\S]*Done when: A test reads burned_for/)
    expect(prompt).toMatch(/This is try 2[\s\S]*<proof>\ngondor: 1 kept request changed · 1 bare/)
    expect(companionPrompt(made, made.tasks[0]!)).not.toMatch(/Risks that threaten/)
  })

  test('commits nothing, moves no branch, and leaves the mods\' folders alone', () => {
    for (const command of ['git commit -am x', 'cd a && git push', 'git -C . checkout main', 'git stash']) expect(isForbiddenGit(command)).toBe(true)
    for (const command of ['git status', 'git diff HEAD', 'pytest -k commit', 'echo git']) expect(isForbiddenGit(command)).toBe(false)
    expect(isModPath(CWD, '/proj/.elrond/plans/x.json')).toBe(true)
    expect(isModPath(CWD, '/proj/beacons/gondor/app.py')).toBe(false)
  })
})

/** Stands for the machine, Elrond, Argonath and the engine beneath the mod. */
const machine = (on: On) => {
  const world = {
    ran: [] as string[],
    spawned: [] as Record<string, unknown>[],
    submitted: [] as string[],
    marked: [] as string[],
    store: {} as Record<string, unknown>,
    plan: structuredClone(PLAN) as typeof PLAN | null,
    proofs: [PINNED] as string[],
    branch: 'main',
    dirty: '',
    clock: mock.clock(on, { now: 1_800_000_000_000 }),
  }

  on('session.cwd', () => ({ value: CWD }) as never)
  on('process.run', (_, e) => {
    const line = e.argv.join(' ')
    world.ran.push(line)

    const answer = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: exitCode === 0 ? '' : 'no', isStdoutTruncated: false, isStderrTruncated: false } }) as never

    if (line === 'git rev-parse --abbrev-ref HEAD') return answer(`${world.branch}\n`)
    if (line === 'git status --porcelain') return answer(world.dirty)
    if (line.startsWith('git rev-parse --verify')) return answer('', 1)
    if (line.startsWith('git switch -c ')) {
      world.branch = e.argv.at(-1) ?? ''

      return answer('')
    }
    if (line.startsWith('git commit')) {
      world.dirty = ''

      return answer('')
    }
    if (line === 'git rev-parse HEAD') return answer(`c0ffee${world.ran.length}aaaa\n`)
    if (e.argv[0] === 'gh') return answer('https://github.com/lienardquentin/claude-code-shenanigans/pull/13\n')

    return answer('')
  })
  on('mcp.call', (_, e) => {
    const text = (said: string) => ({ value: { content: [{ type: 'text', text: said }], isError: false } }) as never

    if (e.server === 'elrond' && e.tool === 'plan') return text(JSON.stringify(world.plan))
    if (e.server === 'elrond' && e.tool === 'task') {
      world.marked.push(`${String(e.args.id)} ${String(e.args.state)}`)
      const task = world.plan?.tasks.find(one => one.id === e.args.id)
      if (task !== undefined) task.state = String(e.args.state)

      return text('marked')
    }
    if (e.server === 'argonath' && e.tool === 'prove') return text(world.proofs.length > 1 ? (world.proofs.shift() ?? '') : (world.proofs[0] ?? ''))

    return { value: { content: [], isError: true } } as never
  })
  on('agent.spawn', (_, e) => {
    world.spawned.push(e as unknown as Record<string, unknown>)
    // The companion builds something
    world.dirty = ' M beacons/gondor/app.py\n'

    return { model: 'opus' } as never
  })
  // Core alone mints an agent's id: the companion is known by the type it runs as
  on('agent.list', () => ({ value: [{ id: 'companion-1', description: 'Task', type: 'fellowship:companion', status: 'running' }, { id: 'someone-else', description: 'x', type: 'Explore', status: 'running' }] }) as never)
  on('prompt.submit', (_, e) => {
    world.submitted.push(e.text)

    return { text: e.text } as never
  })
  on('store.get', (_, e) => ({ value: world.store[(e as unknown as { key: string }).key] }) as never)
  on('store.set', (_, e) => {
    const given = e as unknown as { key: string; value: unknown }
    world.store[given.key] = given.value

    return { value: undefined } as never
  })
  on('command.register', () => ({ value: undefined }) as never)
  on('agent.register', () => ({ value: { agent: 'fellowship:companion' } }) as never)
  on('tool.register', () => ({ value: undefined }) as never)
  on('session.start', () => ({ cwd: CWD }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.notify', () => ({ value: { isSent: true, channel: 'terminal_bell' } }) as never)
  on('turn.complete', () => ({ text: '' }) as never)
  on('tool.call', { tool: 'Bash' }, () => ({ result: 'ran' }) as never)

  return world
}

const call = async ($: Engine, tool: string, input: Record<string, unknown> = {}) => String((await $.tool.call({ tool, ...input } as never)).result)

const ends = ($: Engine, agentId: string, answer: string) => $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId: 't', reason: 'answer', agentId } as never)

/** Lets the clock do what was asked of it. */
const settle = async (world: ReturnType<typeof machine>) => {
  for (let at = 0; at < 4; at += 1) await world.clock.advance(600)
}

describe('fellowship', () => {
  test('sets out on a settled plan from a clean tree, on a branch of its own, and sends a companion on the first task', async ($, on) => {
    const world = machine(on)
    await $.session.start({} as never)

    expect(await call($, 'mcp__fellowship__set_out')).toMatch(/sets out on github:.*#12.*on fellowship\/12-beacons-answer-how-long-they-have-burned from main/)
    await settle(world)

    expect(world.ran).toContain('git switch -c fellowship/12-beacons-answer-how-long-they-have-burned')
    expect(world.marked).toEqual(['1 doing'])
    expect(world.spawned[0]).toMatchObject({ subagent_type: 'fellowship:companion', description: 'Task 1: Keep when a beacon is lit' })
  })

  test('does not set out on a plan the council left open, nor over uncommitted work', async ($, on) => {
    const world = machine(on)
    world.plan = { ...PLAN, questions: [{ text: 'Q', options: [], answer: '' }] }

    expect(await call($, 'mcp__fellowship__set_out')).toMatch(/not settled: 1 unanswered question/)

    world.plan = structuredClone(PLAN)
    world.dirty = ' M README.md\n'

    expect(await call($, 'mcp__fellowship__set_out')).toMatch(/uncommitted changes/)
    expect(world.spawned).toHaveLength(0)
  })

  test('proves what the companion built, wakes Claude for the reviews, and commits it once proven again', async ($, on) => {
    const world = machine(on)
    await $.session.start({} as never)
    await call($, 'mcp__fellowship__set_out')
    await settle(world)

    // Another agent's turn is none of the quest's
    await ends($, 'someone-else', 'x')
    await settle(world)
    expect(world.submitted).toHaveLength(0)

    await ends($, 'companion-1', 'Added lit_at.')
    await settle(world)

    expect(world.submitted[0]).toMatch(/built task 1 of github:.*#12.*every changed run is pinned[\s\S]*Do not commit in this turn/)

    const said = await call($, 'mcp__fellowship__commit')

    expect(said).toMatch(/Task 1, "Keep when a beacon is lit", is committed as c0ffee/)
    expect(world.ran.some(line => line.startsWith('git commit -m #12: Keep when a beacon is lit'))).toBe(true)
    expect(world.marked).toEqual(['1 doing', '1 done'])
    // Attended: the next task waits for the person
    await settle(world)
    expect(world.spawned).toHaveLength(1)
  })

  test('sends the companion again with the proof when its change is not pinned, and stops after the last try', async ($, on) => {
    const world = machine(on)
    world.proofs = [BARE]
    await $.session.start({} as never)
    await call($, 'mcp__fellowship__set_out')
    await settle(world)

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await ends($, 'companion-1', `try ${attempt}`)
      await settle(world)
    }

    expect(world.spawned).toHaveLength(3)
    expect(String(world.spawned[1]?.prompt)).toMatch(/This is try 2[\s\S]*What that companion said:\n<said>\ntry 1[\s\S]*bare: GET/)
    expect(await call($, 'mcp__fellowship__quest')).toMatch(/: stuck[\s\S]*Last proof: not pinned yet: 1 bare/)
    expect(await call($, 'mcp__fellowship__commit')).toMatch(/is not committed: not pinned yet/)
  })

  test('holds the companion off the branch, the commits and the mods\' folders, and lets it build', async ($, on) => {
    const world = machine(on)
    await $.session.start({} as never)
    await call($, 'mcp__fellowship__set_out')
    await settle(world)

    const by = async (agentId: string, command: string) => $.tool.call({ tool: 'Bash', command, agentId } as never)

    expect(await by('companion-1', 'git commit -am done')).toMatchObject({ deny: expect.stringMatching(/Fellowship commits/) })
    expect(await by('companion-1', 'pytest beacons')).toMatchObject({ result: 'ran' })
    expect(await by('someone-else', 'git commit -am done')).toMatchObject({ result: 'ran' })
    expect(world.spawned).toHaveLength(1)
  })

  test('on an auto quest, goes on task by task and opens the pull request that closes the issue', async ($, on) => {
    const world = machine(on)
    await $.session.start({} as never)
    await call($, 'mcp__fellowship__set_out', { auto: true })
    await settle(world)

    for (const id of [1, 2]) {
      await ends($, 'companion-1', `built ${id}`)
      await settle(world)
      expect(await call($, 'mcp__fellowship__commit')).toMatch(new RegExp(`Task ${id}, .* is committed`))
      await settle(world)
    }

    expect(world.spawned).toHaveLength(2)
    expect(world.ran).toContain('git push -u origin fellowship/12-beacons-answer-how-long-they-have-burned')
    expect(world.ran.find(line => line.startsWith('gh pr create'))).toMatch(/--base main --head fellowship\/12-.*Closes lienardquentin\/claude-code-shenanigans#12/s)
    expect(await call($, 'mcp__fellowship__quest')).toMatch(/: sailed[\s\S]*Pull request: https:\/\/github\.com\/.*\/pull\/13/)
  })
})
