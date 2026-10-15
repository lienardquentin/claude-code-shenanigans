import { describe, expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { branchOf, closingLine, commitMessage, companionPrompt, errandTask, handBackOf, isForbiddenGit, isModPath, isModSource, isOutside, issueOf, memberFor, nextTask, parseJudgement, parsePlan, parseWorktrees, prArgv, proofVerdict, purposeOf, reachesOut, reviewTasks, statuesFor, treePathOf, triesOf, unsettledOf } from '../hooks/quest'
import type { QuestOf } from '../hooks/quest'
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

const REF = PLAN.ref
const BRANCH = 'fellowship/12-beacons-answer-how-long-they-have-burned'
const TREE = `${CWD}/.fellowship/trees/fellowship-12-beacons-answer-how-long-they-have-burned`

/** The quest the plan's prompts and messages are made for. */
const QUEST: QuestOf = { kind: 'plan', ref: REF, url: PLAN.url, title: PLAN.title, branch: BRANCH }

const plan = (change: Partial<FellowshipPlan> = {}): FellowshipPlan => ({ ...(parsePlan(JSON.stringify(PLAN)) as FellowshipPlan), ...change })

const PINNED_TEXT = ['gondor: 1 kept request changed · 1 pinned.', '', 'pinned: GET /beacons/minas-tirith', '  pinned by test_burned: it fails on the commit\'s source and passes on the working tree.'].join('\n')
const BARE_TEXT = ['gondor: 1 kept request changed · 1 bare.', '', 'bare: GET /beacons/minas-tirith', '  no test is marked on it.'].join('\n')

/** A proof as Argonath answers it to a mod. */
const proofOf = (verdict: string, line: string, text: string, unhandled: string[] = []) => JSON.stringify({ verdict, line, targets: [], unhandled, text })

const PINNED = proofOf('settled', 'every changed run is pinned', PINNED_TEXT)
const BARE = proofOf('unsettled', 'not pinned yet: 1 bare', BARE_TEXT)
const UNLOOKED = proofOf('unlooked', 'Argonath could not look at gondor (No request of gondor is kept to play.)', 'No request of gondor is kept to play.')

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

// An issue as Elrond reads it, for an errand
const ISSUE = { ref: 'github:lienardquentin/claude-code-shenanigans#21', url: 'https://github.com/lienardquentin/claude-code-shenanigans/issues/21', title: 'Quench answers 404 for an unknown beacon', body: 'It answers 500 today.', comments: [{ author: 'faramir', body: 'Seen on amon-din too.' }] }

// What the Black Gate hands over of a pull request's review comments
const REVIEW = {
  ref: 'lienardquentin/claude-code-shenanigans#13',
  url: 'https://github.com/lienardquentin/claude-code-shenanigans/pull/13',
  title: 'Beacons answer how long they have burned',
  branch: BRANCH,
  base: 'main',
  comments: [
    { title: 'Name it burned_seconds', brief: 'Name it burned_seconds: the unit belongs in the name.', author: 'faramir', where: 'beacons/gondor/app.py:70', url: 'https://github.com/x/pull/13#r1', weight: 'light', files: ['beacons/gondor/app.py'] },
    { title: 'Why not a timestamp?', brief: 'Why answer seconds and not the timestamp itself?', author: 'denethor', where: '', url: 'https://github.com/x/pull/13#r2', weight: 'standard', files: [] },
  ],
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

  test('sends the task begun first, else the first whose dependencies are done, and passes over one handed back', () => {
    expect(nextTask(plan())?.id).toBe(1)

    const [first, second] = plan().tasks

    expect(nextTask(plan({ tasks: [{ ...first!, state: 'done' }, second!] }))?.id).toBe(2)
    expect(nextTask(plan({ tasks: [first!, { ...second!, dependsOn: [], state: 'doing' }] }))?.id).toBe(2)
    expect(nextTask(plan({ tasks: [{ ...first!, state: 'asked' }, { ...second!, dependsOn: [] }] }))?.id).toBe(2)
  })
})

describe('the issue, its branch and its worktree', () => {
  test('are read from Elrond\'s short spelling, self-hosted or not', () => {
    expect(issueOf('github:o/r#12')).toEqual({ forge: 'github', server: 'github.com', repo: 'o/r', number: 12 })
    expect(issueOf('gitlab:git.corp.io/g/sub/p#3')).toEqual({ forge: 'gitlab', server: 'git.corp.io', repo: 'g/sub/p', number: 3 })
    expect(branchOf(plan())).toBe(BRANCH)
    expect(treePathOf(`${CWD}/`, BRANCH)).toBe(TREE)
    expect(closingLine('gitlab:g/p#3')).toBe('Closes g/p#3')
  })

  test('are found among the worktrees git lists, a detached one with no branch', () => {
    expect(parseWorktrees(`worktree ${CWD}\nHEAD abc\nbranch refs/heads/main\n\nworktree ${TREE}\nHEAD def\nbranch refs/heads/${BRANCH}\n\nworktree /proj/.argonath/trees/gondor\nHEAD 123\ndetached\n`)).toEqual([
      { path: CWD, branch: 'main' },
      { path: TREE, branch: BRANCH },
      { path: '/proj/.argonath/trees/gondor', branch: '' },
    ])
  })

  test('name the commit and the pull request that closes it, on either forge', () => {
    expect(commitMessage(QUEST, plan(), plan().tasks[0]!, 'Merry', ['- Isildur, app.py:70: lit could be named burning.'])).toMatch(
      /^#12: Keep when a beacon is lit\n\nTask 1 of the Elrond plan for https:\/\/github\.com\/.*\/issues\/12, built by Merry of the Fellowship[\s\S]*Minor findings of the statues, left as they are:\n- Isildur, app\.py:70[\s\S]*Co-Authored-By: Claude/,
    )

    const quest = { kind: 'plan', ref: REF, base: 'main', branch: 'fellowship/12-x', commits: [{ taskId: 1, title: 'Keep', sha: 'abcdef1234', by: 'Frodo', minor: ['- Isildur, app.py:70: lit could be named burning.'] }] } as unknown as FellowshipQuest

    expect(prArgv(quest, plan()).slice(0, 7)).toEqual(['gh', 'pr', 'create', '--base', 'main', '--head', 'fellowship/12-x'])
    expect(prArgv(quest, plan()).at(-1)).toMatch(/- abcdef1 1\. Keep \(Frodo\)[\s\S]*## Minor findings[\s\S]*- task 1: Isildur, app\.py:70[\s\S]*Closes lienardquentin\/claude-code-shenanigans#12/)
    expect(prArgv({ ...quest, ref: 'gitlab:g/p#3' }, plan({ ref: 'gitlab:g/p#3' }))).toContain('--target-branch')
  })
})

describe('Argonath\'s proof', () => {
  test('is read from the JSON Argonath answers a mod: settled, unsettled, or not looked at', () => {
    expect(proofVerdict(PINNED)).toEqual({ isSettled: true, isUnlooked: false, line: 'every changed run is pinned', unhandled: [], unreached: [], text: PINNED_TEXT })
    expect(proofVerdict(BARE)).toMatchObject({ isSettled: false, isUnlooked: false, line: 'not pinned yet: 1 bare' })
    expect(proofVerdict(UNLOOKED)).toMatchObject({ isSettled: false, isUnlooked: true })
    expect(proofVerdict(proofOf('settled', 'every changed run is pinned; nothing proves anor', '', ['anor'])).unhandled).toEqual(['anor'])
  })

  test('that does not read is taken as one that could not look, never as a settled change', () => {
    expect(proofVerdict(PINNED_TEXT)).toMatchObject({ isSettled: false, isUnlooked: true })
  })
})

describe('the statues of a task', () => {
  test('are Isildur alone, and Anárion with him on a heavy task or one a high risk threatens', () => {
    const made = plan({ risks: [{ text: 'Data loss', severity: 'high', mitigation: '', tasks: [2], wantsTask: false }] })
    const [light, standard] = made.tasks

    expect(statuesFor(made, light!)).toEqual(['isildur'])
    expect(statuesFor(made, standard!)).toEqual(['isildur', 'anarion'])
    expect(statuesFor(plan(), { ...standard!, weight: 'heavy' })).toEqual(['isildur', 'anarion'])
    expect(statuesFor(plan(), standard!)).toEqual(['isildur'])
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
    const prompt = companionPrompt(QUEST, made, made.tasks[1]!, 'gimli', { attempt: 2, by: 'Gimli', answer: 'Added burned_for.', proof: BARE_TEXT })

    expect(prompt).toMatch(/Risks that threaten this task:\n- \(medium\) Old beacons have no lit_at Mitigation: Default to null/)
    expect(prompt).toMatch(/Task 2: Answer the seconds burned[\s\S]*Done when: A test reads burned_for/)
    expect(prompt).toMatch(/This is try 2\. The change Gimli made[\s\S]*What Gimli said:[\s\S]*<proof>\ngondor: 1 kept request changed · 1 bare/)
    expect(companionPrompt(QUEST, made, made.tasks[0]!, 'frodo')).not.toMatch(/Risks that threaten/)

    const judged = companionPrompt(QUEST, made, made.tasks[1]!, 'gimli', { attempt: 2, by: 'Gimli', answer: '', findings: ['- Anárion, app.py:72: The archive error is swallowed whole.'] })

    expect(judged).toMatch(/the review found what blocks the change\. Fix each:\n<findings>\n- Anárion, app\.py:72/)
    expect(judged).not.toContain('<proof>')
  })

  test('hands a plan\'s task back only as Gandalf, an errand or a review comment as any member', () => {
    const made = plan()

    expect(companionPrompt(QUEST, made, made.tasks[0]!, 'frodo')).not.toMatch(/hand it back/)
    expect(companionPrompt(QUEST, made, made.tasks[0]!, 'gandalf')).toMatch(/You may hand it back if it cannot be built as the plan says/)

    const errand = { ...QUEST, kind: 'errand' as const, ref: ISSUE.ref, title: ISSUE.title }
    const task = errandTask(ISSUE)

    expect(companionPrompt(errand, made, task, 'gimli')).toMatch(/^The issue: github:.*#21, "Quench answers 404 for an unknown beacon"[\s\S]*<issue>\nIt answers 500 today\.\n\n--- faramir:\nSeen on amon-din too\.\n<\/issue>[\s\S]*You may hand it back if it is not one/)
    expect(handBackOf('I looked.\nHanded back: it needs a decision on 410.')).toBe('it needs a decision on 410.')
    expect(handBackOf('Done.')).toBeUndefined()
  })

  test('commits nothing, moves no branch, stays in its worktree, and leaves the mods\' folders alone', () => {
    for (const command of ['git commit -am x', 'cd a && git push', 'git -C . checkout main', 'git stash']) expect(isForbiddenGit(command)).toBe(true)
    for (const command of ['git status', 'git diff HEAD', 'pytest -k commit', 'echo git']) expect(isForbiddenGit(command)).toBe(false)
    expect(isModPath(TREE, `${TREE}/.elrond/plans/x.json`)).toBe(true)
    expect(isModPath(TREE, `${TREE}/beacons/gondor/app.py`)).toBe(false)
    expect(isOutside(TREE, `${CWD}/beacons/gondor/app.py`)).toBe(true)
    expect(isOutside(TREE, `${TREE}/beacons/gondor/app.py`)).toBe(false)
    expect(isOutside(TREE, 'beacons/gondor/app.py')).toBe(false)
    // A path climbs out of the worktree as well as it names a place outside it
    expect(isOutside(TREE, `${TREE}/../../../beacons/gondor/app.py`)).toBe(true)
    expect(isOutside(TREE, '../../../beacons/gondor/app.py')).toBe(true)
    expect(isOutside(TREE, 'beacons/../narsil/./src/main.rs')).toBe(false)
    // A shell command reaches the person's checkout by naming it: Gimli once built an errand there with cd
    for (const command of [`cd ${CWD}/narsil && cargo test`, `cd ${CWD}`, `sed -n 1,9p '${CWD}/narsil/src/main.rs'`, `cargo test --manifest-path ${CWD}/narsil/Cargo.toml`]) expect(reachesOut(CWD, TREE, command)).toBe(true)
    for (const command of [`cd ${TREE}/narsil && cargo test`, 'cd narsil && cargo test', `ls ${CWD}-old/narsil`, `git -C ${TREE} diff`]) expect(reachesOut(CWD, TREE, command)).toBe(false)
    // A fix to a mod is not the quest's, unless the task is about the mod: it would ride into its pull request
    const task = { files: ['beacons/gondor/app.py'] }

    expect(isModSource(CWD, '/proj/.claude/mods/argonath/handlers/live.py', task)).toBe(true)
    expect(isModSource(CWD, '.claude/mods/fellowship/hooks/quest.ts', task)).toBe(true)
    expect(isModSource(CWD, '/proj/.claude/argonath', task)).toBe(false)
    expect(isModSource(CWD, '/proj/.claude/mods/argonath/handlers/live.py', { files: ['.claude/mods/argonath/handlers/live.py'] })).toBe(false)
  })

  test('is told every decision the person made, the answers to the plan\'s own questions among them, and so are the statues', () => {
    const made = plan({ decided: [{ text: 'Is an unlit beacon 0 or null?', answer: 'null' }], questions: [{ text: 'How long may a keeper be?', options: [], answer: '64 characters, refused with a 422' }, { text: 'Open?', options: [], answer: '' }] })
    const prompt = companionPrompt(QUEST, made, made.tasks[0]!, 'frodo')
    const purpose = purposeOf(QUEST, made, made.tasks[0]!)

    for (const text of [prompt, purpose]) {
      expect(text).toContain('- Is an unlit beacon 0 or null? → null')
      expect(text).toContain('- How long may a keeper be? → 64 characters, refused with a 422')
      expect(text).not.toContain('Open?')
    }
  })
})

describe('a review handed over', () => {
  test('is a task a comment, each fenced as data with who wrote it and where', () => {
    const tasks = reviewTasks(REVIEW.comments)

    expect(tasks.map(task => `${task.id} ${task.weight} ${task.author ?? ''}`)).toEqual(['1 light faramir', '2 standard denethor'])

    const quest = { kind: 'review' as const, ref: `review:${REVIEW.ref}`, url: REVIEW.url, title: REVIEW.title, branch: BRANCH }
    const prompt = companionPrompt(quest, plan(), tasks[0]!, 'frodo')

    expect(prompt).toMatch(/^You answer one review comment on the pull request lienardquentin\/claude-code-shenanigans#13[\s\S]*by faramir, on beacons\/gondor\/app\.py:70:\n<comment>\nName it burned_seconds/)
    expect(commitMessage(quest, plan(), tasks[0]!, 'Frodo')).toMatch(/^Review: Name it burned_seconds: the unit belongs in the name\.\n\nAnswers faramir's comment on beacons\/gondor\/app\.py:70 on lienardquentin\/claude-code-shenanigans#13/)
  })
})

/** Stands for the machine, Elrond, Argonath, Lothlórien and the engine beneath the mod. */
const machine = (on: On) => {
  const world = {
    ran: [] as string[],
    // Where each git command ran: the person's checkout, or a quest's worktree
    at: [] as { line: string; cwd: string }[],
    spawned: [] as Record<string, unknown>[],
    submitted: [] as string[],
    toasts: [] as string[],
    marked: [] as string[],
    store: {} as Record<string, unknown>,
    files: {} as Record<string, string>,
    // The plan in force, and the kept plans of other issues by their ref
    plan: structuredClone(PLAN) as typeof PLAN | null,
    kept: {} as Record<string, typeof PLAN>,
    issue: ISSUE as Record<string, unknown>,
    proofs: [PINNED] as string[],
    judgements: [JUDGED.sitting, JUDGED.pass] as string[],
    registered: [] as Record<string, unknown>[],
    tools: [] as string[],
    prState: {} as Record<string, unknown>,
    convened: 0,
    // What the Mirror answers, in turn; none, and Lothlórien is not there
    mirror: [] as string[],
    gazed: [] as Record<string, unknown>[],
    about: [] as string[],
    // The person's checkout: its branch and what it holds uncommitted, which no quest touches
    branch: 'main',
    mine: '',
    branches: ['main'] as string[],
    worktrees: [{ path: CWD, branch: 'main' }] as { path: string; branch: string }[],
    // What a quest's worktree holds uncommitted
    dirty: '',
    head: 'c0ffee1aaaa',
    commits: 0,
    // What the Fellowship sent a member back with, by its id
    sent: [] as { agentId: string; text: string }[],
    statues: [] as unknown[],
    against: [] as unknown[],
    models: [] as unknown[],
    trees: [] as unknown[],
    // What each proof was asked with
    proved: [] as Record<string, unknown>[],
    clock: mock.clock(on, { now: 1_800_000_000_000 }),
  }

  const planOf = (ref: unknown) => (typeof ref !== 'string' || ref === '' || ref === world.plan?.ref ? world.plan : (world.kept[ref] ?? null))

  on('session.cwd', () => ({ value: CWD }) as never)
  on('fs.write', (_, e) => {
    world.files[e.path] = e.text

    return { value: undefined } as never
  })
  on('process.run', (_, e) => {
    const line = e.argv.join(' ')
    const cwd = (e as unknown as { init?: { cwd?: string } }).init?.cwd ?? CWD
    world.ran.push(line)
    world.at.push({ line, cwd })

    const answer = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: exitCode === 0 ? '' : 'no', isStdoutTruncated: false, isStderrTruncated: false } }) as never

    if (line === 'git rev-parse --show-toplevel') return answer(`${CWD}\n`)
    if (line === 'git rev-parse --abbrev-ref HEAD') return answer(`${cwd === CWD ? world.branch : (world.worktrees.find(one => one.path === cwd)?.branch ?? '')}\n`)
    if (line === 'git status --porcelain') return answer(cwd === CWD ? world.mine : world.dirty)
    if (line === 'git worktree list --porcelain') return answer(world.worktrees.map(one => `worktree ${one.path}\nHEAD ${world.head}\nbranch refs/heads/${one.branch}\n`).join('\n'))
    if (line.startsWith('git worktree add')) {
      const isNew = e.argv[3] === '-b'
      const branch = isNew ? (e.argv[4] ?? '') : (e.argv.at(-1) ?? '')
      world.worktrees.push({ path: (isNew ? e.argv[5] : e.argv[3]) ?? '', branch })
      if (!world.branches.includes(branch)) world.branches.push(branch)

      return answer('')
    }
    if (line.startsWith('git worktree remove')) {
      world.worktrees = world.worktrees.filter(one => one.path !== e.argv.at(-1))

      return answer('')
    }
    if (line.startsWith('git rev-parse --verify')) return answer('', world.branches.includes((e.argv.at(-1) ?? '').replace('refs/heads/', '')) ? 0 : 1)
    if (line.startsWith('git branch -D ')) {
      world.branches = world.branches.filter(one => one !== e.argv.at(-1))

      return answer('')
    }
    if (line.startsWith('git commit')) {
      world.dirty = ''
      world.commits += 1
      world.head = `c0ffee${world.commits + 1}aaaa`

      return answer('')
    }
    if (line === 'git rev-parse HEAD') return answer(`${world.head}\n`)
    if (e.argv[0] === 'gh' && e.argv[1] === 'pr' && e.argv[2] === 'view') return answer(JSON.stringify(world.prState))
    if (e.argv[0] === 'gh') return answer('https://github.com/lienardquentin/claude-code-shenanigans/pull/13\n')

    return answer('')
  })
  on('mcp.call', (_, e) => {
    const text = (said: string) => ({ value: { content: [{ type: 'text', text: said }], isError: false } }) as never

    if (e.server === 'elrond' && e.tool === 'plan') return text(JSON.stringify(planOf(e.args.ref)))
    if (e.server === 'elrond' && e.tool === 'issue') return text(JSON.stringify(world.issue))
    if (e.server === 'elrond' && e.tool === 'task') {
      world.marked.push(`${String(e.args.id)} ${String(e.args.state)}`)
      const task = planOf(e.args.ref)?.tasks.find(one => one.id === e.args.id)
      if (task !== undefined) task.state = String(e.args.state)

      return text('marked')
    }
    if (e.server === 'argonath' && e.tool === 'prove') {
      world.proved.push(e.args)

      return text(world.proofs.length > 1 ? (world.proofs.shift() ?? '') : (world.proofs[0] ?? ''))
    }
    if (e.server === 'argonath' && e.tool === 'targets') return text(JSON.stringify(TARGETS))
    if (e.server === 'lothlorien' && world.mirror.length > 0) {
      if (e.tool === 'gaze') {
        world.gazed.push(e.args)

        return text('Galadriel gazes into the Mirror.')
      }

      return text(world.mirror.length > 1 ? (world.mirror.shift() ?? '') : (world.mirror[0] ?? ''))
    }
    if (e.server === 'argonath' && e.tool === 'judgement') {
      if (e.args.convene === true) {
        world.convened += 1
        world.about.push(String(e.args.about))
        world.statues.push(e.args.statues)
        world.against.push(e.args.against)
        world.models.push(e.args.model)
        world.trees.push(e.args.tree)
      }

      return text(world.judgements.length > 1 ? (world.judgements.shift() ?? '') : (world.judgements[0] ?? ''))
    }

    return { value: { content: [], isError: true } } as never
  })
  on('session.send', (_, e) => {
    // A plugin's address arrives as it gave it
    const to = e.to as unknown as string | { agentId: string }
    world.sent.push({ agentId: typeof to === 'string' ? to : to.agentId, text: e.text })

    return { isDelivered: true } as never
  })
  on('agent.spawn', (_, e) => {
    world.spawned.push(e as unknown as Record<string, unknown>)
    // The member builds something, in its worktree
    world.dirty = ' M beacons/gondor/app.py\n'

    return { model: 'opus', agentId: `${String((e as unknown as { subagent_type?: string }).subagent_type ?? '').replace(/^fellowship:/, '')}-1` } as never
  })
  // Core alone mints an agent's id: the member is known by the type it runs as
  on('agent.list', () => ({ value: [...Object.keys(MEMBERS).map(name => ({ id: `${name}-1`, description: 'Task', type: `fellowship:${name}`, status: 'running' })), { id: 'someone-else', description: 'x', type: 'Explore', status: 'running' }] }) as never)
  on('prompt.submit', (_, e) => {
    world.submitted.push(e.text)

    return { text: e.text } as never
  })
  on('store.get', (_, e) => ({ value: world.store[(e as unknown as { key: string }).key] }) as never)
  on('store.keys', () => ({ value: Object.keys(world.store) }) as never)
  on('store.delete', (_, e) => {
    delete world.store[(e as unknown as { key: string }).key]

    return { value: undefined } as never
  })
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
  on('tool.register', (_, e) => {
    world.tools.push(String((e as unknown as { name: string }).name))

    return { value: undefined } as never
  })
  on('session.start', () => ({ cwd: CWD }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.toast', (_, e) => {
    world.toasts.push(String((e as unknown as { text: string }).text))

    return { value: undefined } as never
  })
  on('ui.notify', () => ({ value: { isSent: true, channel: 'terminal_bell' } }) as never)
  on('turn.complete', () => ({ text: '' }) as never)
  on('tool.call', { tool: 'Bash' }, () => ({ result: 'ran' }) as never)
  on('tool.call', { tool: 'Edit' }, () => ({ result: 'edited' }) as never)

  return world
}

const call = async ($: Engine, tool: string, input: Record<string, unknown> = {}) => String((await $.tool.call({ tool, ...input } as never)).result)

const ends = ($: Engine, agentId: string, answer: string) => $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId: 't', reason: 'answer', agentId } as never)

/** Lets the clock do what was asked of it. */
const settle = async (world: ReturnType<typeof machine>) => {
  for (let at = 0; at < 16; at += 1) await world.clock.advance(600)
}

/** The git commands that ran in a folder. */
const gitIn = (world: ReturnType<typeof machine>, cwd: string) => world.at.filter(one => one.cwd === cwd && one.line.startsWith('git ')).map(one => one.line)

describe('fellowship', () => {
  test('sets out on a settled plan in a worktree of its own, on a branch of its own, and sends a hobbit there on a light first task', async ($, on) => {
    const world = machine(on)
    await $.session.start({} as never)

    expect(await call($, 'mcp__fellowship__set_out')).toMatch(new RegExp(`sets out on github:.*#12.*on ${BRANCH} from main, in its worktree ${TREE}`))
    await settle(world)

    expect(world.ran).toContain(`git worktree add -b ${BRANCH} ${TREE} main`)
    expect(world.files[`${CWD}/.fellowship/.gitignore`]).toBe('*\n')
    // The person's checkout is never switched
    expect(world.ran.some(line => line.startsWith('git switch'))).toBe(false)
    expect(world.marked).toEqual(['1 doing'])
    expect(world.spawned[0]).toMatchObject({ subagent_type: 'fellowship:frodo', description: 'Frodo: task 1, Keep when a beacon is lit', cwd: TREE })
  })

  test('offers Claude no tool that pushes or opens a pull request: the person sails', async ($, on) => {
    const world = machine(on)
    await $.session.start({} as never)

    expect(world.tools).toEqual(['pane', 'set_out', 'errand', 'relics', 'forget', 'quest', 'commit'])
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
    expect(String(registered[0]?.prompt)).toContain('Handed back:')
    expect(String(registered[0]?.prompt)).toContain("in the quest's git worktree, which is your working directory")
    expect(registered[0]?.disallowedTools).toContain('mcp__argonath__judgement')
  })

  test('does not set out on a plan the council left open, and sets out whatever the person\'s checkout holds', async ($, on) => {
    const world = machine(on)
    world.plan = { ...PLAN, questions: [{ text: 'Q', options: [], answer: '' }] }

    expect(await call($, 'mcp__fellowship__set_out')).toMatch(/not settled: 1 unanswered question/)
    expect(world.spawned).toHaveLength(0)

    world.plan = structuredClone(PLAN)
    world.mine = ' M README.md\n'

    expect(await call($, 'mcp__fellowship__set_out')).toMatch(/sets out on github:.*#12/)
    expect(gitIn(world, CWD).some(line => /^git (add|commit|stash|switch|checkout)/.test(line))).toBe(false)
  })

  test('proves what the member built in its worktree, sends the statues to judge it there, and commits it there once they pass it', async ($, on) => {
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

    expect(world.proved[0]).toMatchObject({ owe: false, tree: TREE })
    expect(world.convened).toBe(1)
    expect(world.trees[0]).toBe(TREE)
    expect(world.about[0]).toMatch(/^Task 1 of the plan for github:.*#12, "Beacons answer how long they have burned": Keep when a beacon is lit\.[\s\S]*Done when: lit_at is set on light\nDecided by the person: [^\n]*\n- Is an unlit beacon 0 or null\? → null\nLeft to later tasks, and so not owed by this change:\n- 2\. Answer the seconds burned$/)
    expect(gitIn(world, TREE).find(line => line.startsWith('git commit -m'))).toMatch(/^git commit -m #12: Keep when a beacon is lit[\s\S]*built by Frodo[\s\S]*- Isildur, app\.py:70: lit could be named burning\./)
    expect(world.marked).toEqual(['1 doing', '1 done'])
    // No Claude is woken: the statues are the judges
    expect(world.submitted).toEqual([])
    // Attended: the next task waits for the person
    expect(world.spawned).toHaveLength(1)
    expect(await call($, 'mcp__fellowship__quest')).toMatch(/: ready[\s\S]*● 1\. Keep when a beacon is lit · c0ffee/)
  })

  test('sends the member back once with what the statues find blocking, then the task a rung up with the findings alone', async ($, on) => {
    const world = machine(on)
    world.judgements = [JUDGED.fail, JUDGED.fail, JUDGED.pass]
    await $.session.start({} as never)
    await call($, 'mcp__fellowship__set_out')
    await settle(world)

    await ends($, 'frodo-1', 'Added lit_at.')
    await settle(world)

    // Frodo has the change in his context: he mends it before a fresh member starts over cold
    expect(world.spawned).toHaveLength(1)
    expect(world.sent).toEqual([{ agentId: 'frodo-1', text: expect.stringMatching(/its review found what blocks it[\s\S]*<findings>\n- Anárion, app\.py:72: The archive error is swallowed whole\.\n<\/findings>/) }])

    await ends($, 'frodo-1', 'Raised it, I think.')
    await settle(world)

    expect(world.spawned[1]).toMatchObject({ subagent_type: 'fellowship:gimli', cwd: TREE })
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

    // Each is sent back once with the proof, then a fresh member a rung up starts over
    for (const member of ['frodo', 'gimli', 'aragorn', 'gandalf']) {
      await ends($, `${member}-1`, `try of ${member}`)
      await settle(world)
      await ends($, `${member}-1`, `try of ${member}`)
      await settle(world)
    }

    expect(world.spawned.map(one => one.subagent_type)).toEqual(['fellowship:frodo', 'fellowship:gimli', 'fellowship:aragorn', 'fellowship:gandalf'])
    expect(world.sent.map(one => one.agentId)).toEqual(['frodo-1', 'gimli-1', 'aragorn-1', 'gandalf-1'])
    expect(world.sent[0]?.text).toMatch(/does not settle your change yet[\s\S]*<proof>\ngondor: 1 kept request changed · 1 bare/)
    expect(String(world.spawned[1]?.prompt)).toMatch(/What Frodo said:\n<said>\ntry of frodo[\s\S]*bare: GET/)
    expect(world.convened).toBe(0)
    expect(await call($, 'mcp__fellowship__quest')).toMatch(/: stuck[\s\S]*Last proof: not pinned yet: 1 bare/)
  })

  test('stops for the plan to be revised when Gandalf hands the task back', async ($, on) => {
    const world = machine(on)
    world.plan = { ...structuredClone(PLAN), tasks: PLAN.tasks.map(task => ({ ...task, weight: 'heavy' })) }
    world.proofs = [BARE]
    await $.session.start({} as never)
    await call($, 'mcp__fellowship__set_out')
    await settle(world)

    await ends($, 'aragorn-1', 'Could not.')
    await settle(world)
    await ends($, 'aragorn-1', 'Still could not.')
    await settle(world)
    expect(world.spawned[1]).toMatchObject({ subagent_type: 'fellowship:gandalf' })
    expect(String(world.spawned[1]?.prompt)).toMatch(/You may hand it back if it cannot be built as the plan says/)

    await ends($, 'gandalf-1', 'I looked.\nHanded back: beacons keep no clock to measure from.')
    await settle(world)

    expect(world.spawned).toHaveLength(2)
    expect(await call($, 'mcp__fellowship__quest')).toMatch(/: stuck/)
    expect(world.toasts.some(text => /Gandalf hands github:.*#12 back: beacons keep no clock/.test(text))).toBe(true)
  })

  test('holds the member off the branch, the commits, the mods\' folders and the person\'s checkout, and lets it build', async ($, on) => {
    const world = machine(on)
    await $.session.start({} as never)
    await call($, 'mcp__fellowship__set_out')
    await settle(world)

    const by = async (agentId: string, command: string) => $.tool.call({ tool: 'Bash', command, agentId } as never)
    const edit = async (agentId: string, file_path: string) => $.tool.call({ tool: 'Edit', file_path, old_string: 'a', new_string: 'b', agentId } as never)

    expect(await by('frodo-1', 'git commit -am done')).toMatchObject({ deny: expect.stringMatching(/Fellowship commits/) })
    expect(await by('frodo-1', 'pytest beacons')).toMatchObject({ result: 'ran' })
    expect(await by('someone-else', 'git commit -am done')).toMatchObject({ result: 'ran' })
    expect(await edit('frodo-1', `${CWD}/beacons/gondor/app.py`)).toMatchObject({ deny: expect.stringMatching(/You work in the quest's worktree/) })
    expect(await edit('frodo-1', `${TREE}/.elrond/plans/x.json`)).toMatchObject({ deny: expect.stringMatching(/belongs to a mod/) })
    expect(await edit('frodo-1', `${TREE}/beacons/gondor/app.py`)).toMatchObject({ result: 'edited' })
    // A path that climbs out of the worktree is outside it, and so is a folder searched there
    expect(await edit('frodo-1', `${TREE}/../../../beacons/gondor/app.py`)).toMatchObject({ deny: expect.stringMatching(/You work in the quest's worktree/) })
    expect(await $.tool.call({ tool: 'Grep', pattern: 'lit', path: CWD, agentId: 'frodo-1' } as never)).toMatchObject({ deny: expect.stringMatching(/You work in the quest's worktree/) })
    expect(world.spawned).toHaveLength(1)
  })

  test('sends its members under the session\'s own permission mode, as every agent a mod sends', async ($, on) => {
    const world = machine(on)
    await $.session.start({} as never)

    expect(world.registered.length).toBeGreaterThan(0)
    for (const spec of world.registered) expect(spec).not.toHaveProperty('permissionMode')
  })

  test('is abandoned at the person\'s word: its worktree removed, its branch deleted, its tasks reopened, and set out on afresh', async ($, on) => {
    const world = machine(on)
    await $.session.start({} as never)
    await call($, 'mcp__fellowship__set_out')
    await settle(world)

    // A member out is waited for
    expect((await $.command.run({ command: 'fellowship', args: 'abandon' } as never)).text).toMatch(/is marching: wait until Frodo is back/)

    await ends($, 'frodo-1', 'Added lit_at.')
    await settle(world)

    // The clock abandons it, outside the command's hooks
    expect((await $.command.run({ command: 'fellowship', args: 'abandon' } as never)).text).toMatch(/being abandoned/)
    await settle(world)

    expect(world.toasts.at(-1)).toBe(`Fellowship: The quest on ${REF} is abandoned. Its worktree is removed. ${BRANCH} is deleted, with its 1 commit. 1 task is open again in the Elrond plan.`)
    expect(world.ran).toContain(`git worktree remove ${TREE}`)
    expect(world.ran).toContain(`git branch -D ${BRANCH}`)
    expect(world.marked.at(-1)).toBe('1 todo')
    expect(world.store[`quest:${REF}`]).toBeUndefined()

    // Nothing is kept: the plan is set out on afresh, from its first task
    expect(await call($, 'mcp__fellowship__set_out')).toMatch(/sets out on github:.*#12/)
  })

  test('has Galadriel write the tests of a task that is not light first, in the worktree, and sends its member to make them pass', async ($, on) => {
    const world = machine(on)
    const shown = JSON.stringify({ state: 'shown', isLocked: true, tests: [{ file: 'beacons/tests/test_gondor.py', name: 'test_burned_for' }], red: 'FAILED test_burned_for - KeyError', why: '', amendments: [] })
    world.plan = { ...structuredClone(PLAN), tasks: [{ ...structuredClone(PLAN.tasks[1]!), id: 1, dependsOn: [] }] }
    world.mirror = [JSON.stringify({ state: 'gazing' }), shown, JSON.stringify({ ...JSON.parse(shown), amendments: [{ file: 'beacons/tests/test_gondor.py', why: 'It asserted seconds as a string.', by: 'fellowship:gimli' }] })]
    await $.session.start({} as never)
    await call($, 'mcp__fellowship__set_out')
    await settle(world)

    expect(world.gazed[0]).toMatchObject({ tree: TREE, ref: REF, purpose: expect.stringMatching(/^Task 1 of the plan for github:.*: Answer the seconds burned\.[\s\S]*Done when: A test reads burned_for/) })
    expect(world.spawned).toHaveLength(1)
    expect(world.spawned[0]).toMatchObject({ subagent_type: 'fellowship:gimli' })
    expect(String(world.spawned[0]?.prompt)).toMatch(/Galadriel's tests show what is to come[\s\S]*- beacons\/tests\/test_gondor\.py: test_burned_for\nHow they failed:\n<red>\nFAILED test_burned_for - KeyError\n<\/red>/)

    await ends($, 'gimli-1', 'Made them pass.')
    await settle(world)

    // Her tests are owed a pass on the working tree before the proof settles
    expect(world.proved[0]).toMatchObject({ owe: false, tree: TREE, mustPass: [{ file: 'beacons/tests/test_gondor.py', name: 'test_burned_for' }] })
    // The statues are told what was changed of her tests, and why
    expect(world.about[0]).toContain("the builder changed some, saying why. Judge whether each reason holds:\n- beacons/tests/test_gondor.py, by fellowship:gimli: It asserted seconds as a string.")
    expect(world.ran.some(line => line.startsWith('git commit -m #12: Answer the seconds burned'))).toBe(true)
  })

  test('skips the Mirror for a light task, and builds a task it shows nothing for as it is', async ($, on) => {
    const world = machine(on)
    world.mirror = [JSON.stringify({ state: 'empty', why: 'Nothing to see.' })]
    await $.session.start({} as never)
    await call($, 'mcp__fellowship__set_out')
    await settle(world)

    // Task 1 is light: no gaze
    expect(world.gazed).toEqual([])
    await ends($, 'frodo-1', 'Added lit_at.')
    await settle(world)
    await call($, 'mcp__fellowship__set_out')
    await settle(world)

    // Task 2 is standard: she gazes, shows nothing to test, and it is built as it is
    expect(world.gazed).toHaveLength(1)
    expect(world.spawned[1]).toMatchObject({ subagent_type: 'fellowship:gimli' })
    expect(String(world.spawned[1]?.prompt)).not.toContain("Galadriel's tests")
    // With none of hers, no test is owed a pass beyond the proof's own
    expect(world.proved[0]).not.toHaveProperty('mustPass')
  })

  test('stops for the person when the Mirror is clouded, and gazes anew when the task is sent again', async ($, on) => {
    const world = machine(on)
    world.plan = { ...structuredClone(PLAN), tasks: [{ ...structuredClone(PLAN.tasks[1]!), id: 1, dependsOn: [] }] }
    world.mirror = [JSON.stringify({ state: 'clouded', why: 'she did not show her tests red' })]
    await $.session.start({} as never)
    await call($, 'mcp__fellowship__set_out')
    await settle(world)

    expect(world.spawned).toEqual([])
    expect(await call($, 'mcp__fellowship__quest')).toMatch(/: stuck/)

    world.mirror = [JSON.stringify({ state: 'empty', why: 'x' })]
    expect((await $.command.run({ command: 'fellowship', args: 'next' } as never)).text).toMatch(/sent on the next task/)
    await settle(world)
    expect(world.gazed).toHaveLength(2)
    expect(world.spawned).toHaveLength(1)
  })

  test('forgets a quest only once the forge says its pull request is merged from its branch', async ($, on) => {
    const world = machine(on)
    await $.session.start({} as never)
    await call($, 'mcp__fellowship__set_out')
    await settle(world)

    expect(JSON.parse(await call($, 'mcp__fellowship__relics'))).toMatchObject([{ ref: REF, kind: 'plan', branch: BRANCH, base: 'main', tree: TREE }])

    const pr = 'https://github.com/lienardquentin/claude-code-shenanigans/pull/13'
    world.prState = { state: 'OPEN', headRefName: BRANCH }
    expect(await call($, 'mcp__fellowship__forget', { ref: REF, pr })).toMatch(/is not a merged pull request/)

    world.prState = { state: 'MERGED', headRefName: 'some-other-branch' }
    expect(await call($, 'mcp__fellowship__forget', { ref: REF, pr })).toMatch(/is not a merged pull request/)

    world.prState = { state: 'MERGED', headRefName: BRANCH }
    expect(await call($, 'mcp__fellowship__forget', { ref: REF, pr })).toBe(`The quest on ${REF} is forgotten.`)
    expect(JSON.parse(await call($, 'mcp__fellowship__relics'))).toEqual([])
  })

  test('sets out from /fellowship --auto through the clock, which reads the plan outside the command\'s hooks', async ($, on) => {
    const world = machine(on)
    await $.session.start({} as never)

    expect((await $.command.run({ command: 'fellowship', args: '--auto' } as never)).text).toMatch(/sets out on the Elrond plan, going on by itself/)
    expect(world.ran).toEqual([])
    await settle(world)

    expect(world.toasts[0]).toMatch(/sets out on github:.*#12/)
    expect(world.spawned[0]).toMatchObject({ subagent_type: 'fellowship:frodo' })
    expect(await call($, 'mcp__fellowship__quest')).toMatch(/going on by itself/)
  })

  test('on an auto quest, goes on task by task and opens the pull request that closes the issue, from its worktree', async ($, on) => {
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
    expect(gitIn(world, TREE)).toContain(`git push -u origin ${BRANCH}`)
    expect(world.ran.find(line => line.startsWith('gh pr create'))).toMatch(/--base main --head fellowship\/12-.*\(Frodo\)[\s\S]*\(Gimli\)[\s\S]*Closes lienardquentin\/claude-code-shenanigans#12/s)
    expect(await call($, 'mcp__fellowship__quest')).toMatch(/: sailed[\s\S]*Pull request: https:\/\/github\.com\/.*\/pull\/13/)
  })

  test('builds quests on two issues side by side, each in its own worktree, and acts on the one a command names', async ($, on) => {
    const world = machine(on)
    const other = { ...structuredClone(PLAN), ref: 'github:lienardquentin/claude-code-shenanigans#14', title: 'Beacons answer who lit them' }
    world.kept[other.ref] = other
    await $.session.start({} as never)

    await call($, 'mcp__fellowship__set_out')
    await call($, 'mcp__fellowship__set_out', { ref: other.ref })
    await settle(world)

    const otherTree = `${CWD}/.fellowship/trees/fellowship-14-beacons-answer-who-lit-them`
    expect(world.spawned.map(one => one.cwd)).toEqual([TREE, otherTree])
    expect(world.marked).toEqual(['1 doing', '1 doing'])

    // The first quest's member ends: only that quest is proved
    await ends($, 'frodo-1', 'Added lit_at.')
    await settle(world)
    expect(world.proved).toHaveLength(1)
    expect(world.proved[0]).toMatchObject({ tree: TREE })

    // A command that names none acts on the quest the pane shows, the last set out; one names another by its ref or branch
    expect((await $.command.run({ command: 'fellowship', args: 'halt' } as never)).text).toMatch(/#14 stops after the task it is on/)
    expect((await $.command.run({ command: 'fellowship', args: `halt ${BRANCH}` } as never)).text).toMatch(/#12 stops after the task it is on/)
    expect((await $.command.run({ command: 'fellowship', args: 'halt #99' } as never)).text).toMatch(/No quest on #99 is under way/)
    expect(await call($, 'mcp__fellowship__quest')).toMatch(/#12 \(plan\)[\s\S]*―――[\s\S]*#14 \(plan\)/)
  })
})

describe('an errand', () => {
  test('builds a small issue in one change in its worktree, and waits for the person\'s go to open its pull request', async ($, on) => {
    const world = machine(on)
    world.judgements = [JUDGED.pass]
    await $.session.start({} as never)

    expect((await $.command.run({ command: 'fellowship', args: 'errand #21' } as never)).text).toMatch(/sets out on #21 as an errand/)
    await settle(world)

    const tree = `${CWD}/.fellowship/trees/fellowship-21-quench-answers-404-for-an-unknown-beacon`
    expect(world.spawned[0]).toMatchObject({ subagent_type: 'fellowship:gimli', cwd: tree })
    expect(String(world.spawned[0]?.prompt)).toMatch(/^The issue: github:.*#21[\s\S]*<issue>\nIt answers 500 today\./)
    // No council planned it, and no Mirror is gazed into
    expect(world.marked).toEqual([])

    await ends($, 'gimli-1', 'Quench answers 404 now; test_quench_unknown proves it.')
    await settle(world)

    expect(world.statues[0]).toEqual(['isildur'])
    expect(world.about[0]).toMatch(/^The whole of issue github:.*#21, "Quench answers 404 for an unknown beacon", in one change, as an errand/)
    expect(gitIn(world, tree).find(line => line.startsWith('git commit -m'))).toMatch(/^git commit -m #21: Quench answers 404 for an unknown beacon\n\nThe whole of https:\/\/github\.com\/.*\/issues\/21 as an errand, built by Gimli/)
    expect(await call($, 'mcp__fellowship__quest', { ref: ISSUE.ref })).toMatch(/\(errand\)[\s\S]*: arrived/)
    expect(world.ran.some(line => line.startsWith('git push'))).toBe(false)

    // The person says go: no ward for one change judged whole
    await $.command.run({ command: 'fellowship', args: `sail ${ISSUE.ref}` } as never)
    await settle(world)
    expect(world.convened).toBe(1)
    expect(world.ran.find(line => line.startsWith('gh pr create'))).toMatch(/Quench answers 404 now; test_quench_unknown proves it\.[\s\S]*Built as an errand[\s\S]*Closes lienardquentin\/claude-code-shenanigans#21/)
  })

  test('is handed back when it is no errand, for the council to plan', async ($, on) => {
    const world = machine(on)
    await $.session.start({} as never)
    await call($, 'mcp__fellowship__errand', { issue: '#21' })
    await settle(world)

    await ends($, 'gimli-1', 'Handed back: it asks whether an unknown beacon is 404 or 410, which the person decides.')
    await settle(world)

    expect(world.proved).toEqual([])
    expect(await call($, 'mcp__fellowship__quest', { ref: ISSUE.ref })).toMatch(/: stuck/)
    expect(world.toasts.some(text => /Gimli hands github:.*#21 back: it asks whether/.test(text))).toBe(true)
  })

  test('does not arrive when its member left no change in the worktree', async ($, on) => {
    const world = machine(on)
    world.judgements = [JUDGED.pass]
    await $.session.start({} as never)
    await call($, 'mcp__fellowship__errand', { issue: '#21' })
    await settle(world)

    // It built in the person's checkout instead: the worktree is clean
    world.dirty = ''
    await ends($, 'gimli-1', 'Quench answers 404 now; test_quench_unknown proves it.')
    await settle(world)

    expect(world.ran.some(line => line.startsWith('git commit'))).toBe(false)
    expect(await call($, 'mcp__fellowship__quest', { ref: ISSUE.ref })).toMatch(/\(0\/1 done\): stuck/)
  })
})

describe('a review handed over by the Black Gate', () => {
  test('answers each comment on the pull request\'s branch, leaves a question to the person, and pushes once told', async ($, on) => {
    const world = machine(on)
    world.judgements = [JUDGED.pass]
    await $.session.start({} as never)

    expect(await call($, 'mcp__fellowship__set_out', { kind: 'review', review: REVIEW })).toMatch(new RegExp(`sets out on review:lienardquentin/claude-code-shenanigans#13.*on ${BRANCH} from main, in its worktree ${TREE}`))
    await settle(world)

    // The pull request's own branch, fetched and checked out in a worktree
    expect(world.ran).toContain(`git fetch origin ${BRANCH}`)
    expect(world.ran).toContain(`git worktree add ${TREE} ${BRANCH}`)
    expect(world.spawned[0]).toMatchObject({ subagent_type: 'fellowship:frodo', cwd: TREE })

    await ends($, 'frodo-1', 'Renamed it burned_seconds.')
    await settle(world)
    expect(gitIn(world, TREE).find(line => line.startsWith('git commit -m'))).toMatch(/^git commit -m Review: Name it burned_seconds/)

    // The second comment asks a question: its member builds nothing and hands it back
    await $.command.run({ command: 'fellowship', args: 'next' } as never)
    await settle(world)
    world.dirty = ''
    await ends($, 'gimli-1', 'Handed back: whether to answer seconds or a timestamp is the author\'s call.')
    await settle(world)

    expect(await call($, 'mcp__fellowship__quest')).toMatch(/: arrived[\s\S]*\? 2\. Why not a timestamp\?.*whether to answer seconds or a timestamp/)
    expect(world.ran.some(line => line.startsWith('git push'))).toBe(false)

    await $.command.run({ command: 'fellowship', args: 'sail' } as never)
    await settle(world)
    expect(gitIn(world, TREE)).toContain(`git push -u origin ${BRANCH}`)
    expect(world.ran.some(line => line.startsWith('gh pr create'))).toBe(false)
    expect(await call($, 'mcp__fellowship__quest')).toMatch(/: sailed/)
  })

  test('is built where the pull request\'s branch is checked out already, and its branch is never deleted', async ($, on) => {
    const world = machine(on)
    world.worktrees = [{ path: CWD, branch: BRANCH }]
    world.branch = BRANCH
    await $.session.start({} as never)

    expect(await call($, 'mcp__fellowship__set_out', { kind: 'review', review: REVIEW })).toMatch(/in your own checkout, where its branch is/)
    await settle(world)
    expect(world.spawned[0]).toMatchObject({ cwd: CWD })
    expect(world.ran.some(line => line.startsWith('git worktree add'))).toBe(false)

    await ends($, 'frodo-1', 'Renamed it.')
    await settle(world)
    await $.command.run({ command: 'fellowship', args: 'abandon' } as never)
    await settle(world)

    expect(world.ran.some(line => line.startsWith('git worktree remove') || line.startsWith('git branch -D'))).toBe(false)
  })
})

describe('the hand-offs of a task', () => {
  test('stop the quest when the member committed past the proof, and commit nothing of it', async ($, on) => {
    const world = machine(on)
    await $.session.start({} as never)
    await call($, 'mcp__fellowship__set_out')
    await settle(world)

    // The member got a commit past the guard: HEAD moved, and the tree is clean
    world.head = 'deadbeef99'
    world.dirty = ''
    await ends($, 'frodo-1', 'Added lit_at, and committed it.')
    await settle(world)

    expect(world.convened).toBe(0)
    expect(world.marked).toEqual(['1 doing'])
    expect(await call($, 'mcp__fellowship__quest')).toMatch(/: stuck/)
    expect(world.toasts.some(text => /HEAD moved from c0ffee1 to deadbee[\s\S]*git reset --soft c0ffee1/.test(text))).toBe(true)
  })

  test('stop at once where Argonath could not look at what the change reached: no member mends that', async ($, on) => {
    const world = machine(on)
    world.proofs = [UNLOOKED]
    await $.session.start({} as never)
    await call($, 'mcp__fellowship__set_out')
    await settle(world)

    await ends($, 'frodo-1', 'Added lit_at.')
    await settle(world)

    expect(world.spawned).toHaveLength(1)
    expect(world.sent).toEqual([])
    expect(world.convened).toBe(0)
    expect(await call($, 'mcp__fellowship__quest')).toMatch(/: stuck[\s\S]*Last proof: Argonath could not look at gondor/)
  })

  test('send Isildur alone on a light task, and both statues where nothing proves what it reached', async ($, on) => {
    const world = machine(on)
    world.proofs = [PINNED, proofOf('settled', 'every changed run is pinned; nothing proves anor', '', ['anor'])]
    world.judgements = [JUDGED.pass]
    await $.session.start({} as never)
    await call($, 'mcp__fellowship__set_out')
    await settle(world)
    await ends($, 'frodo-1', 'Added lit_at.')
    await settle(world)

    await call($, 'mcp__fellowship__set_out')
    await settle(world)
    await ends($, 'gimli-1', 'Added burned_for.')
    await settle(world)

    expect(world.statues).toEqual([['isildur'], ['isildur', 'anarion']])
    // A light task's change is judged on a lighter model; one nothing proves, on the statues' own
    expect(world.models).toEqual(['claude-sonnet-5-5', undefined])
    expect(world.ran.filter(line => line.startsWith('git commit -m')).at(-1)).toContain('Not proven by the Argonath, which has no handler for anor')
  })

  test('send the task a rung up when a member took lines out of Galadriel\'s tests with no reason', async ($, on) => {
    const world = machine(on)
    const shown = { state: 'shown', isLocked: true, tests: [{ file: 'beacons/tests/test_gondor.py', name: 'test_burned_for' }], red: 'FAILED', why: '', amendments: [], tampered: [] as unknown[] }
    world.plan = { ...structuredClone(PLAN), tasks: [{ ...structuredClone(PLAN.tasks[1]!), id: 1, dependsOn: [] }] }
    world.mirror = [JSON.stringify({ state: 'gazing' }), JSON.stringify(shown), JSON.stringify({ ...shown, tampered: [{ file: 'beacons/tests/test_gondor.py', lines: ['    assert body["burned_for"] == 3'] }] })]
    await $.session.start({} as never)
    await call($, 'mcp__fellowship__set_out')
    await settle(world)

    await ends($, 'gimli-1', 'Made them pass.')
    await settle(world)

    // Gimli is sent back once to put them back, then the task goes a rung up
    expect(world.sent).toEqual([{ agentId: 'gimli-1', text: expect.stringContaining("- Lothlórien, beacons/tests/test_gondor.py: locked lines of Galadriel's tests") }])
    await ends($, 'gimli-1', 'Left them as they were.')
    await settle(world)

    expect(world.convened).toBe(0)
    expect(world.spawned[1]).toMatchObject({ subagent_type: 'fellowship:aragorn' })
    expect(String(world.spawned[1]?.prompt)).toMatch(/<findings>\n- Lothlórien, beacons\/tests\/test_gondor\.py: locked lines of Galadriel's tests were taken out with no reason given \(`assert body\["burned_for"\] == 3`\)/)
  })

  test('have both statues judge a plan\'s whole branch in its worktree before it sails, and hold it back when they find what blocks it', async ($, on) => {
    const world = machine(on)
    world.plan = { ...structuredClone(PLAN), tasks: [structuredClone(PLAN.tasks[0]!)] }
    world.judgements = [JUDGED.pass, JUDGED.fail]
    await $.session.start({} as never)
    await call($, 'mcp__fellowship__set_out', { auto: true })
    await settle(world)
    await ends($, 'frodo-1', 'Added lit_at.')
    await settle(world)

    expect(world.statues.at(-1)).toEqual(['isildur', 'anarion'])
    expect(world.against.at(-1)).toBe('main')
    expect(world.trees.at(-1)).toBe(TREE)
    // On their own model: the whole branch is no lighter for any of its tasks being light
    expect(world.models.at(-1)).toBeUndefined()
    expect(world.about.at(-1)).toMatch(/^The whole branch of the plan for github:.*#12[\s\S]*one task undoing or contradicting another[\s\S]*- 1\. Keep when a beacon is lit/)
    expect(world.ran.some(line => line.startsWith('git push'))).toBe(false)
    expect(await call($, 'mcp__fellowship__quest')).toMatch(/: arrived[\s\S]*The statues: the whole branch: 1 blocking finding/)

    // Fixed and passed: it sails
    world.judgements = [JUDGED.pass]
    await $.command.run({ command: 'fellowship', args: 'sail' } as never)
    await settle(world)
    expect(world.ran).toContain(`git push -u origin ${BRANCH}`)
  })
})
