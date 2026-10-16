import { describe, expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { foundUrl, gathered } from '../hooks/mountdoom/doom'

type Engine = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

const CWD = '/proj'
const REF = 'github:lienardquentin/claude-code-shenanigans#34'
const BRANCH = 'fellowship/34-gondor-quench-a-single-beacon'
const PR = 'https://github.com/lienardquentin/claude-code-shenanigans/pull/40'
const TREE = `${CWD}/.fellowship/trees/fellowship-34-gondor-quench-a-single-beacon`
const REVIEW_REF = 'review:lienardquentin/claude-code-shenanigans#40'

describe('the relics', () => {
  test('are one a branch: a quest and the gate open on its pull request are one, kept by the issue\'s ref, with its worktree', () => {
    const relics = gathered([
      { keeper: 'blackgate', kept: [{ ref: 'lienardquentin/claude-code-shenanigans#40', branch: BRANCH, base: 'main', pr: PR }] },
      { keeper: 'fellowship', kept: [{ ref: REF, branch: BRANCH, base: 'main', tree: TREE, pr: '' }, { ref: 'github:o/r#35', branch: 'fellowship/35-x', base: 'main', tree: '', pr: '' }] },
      { keeper: 'fellowship', kept: [{ branch: '' }] },
    ])

    expect(relics).toEqual([
      { ref: REF, branch: BRANCH, base: 'main', tree: TREE, pr: PR, keepers: ['blackgate', 'fellowship'], quests: [REF], isMerged: false },
      { ref: 'github:o/r#35', branch: 'fellowship/35-x', base: 'main', tree: '', pr: '', keepers: ['fellowship'], quests: ['github:o/r#35'], isMerged: false },
    ])
  })

  test('find a merged pull request by its branch on either forge', () => {
    expect(foundUrl(JSON.stringify([{ url: PR }]))).toBe(PR)
    expect(foundUrl(JSON.stringify([{ web_url: 'https://gitlab.com/g/p/-/merge_requests/3' }]))).toBe('https://gitlab.com/g/p/-/merge_requests/3')
    expect(foundUrl('[]')).toBe('')
  })
})

/** A quest the Fellowship keeps across sessions, as its store holds it. */
const quest = (tree: string, pr = PR) => ({ kind: 'plan', ref: REF, url: '', title: 'Quench a single beacon', branch: BRANCH, base: 'main', tree, isAuto: false, phase: 'sailed', march: null, proof: '', proofLine: '', verdictLine: '', commits: [], pr, at: 0 })

/** The plan Elrond keeps of the issue. */
const PLAN = { ref: REF, url: '', title: 'Quench a single beacon', summary: '', approach: '', tasks: [], questions: [], decided: [], risks: [], accepted: [], at: 0 }

/** Stands for the machine and the forge beneath the mod, and the store the Fellowship and Elrond keep their work in. */
const machine = (on: On, kept: { tree?: string; isPlanned?: boolean; isReviewed?: boolean } = {}) => {
  const world = {
    tools: [] as string[],
    ran: [] as string[],
    branch: BRANCH,
    // The branch the forge says the pull request was merged from
    mergedFrom: BRANCH,
    dirty: '',
    // What the quest's worktree holds uncommitted
    treeDirty: '',
    isTreeGone: false,
    state: 'OPEN',
    toasts: [] as string[],
    clock: mock.clock(on, { now: 1_800_000_000_000 }),
  }

  // A review of the same pull request, answered by the Fellowship on the same branch
  const review = { ...quest(kept.tree ?? ''), kind: 'review', ref: REVIEW_REF }
  mock.store(on, { [`quest:${REF}`]: quest(kept.tree ?? ''), ...(kept.isReviewed === true ? { [`quest:${REVIEW_REF}`]: review } : {}), ...(kept.isPlanned !== false ? { [`plan:${REF}`]: PLAN } : {}) })
  // Whether the quest's worktree is gone already, removed by an earlier cast
  on('fs.exists', (_, e) => ({ value: !(world.isTreeGone && (e as unknown as { path: string }).path === TREE) }) as never)
  on('session.cwd', () => ({ value: CWD }) as never)
  on('process.run', (_, e) => {
    const line = e.argv.join(' ')
    world.ran.push(line)
    const answer = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: exitCode === 0 ? '' : 'no', isStdoutTruncated: false, isStderrTruncated: false } }) as never

    if (line === 'git remote get-url origin') return answer('git@github.com:lienardquentin/claude-code-shenanigans.git\n')
    if (line.startsWith('gh pr view')) return answer(JSON.stringify({ state: world.state, headRefName: world.mergedFrom }))
    if (line.startsWith('gh pr list')) return answer('[]')
    if (line === 'git rev-parse --show-toplevel') return answer(`${CWD}\n`)
    if (line === 'git rev-parse --abbrev-ref HEAD') return answer(`${world.branch}\n`)
    if (line === 'git status --porcelain') return answer(world.dirty)
    if (line === `git -C ${TREE} status --porcelain`) return answer(world.treeDirty)
    // What the tree holds, the mods' own folders left out
    if (line.startsWith(`git -C ${TREE} status --porcelain -- `)) return answer(world.treeDirty.split('\n').filter(one => !/ \.(elrond|argonath|anduril|fellowship|lothlorien|blackgate)\//.test(one)).join('\n'))
    // Andúril builds the quest's CLI in a worktree of its own, inside the quest's
    if (line === 'git worktree list --porcelain') return answer([`worktree ${CWD}\nbranch refs/heads/main\n`, `worktree ${TREE}\nbranch refs/heads/${BRANCH}\n`, `worktree ${TREE}/.anduril/trees/narsil\ndetached\n`].join('\n'))
    if (line.startsWith('git switch ')) {
      world.branch = e.argv.at(-1) ?? ''

      return answer('')
    }
    if (line.startsWith('git rev-parse --verify')) return answer('', 0)

    return answer('')
  })
  on('command.register', () => ({ value: undefined }) as never)
  on('tool.register', (_, e) => {
    world.tools.push(String((e as unknown as { name: string }).name))

    return { value: undefined } as never
  })
  on('session.start', () => ({ cwd: CWD }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.toast', (_, e) => {
    world.toasts.push(String((e as unknown as { text?: string }).text ?? e))

    return { value: undefined } as never
  })
  on('ui.notify', () => ({ value: { isSent: true, channel: 'terminal_bell' } }) as never)

  return world
}

const call = async ($: Engine, tool: string) => String((await $.tool.call({ tool } as never)).result)

/** Casts as the person types it: the command answers at once, and the clock casts, telling what came of it. */
const casting = async ($: Engine, world: ReturnType<typeof machine>, args = 'cast'): Promise<string> => {
  expect((await $.command.run({ command: 'mountdoom', args } as never)).text).toMatch(/the pane says/)
  await world.clock.advance(600)

  return (world.toasts.at(-1) ?? '').replace(/^Mount Doom: /, '')
}

describe('mountdoom', () => {
  test('watches what the Fellowship keeps, tells the person once when it is merged, and offers Claude no way to cast it', async ($, on) => {
    const world = machine(on)
    await $.session.start({} as never)

    expect(world.tools).toContain('relics')
    expect(world.tools.some(tool => /cast|burn|fire/.test(tool))).toBe(false)
    expect(await call($, 'mcp__middle-earth__relics')).toMatch(/watches 1 relic; 0 merged[\s\S]*· github:.*#34 on fellowship\/34-gondor-quench-a-single-beacon \(fellowship\) · https:.*\/pull\/40$/)

    // The first look, once the session has settled, finds it merged; every look after it tells the person nothing more
    world.state = 'MERGED'
    await world.clock.advance(31_000)

    expect(world.toasts.filter(toast => toast.startsWith('Mount Doom'))).toHaveLength(1)
    expect(await call($, 'mcp__middle-earth__relics')).toMatch(/1 merged, ready for the fire[\s\S]*🔥[\s\S]*merged\n\nThe person casts them with \/mountdoom cast/)
    expect(world.toasts.filter(toast => toast.startsWith('Mount Doom'))).toHaveLength(1)
  })

  test('casts nothing that is not merged', async ($, on) => {
    const world = machine(on)
    await $.session.start({} as never)

    expect(await casting($, world)).toMatch(/^Nothing kept is merged yet\./)
    expect(world.ran.some(line => line.startsWith('git branch -D'))).toBe(false)
  })

  test('casts nothing whose pull request was merged from another branch than the quest\'s, and keeps the quest', async ($, on) => {
    const world = machine(on)
    world.state = 'MERGED'
    world.mergedFrom = 'some-other-branch'
    await $.session.start({} as never)

    expect(await casting($, world)).toMatch(/^Nothing kept is merged yet\./)
    expect(world.ran.some(line => line.startsWith('git branch -D'))).toBe(false)
    expect(await call($, 'mcp__middle-earth__relics')).toMatch(/watches 1 relic; 0 merged/)
  })

  test('casts a merged quest into the fire: back on its base, brought up to date, its branch deleted, and the quest and its plan forgotten', async ($, on) => {
    const world = machine(on)
    world.state = 'MERGED'
    await $.session.start({} as never)

    expect(await casting($, world)).toBe(`${REF} is cast into the fire: back on main, main brought up to date, ${BRANCH} deleted, forgotten by fellowship, elrond.`)
    expect(world.ran).toContain('git switch main')
    expect(world.ran).toContain('git pull --ff-only origin main')
    expect(world.ran).toContain(`git branch -D ${BRANCH}`)
    // Nothing is kept of it any more
    expect(await call($, 'mcp__middle-earth__relics')).toMatch(/^Nothing is kept of any quest/)
  })

  test('removes the worktree a quest was built in before its branch, and leaves one with uncommitted work in it as it is', async ($, on) => {
    const world = machine(on, { tree: TREE })
    world.state = 'MERGED'
    // The person's checkout is elsewhere: the quest was built in its worktree
    world.branch = 'main'
    world.treeDirty = ' M beacons/gondor/app.py\n'
    await $.session.start({} as never)

    expect(await casting($, world)).toMatch(new RegExp(`${TREE} holds uncommitted changes`))
    expect(world.ran.some(line => line.startsWith('git worktree remove') || line.startsWith('git branch -D'))).toBe(false)

    world.treeDirty = ''
    expect(await casting($, world)).toBe(`${REF} is cast into the fire: its worktree removed, main brought up to date, ${BRANCH} deleted, forgotten by fellowship, elrond.`)
    expect(world.ran.indexOf(`git worktree remove --force ${TREE}`)).toBeGreaterThan(-1)
    expect(world.ran.indexOf(`git worktree remove --force ${TREE}`)).toBeLessThan(world.ran.indexOf(`git branch -D ${BRANCH}`))
  })

  test('removes a worktree that holds only what the mods keep there, the worktrees nested in it first', async ($, on) => {
    const world = machine(on, { tree: TREE })
    world.state = 'MERGED'
    world.branch = 'main'
    // Andúril's build, untracked: none of the quest's work
    world.treeDirty = '?? .anduril/\n'
    await $.session.start({} as never)

    expect(await casting($, world)).toMatch(/is cast into the fire: its worktree removed/)
    expect(world.ran.indexOf(`git worktree remove --force ${TREE}/.anduril/trees/narsil`)).toBeGreaterThan(-1)
    expect(world.ran.indexOf(`git worktree remove --force ${TREE}/.anduril/trees/narsil`)).toBeLessThan(world.ran.indexOf(`git worktree remove --force ${TREE}`))
  })

  test('casts every quest kept on the branch, and takes a worktree already gone for removed', async ($, on) => {
    const world = machine(on, { tree: TREE, isReviewed: true })
    world.state = 'MERGED'
    world.branch = 'main'
    world.isTreeGone = true
    await $.session.start({} as never)

    expect(await casting($, world)).toMatch(/is cast into the fire/)
    expect(world.ran.some(line => line.startsWith('git worktree remove'))).toBe(false)
    // Neither quest on the branch is kept any more
    const kept = String((await $.tool.call({ tool: 'mcp__middle-earth__relics' } as never)).result)
    expect(kept).not.toContain(REF)
    expect(kept).not.toContain(REVIEW_REF)
  })

  test('counts as forgetting only a part that kept something of it', async ($, on) => {
    const world = machine(on, { isPlanned: false })
    world.state = 'MERGED'
    await $.session.start({} as never)

    expect(await casting($, world)).toMatch(/forgotten by fellowship\.$/)
  })

  test('leaves a checked-out branch with uncommitted changes as it is', async ($, on) => {
    const world = machine(on)
    world.state = 'MERGED'
    world.dirty = ' M beacons/gondor/app.py\n'
    await $.session.start({} as never)

    expect(await casting($, world)).toMatch(/is checked out with uncommitted changes/)
    expect(world.ran).not.toContain(`git branch -D ${BRANCH}`)
  })
})
