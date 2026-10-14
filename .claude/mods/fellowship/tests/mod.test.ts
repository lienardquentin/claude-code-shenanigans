import { describe, expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { branchOf, closingLine, commitMessage, companionPrompt, isForbiddenGit, isModPath, issueOf, memberFor, nextTask, parseJudgement, parsePlan, prArgv, proofVerdict, triesOf, unsettledOf } from '../hooks/quest'
import type { FellowshipPlan, FellowshipQuest } from '../types'
import { MEMBERS } from '../hooks/quest'
import type { Target } from '../hooks/quest'

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
    { id: 1, title: 'Keep when a beacon is lit', why: 'Nothing records it yet.', steps: ['Add lit_at'], files: ['beacons/gondor/app.py'], dependsOn: [], acceptance: 'lit_at is set on light', weight: 'light', state: 'todo' },
    { id: 2, title: 'Answer the seconds burned', why: 'What the issue asks.', steps: ['Add burned_for'], files: ['beacons/gondor/app.py'], dependsOn: [1], acceptance: 'A test reads burned_for', weight: 'standard', state: 'todo' },
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

const TARGETS = [
  { label: 'narsil', kind: 'cli', roots: ['narsil'] },
  { label: 'gondor', kind: 'service', roots: ['beacons/gondor'] },
  { label: 'anor', kind: 'frontend', roots: ['beacons/anor'] },
] as Target[]

const seat = (title: string, state: string, findings: { severity: string; where: string; text: string }[] = []) => ({ statue: title.toLowerCase(), title, reviews: [], state, findings, why: '' })
const JUDGED = {
  sitting: JSON.stringify({ verdict: 'sitting', seats: [seat('Isildur', 'sitting'), seat('Anárion', 'sitting')] }),
  pass: JSON.stringify({ verdict: 'pass', seats: [seat('Isildur', 'pass', [{ severity: 'minor', where: 'app.py:70', text: 'lit could be named burning.' }]), seat('Anárion', 'pass')] }),
  fail: JSON.stringify({ verdict: 'fail', seats: [seat('Isildur', 'pass'), seat('Anárion', 'fail', [{ severity: 'blocking', where: 'app.py:72', text: 'The archive error is swallowed whole.' }])] }),
}

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
    expect(commitMessage(plan(), plan().tasks[0]!, 'Merry', ['- Isildur, app.py:70: lit could be named burning.'])).toMatch(
      /^#12: Keep when a beacon is lit\n\nTask 1 of the Elrond plan for https:\/\/github\.com\/.*\/issues\/12, built by Merry of the Fellowship[\s\S]*Minor findings of the statues, left as they are:\n- Isildur, app\.py:70[\s\S]*Co-Authored-By: Claude/,
    )

    const quest = { base: 'main', branch: 'fellowship/12-x', commits: [{ taskId: 1, title: 'Keep', sha: 'abcdef1234', by: 'Frodo', minor: ['- Isildur, app.py:70: lit could be named burning.'] }] } as FellowshipQuest

    expect(prArgv(plan(), quest).slice(0, 7)).toEqual(['gh', 'pr', 'create', '--base', 'main', '--head', 'fellowship/12-x'])
    expect(prArgv(plan(), quest).at(-1)).toMatch(/- abcdef1 1\. Keep \(Frodo\)[\s\S]*## Minor findings[\s\S]*- task 1: Isildur, app\.py:70[\s\S]*Closes lienardquentin\/claude-code-shenanigans#12/)
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

describe('the statues\' judgement', () => {
  test('is read with its findings a line each, the blocking apart from the minor', () => {
    expect(parseJudgement(JUDGED.pass)).toEqual({ verdict: 'pass', blocking: [], minor: ['- Isildur, app.py:70: lit could be named burning.'], line: 'passed, 1 minor finding' })
    expect(parseJudgement(JUDGED.fail)).toMatchObject({ verdict: 'fail', blocking: ['- Anárion, app.py:72: The archive error is swallowed whole.'], line: '1 blocking finding' })
    expect(parseJudgement('Argonath did not answer').verdict).toBe('unreadable')
  })
})

describe('a member', () => {
  test('is chosen by the weight of the task and its target, one rung up each try, Gandalf last', () => {
    const made = plan()
    const [light, standard] = made.tasks

    expect([1, 2, 3, 4].map(attempt => memberFor(made, light!, attempt, TARGETS))).toEqual(['frodo', 'gimli', 'aragorn', 'gandalf'])
    expect(triesOf(made, light!)).toBe(4)
    expect(memberFor(made, { ...standard!, files: ['beacons/anor/src/App.tsx', 'beacons/gondor/app.py', 'beacons/anor/src/Beacon.tsx'] }, 1, TARGETS)).toBe('legolas')
    expect(memberFor(made, { ...standard!, files: ['narsil/src/main.rs'] }, 1, TARGETS)).toBe('boromir')
    expect(memberFor(made, { ...standard!, id: 3, weight: 'light' }, 1, TARGETS)).toBe('merry')
    expect(memberFor(made, { ...standard!, weight: 'heavy' }, 1, TARGETS)).toBe('aragorn')
    expect(triesOf(made, { ...standard!, weight: 'heavy' })).toBe(2)
  })

  test('is sent a rung up when a high risk threatens the task', () => {
    const made = plan({ risks: [{ text: 'Data loss', severity: 'high', mitigation: '', tasks: [1], wantsTask: false }] })

    expect(memberFor(made, made.tasks[0]!, 1, TARGETS)).toBe('gimli')
  })

  test('is sent with its task, the risks that threaten it, and on a retry what stopped the try before', () => {
    const made = plan({ risks: [{ text: 'Old beacons have no lit_at', severity: 'medium', mitigation: 'Default to null', tasks: [2], wantsTask: false }] })
    const prompt = companionPrompt(made, made.tasks[1]!, { attempt: 2, by: 'Gimli', answer: 'Added burned_for.', proof: BARE })

    expect(prompt).toMatch(/Risks that threaten this task:\n- \(medium\) Old beacons have no lit_at Mitigation: Default to null/)
    expect(prompt).toMatch(/Task 2: Answer the seconds burned[\s\S]*Done when: A test reads burned_for/)
    expect(prompt).toMatch(/This is try 2\. The change Gimli made[\s\S]*What Gimli said:[\s\S]*<proof>\ngondor: 1 kept request changed · 1 bare/)
    expect(companionPrompt(made, made.tasks[0]!)).not.toMatch(/Risks that threaten/)

    const judged = companionPrompt(made, made.tasks[1]!, { attempt: 2, by: 'Gimli', answer: '', findings: ['- Anárion, app.py:72: The archive error is swallowed whole.'] })

    expect(judged).toMatch(/the statues of the Argonath found what blocks the change\. Fix each:\n<findings>\n- Anárion, app\.py:72/)
    expect(judged).not.toContain('<proof>')
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
    judgements: [JUDGED.sitting, JUDGED.pass] as string[],
    registered: [] as Record<string, unknown>[],
    convened: 0,
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
    if (e.server === 'argonath' && e.tool === 'targets') return text(JSON.stringify(TARGETS))
    if (e.server === 'argonath' && e.tool === 'judgement') {
      if (e.args.convene === true) world.convened += 1

      return text(world.judgements.length > 1 ? (world.judgements.shift() ?? '') : (world.judgements[0] ?? ''))
    }

    return { value: { content: [], isError: true } } as never
  })
  on('agent.spawn', (_, e) => {
    world.spawned.push(e as unknown as Record<string, unknown>)
    // The companion builds something
    world.dirty = ' M beacons/gondor/app.py\n'

    return { model: 'opus' } as never
  })
  // Core alone mints an agent's id: the companion is known by the type it runs as
  on('agent.list', () => ({ value: [...Object.keys(MEMBERS).map(name => ({ id: `${name}-1`, description: 'Task', type: `fellowship:${name}`, status: 'running' })), { id: 'someone-else', description: 'x', type: 'Explore', status: 'running' }] }) as never)
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
  on('agent.register', (_, e) => {
    world.registered.push(e as unknown as Record<string, unknown>)

    return { value: { agent: 'x' } } as never
  })
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
  for (let at = 0; at < 16; at += 1) await world.clock.advance(600)
}

describe('fellowship', () => {
  test('sets out on a settled plan from a clean tree, on a branch of its own, and sends a hobbit on a light first task', async ($, on) => {
    const world = machine(on)
    await $.session.start({} as never)

    expect(await call($, 'mcp__fellowship__set_out')).toMatch(/sets out on github:.*#12.*on fellowship\/12-beacons-answer-how-long-they-have-burned from main/)
    await settle(world)

    expect(world.ran).toContain('git switch -c fellowship/12-beacons-answer-how-long-they-have-burned')
    expect(world.marked).toEqual(['1 doing'])
    expect(world.spawned[0]).toMatchObject({ subagent_type: 'fellowship:frodo', description: 'Frodo: task 1, Keep when a beacon is lit' })
  })

  test('registers each member on its model and effort, and offers none to Claude', async ($, on) => {
    const { registered } = machine(on)
    await $.session.start({} as never)

    expect(registered.map(one => `${String(one.name)} ${String(one.model)} ${String(one.effort)}`)).toEqual([
      'gandalf claude-opus-5-5 high',
      'aragorn claude-opus-5-5 medium',
      'legolas claude-sonnet-5-5 medium',
      'gimli claude-sonnet-5-5 medium',
      'boromir claude-sonnet-5-5 medium',
      'frodo claude-haiku-5-5 medium',
      'samwise claude-haiku-5-5 medium',
      'merry claude-haiku-5-5 medium',
      'pippin claude-haiku-5-5 medium',
    ])
    expect(String(registered[0]?.prompt)).toContain('The plan must be revised:')
    expect(registered[0]?.disallowedTools).toContain('mcp__argonath__judgement')
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

  test('proves what the member built, sends the statues to judge it, and commits it once they pass it, minor findings and all', async ($, on) => {
    const world = machine(on)
    await $.session.start({} as never)
    await call($, 'mcp__fellowship__set_out')
    await settle(world)

    // Another agent's turn is none of the quest's
    await ends($, 'someone-else', 'x')
    await settle(world)
    expect(world.convened).toBe(0)

    await ends($, 'frodo-1', 'Added lit_at.')
    await settle(world)

    expect(world.convened).toBe(1)
    expect(world.ran.find(line => line.startsWith('git commit -m'))).toMatch(/^git commit -m #12: Keep when a beacon is lit[\s\S]*built by Frodo[\s\S]*- Isildur, app\.py:70: lit could be named burning\./)
    expect(world.marked).toEqual(['1 doing', '1 done'])
    // No Claude is woken: the statues are the judges
    expect(world.submitted).toEqual([])
    // Attended: the next task waits for the person
    expect(world.spawned).toHaveLength(1)
    expect(await call($, 'mcp__fellowship__quest')).toMatch(/: ready[\s\S]*● 1\. Keep when a beacon is lit · c0ffee/)
  })

  test('sends the task a rung up with the findings alone when the statues find what blocks it', async ($, on) => {
    const world = machine(on)
    world.judgements = [JUDGED.fail, JUDGED.pass]
    await $.session.start({} as never)
    await call($, 'mcp__fellowship__set_out')
    await settle(world)

    await ends($, 'frodo-1', 'Added lit_at.')
    await settle(world)

    expect(world.spawned[1]).toMatchObject({ subagent_type: 'fellowship:gimli' })
    expect(String(world.spawned[1]?.prompt)).toMatch(/This is try 2\. The change Frodo made[\s\S]*<findings>\n- Anárion, app\.py:72: The archive error is swallowed whole\.\n<\/findings>/)
    expect(String(world.spawned[1]?.prompt)).not.toContain('<proof>')
    expect(world.ran.some(line => line.startsWith('git commit'))).toBe(false)

    await ends($, 'gimli-1', 'Raised the archive error.')
    await settle(world)
    expect(world.ran.find(line => line.startsWith('git commit -m'))).toMatch(/built by Gimli/)
  })

  test('climbs the rungs while the proof does not pin the change, and stops once Gandalf has tried', async ($, on) => {
    const world = machine(on)
    world.proofs = [BARE]
    await $.session.start({} as never)
    await call($, 'mcp__fellowship__set_out')
    await settle(world)

    for (const member of ['frodo', 'gimli', 'aragorn', 'gandalf']) {
      await ends($, `${member}-1`, `try of ${member}`)
      await settle(world)
    }

    expect(world.spawned.map(one => one.subagent_type)).toEqual(['fellowship:frodo', 'fellowship:gimli', 'fellowship:aragorn', 'fellowship:gandalf'])
    expect(String(world.spawned[1]?.prompt)).toMatch(/What Frodo said:\n<said>\ntry of frodo[\s\S]*bare: GET/)
    expect(world.convened).toBe(0)
    expect(await call($, 'mcp__fellowship__quest')).toMatch(/: stuck[\s\S]*Last proof: not pinned yet: 1 bare/)
  })

  test('stops for the plan to be revised when Gandalf says it must be', async ($, on) => {
    const world = machine(on)
    world.plan = { ...structuredClone(PLAN), tasks: PLAN.tasks.map(task => ({ ...task, weight: 'heavy' })) }
    world.proofs = [BARE]
    await $.session.start({} as never)
    await call($, 'mcp__fellowship__set_out')
    await settle(world)

    await ends($, 'aragorn-1', 'Could not.')
    await settle(world)
    expect(world.spawned[1]).toMatchObject({ subagent_type: 'fellowship:gandalf' })

    await ends($, 'gandalf-1', 'I looked.\nThe plan must be revised: beacons keep no clock to measure from.')
    await settle(world)

    expect(world.spawned).toHaveLength(2)
    expect(await call($, 'mcp__fellowship__quest')).toMatch(/: stuck/)
  })

  test('holds the member off the branch, the commits and the mods\' folders, and lets it build', async ($, on) => {
    const world = machine(on)
    await $.session.start({} as never)
    await call($, 'mcp__fellowship__set_out')
    await settle(world)

    const by = async (agentId: string, command: string) => $.tool.call({ tool: 'Bash', command, agentId } as never)

    expect(await by('frodo-1', 'git commit -am done')).toMatchObject({ deny: expect.stringMatching(/Fellowship commits/) })
    expect(await by('frodo-1', 'pytest beacons')).toMatchObject({ result: 'ran' })
    expect(await by('someone-else', 'git commit -am done')).toMatchObject({ result: 'ran' })
    expect(world.spawned).toHaveLength(1)
  })

  test('on an auto quest, goes on task by task and opens the pull request that closes the issue', async ($, on) => {
    const world = machine(on)
    await $.session.start({} as never)
    await call($, 'mcp__fellowship__set_out', { auto: true })
    await settle(world)

    await ends($, 'frodo-1', 'built 1')
    await settle(world)
    expect(world.spawned[1]).toMatchObject({ subagent_type: 'fellowship:gimli' })
    world.judgements = [JUDGED.sitting, JUDGED.pass]
    await ends($, 'gimli-1', 'built 2')
    await settle(world)

    expect(world.spawned).toHaveLength(2)
    expect(world.ran).toContain('git push -u origin fellowship/12-beacons-answer-how-long-they-have-burned')
    expect(world.ran.find(line => line.startsWith('gh pr create'))).toMatch(/--base main --head fellowship\/12-.*\(Frodo\)[\s\S]*\(Gimli\)[\s\S]*Closes lienardquentin\/claude-code-shenanigans#12/s)
    expect(await call($, 'mcp__fellowship__quest')).toMatch(/: sailed[\s\S]*Pull request: https:\/\/github\.com\/.*\/pull\/13/)
  })
})
