import { describe, expect, mock } from 'claude-code/testing'
import { test } from './hook-test'
import type { TestBody } from 'claude-code/testing'

import { firstUrl } from '../core/forge'
import { gathered } from '../hooks/cleanup/leftovers'

type Engine = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

const CWD = '/proj'
const REF = 'github:lienardquentin/claude-code-shenanigans#34'
const BRANCH = 'build/34-gondor-quench-a-single-beacon'
const PR = 'https://github.com/lienardquentin/claude-code-shenanigans/pull/40'
const TREE = `${CWD}/.theseus/trees/build-34-gondor-quench-a-single-beacon`
const REVIEW_REF = 'review:lienardquentin/claude-code-shenanigans#40'

describe('the leftovers', () => {
  test('are one a branch: a run and the follow-up open on its pull request are one, kept by the issue\'s ref, with its worktree', () => {
    const leftovers = gathered([
      { keeper: 'follow-up', kept: [{ ref: 'lienardquentin/claude-code-shenanigans#40', branch: BRANCH, base: 'main', pr: PR }] },
      { keeper: 'build', kept: [{ ref: REF, branch: BRANCH, base: 'main', tree: TREE, pr: '' }, { ref: 'github:o/r#35', branch: 'build/35-x', base: 'main', tree: '', pr: '' }] },
      { keeper: 'build', kept: [{ branch: '' }] },
    ])

    expect(leftovers).toEqual([
      { ref: REF, branch: BRANCH, base: 'main', tree: TREE, pr: PR, keepers: ['follow-up', 'build'], quests: [REF], isMerged: false },
      { ref: 'github:o/r#35', branch: 'build/35-x', base: 'main', tree: '', pr: '', keepers: ['build'], quests: ['github:o/r#35'], isMerged: false },
    ])
  })

  test('find a merged pull request by its branch on either forge', () => {
    expect(firstUrl(JSON.stringify([{ url: PR }]))).toBe(PR)
    expect(firstUrl(JSON.stringify([{ web_url: 'https://gitlab.com/g/p/-/merge_requests/3' }]))).toBe('https://gitlab.com/g/p/-/merge_requests/3')
    expect(firstUrl('[]')).toBe('')
  })
})

/** A run the build keeps across sessions, as its store holds it. */
const quest = (tree: string, pr = PR) => ({ kind: 'plan', ref: REF, url: '', title: 'Quench a single beacon', branch: BRANCH, base: 'main', tree, isAuto: false, phase: 'submitted', current: null, proof: '', proofLine: '', verdictLine: '', commits: [], pr, at: 0 })

/** The plan the planner keeps of the issue. */
const PLAN = { ref: REF, url: '', title: 'Quench a single beacon', summary: '', approach: '', tasks: [], questions: [], decided: [], risks: [], accepted: [], at: 0 }

/** Stands for the machine and the forge beneath the mod, and the store the build and the planner keep their work in. */
const machine = (on: On, kept: { tree?: string; isPlanned?: boolean; isReviewed?: boolean } = {}) => {
  const world = {
    tools: [] as string[],
    ran: [] as string[],
    branch: BRANCH,
    // The branch the forge says the pull request was merged from
    mergedFrom: BRANCH,
    dirty: '',
    // What the run's worktree holds uncommitted
    treeDirty: '',
    isTreeGone: false,
    state: 'OPEN',
    // Whether the forge can merge the open pull request into its base as it stands
    mergeable: 'MERGEABLE',
    // The commit the forge says the pull request was of, and the local branch's tip
    head: 'c0ffee1',
    tip: 'c0ffee1',
    // Whether the local tip is a commit before the merged one
    isBehindHead: false,
    // What the forge's CLI says when it cannot be asked; nothing when it can
    forgeDown: '',
    toasts: [] as string[],
    clock: mock.clock(on, { now: 1_800_000_000_000 }),
  }

  // A review of the same pull request, answered by the build on the same branch
  const review = { ...quest(kept.tree ?? ''), kind: 'review', ref: REVIEW_REF }
  mock.store(on, { [`run:${REF}`]: quest(kept.tree ?? ''), ...(kept.isReviewed === true ? { [`run:${REVIEW_REF}`]: review } : {}), ...(kept.isPlanned !== false ? { [`plan:${REF}`]: PLAN } : {}) })
  // Whether the run's worktree is gone already, removed by an earlier cleanup
  on('fs.exists', (_, e) => ({ value: !(world.isTreeGone && (e as unknown as { path: string }).path === TREE) }) as never)
  on('session.cwd', () => ({ value: CWD }) as never)
  on('process.run', (_, e) => {
    const line = e.argv.join(' ')
    world.ran.push(line)
    const answer = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: exitCode === 0 ? '' : 'no', isStdoutTruncated: false, isStderrTruncated: false } }) as never

    if (line === 'git remote get-url origin') return answer('git@github.com:lienardquentin/claude-code-shenanigans.git\n')
    if (line.startsWith('gh pr view')) return world.forgeDown !== '' ? answer(world.forgeDown, 1) : answer(JSON.stringify({ state: world.state, headRefName: world.mergedFrom, mergeable: world.mergeable, headRefOid: world.head }))
    if (line === `git rev-parse --verify --quiet refs/heads/${BRANCH}`) return answer(`${world.tip}\n`)
    if (line.startsWith('git merge-base --is-ancestor')) return answer('', world.isBehindHead ? 0 : 1)
    if (line.startsWith('gh pr list')) return answer('[]')
    if (line === 'git rev-parse --show-toplevel') return answer(`${CWD}\n`)
    if (line === 'git rev-parse --abbrev-ref HEAD') return answer(`${world.branch}\n`)
    if (line === 'git status --porcelain') return answer(world.dirty)
    if (line === `git -C ${TREE} status --porcelain`) return answer(world.treeDirty)
    // What the tree holds, the mods' own folders left out
    if (line.startsWith(`git -C ${TREE} status --porcelain -- `)) return answer(world.treeDirty.split('\n').filter(one => !/ \.(pipeline|theseus|recorder|anduril|fellowship|lothlorien|blackgate)\//.test(one)).join('\n'))
    // The recorder builds the run's CLI in a worktree of its own, inside the run's
    if (line === 'git worktree list --porcelain') return answer([`worktree ${CWD}\nbranch refs/heads/main\n`, `worktree ${TREE}\nbranch refs/heads/${BRANCH}\n`, `worktree ${TREE}/.recorder/trees/narsil\ndetached\n`].join('\n'))
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

/** Cleans up as the person types it: the command answers at once, and the clock cleans up, telling what came of it. */
const cleaning = async ($: Engine, world: ReturnType<typeof machine>, args = 'clean'): Promise<string> => {
  expect((await $.command.run({ command: 'theseus', args: `cleanup ${args}` } as never)).text).toMatch(/the pane says/)
  await world.clock.advance(600)

  return (world.toasts.at(-1) ?? '').replace(/^Cleanup: /, '')
}

describe('cleanup', () => {
  test('watches what the build keeps, tells the person once when it is merged, and offers Claude no way to clean it up', async ($, on) => {
    const world = machine(on)
    await $.session.start({} as never)

    expect(world.tools).toContain('leftovers')
    expect(world.tools.some(tool => /clean/.test(tool))).toBe(false)
    expect(await call($, 'mcp__theseus__leftovers')).toMatch(/watches 1 leftover; 0 merged[\s\S]*· github:.*#34 on build\/34-gondor-quench-a-single-beacon \(build\) · https:.*\/pull\/40$/)

    // The first look, once the session has settled, finds it merged; every look after it tells the person nothing more
    world.state = 'MERGED'
    await world.clock.advance(31_000)

    expect(world.toasts.filter(toast => toast.startsWith('Cleanup'))).toHaveLength(1)
    expect(await call($, 'mcp__theseus__leftovers')).toMatch(/1 merged, ready to clean up[\s\S]*●[\s\S]*merged\n\nThe person cleans them up with \/theseus cleanup clean/)
    expect(world.toasts.filter(toast => toast.startsWith('Cleanup'))).toHaveLength(1)
  })

  test('draws each leftover in the pane as where it stands, then its branch and keepers, then its pull request, the merged first', async ($, on) => {
    const world = machine(on)
    await $.session.start({} as never)
    const mounted = await $.ui.mount({ plugin: 'theseus', surface: 'terminal', component: 'Pane', props: { bodyColumns: 50 } as never, requestId: 'cleanup' })
    // A look asks the forge afresh; the pane is drawn again on what it found
    const pane = async () => {
      await call($, 'mcp__theseus__leftovers')
      await mounted.redraw()

      return String((await $.tool.call({ tool: 'mcp__theseus__pane', pane: 'cleanup' } as never)).result)
    }

    // Open: nothing to clean up
    const open = await pane()
    expect(open).toMatch(/● watching 1  \[l Look again\]/)
    expect(open).toMatch(/·\s+#34  open\n\s*build\/34-gondor-quench-a-single-beacon · kept by build\n\s*https:.*\/pull\/40/)
    expect(open).not.toContain('Clean them up')

    // The forge could not say: it is unknown, never open, and why is said under it
    world.forgeDown = 'gh: not logged in'
    const unknown = await pane()
    expect(unknown).toMatch(/#34  unknown\n/)
    expect(unknown).toMatch(/The forge could not say whether it is merged: /)

    // Merged: said so first, and cleaned up from the pane
    world.forgeDown = ''
    world.state = 'MERGED'
    const merged = await pane()
    expect(merged).toMatch(/● 1 merged  \[l Look again\][\s\S]*●\s+#34  merged\n/)
    expect(merged).toMatch(/\[c Clean them up\]\*/)
  })

  test('tells the person once that a pull request still open fell into conflict with its base, and again only after it eased', async ($, on) => {
    const world = machine(on)
    await $.session.start({} as never)

    // #36 went CONFLICTING when main reworked .claude/verify under it, and nothing said so
    world.mergeable = 'CONFLICTING'
    await world.clock.advance(31_000)
    const told = () => world.toasts.filter(toast => /in conflict with its base/.test(toast))

    expect(told()).toEqual(['Cleanup: github:lienardquentin/claude-code-shenanigans#34 is in conflict with its base: merge it in, then push'])
    // Each look through the tool asks the forge afresh: still in conflict, it is shown and not told again
    expect(await call($, 'mcp__theseus__leftovers')).toMatch(/\/pull\/40 · in conflict with its base$/)
    expect(told()).toHaveLength(1)

    // Merged in by hand, it is level again; a later conflict is told anew
    world.mergeable = 'MERGEABLE'
    expect(await call($, 'mcp__theseus__leftovers')).not.toMatch(/in conflict/)
    world.mergeable = 'CONFLICTING'
    await call($, 'mcp__theseus__leftovers')
    expect(told()).toHaveLength(2)
  })

  test('cleans up nothing that is not merged', async ($, on) => {
    const world = machine(on)
    await $.session.start({} as never)

    expect(await cleaning($, world)).toMatch(/^Nothing kept is merged yet\./)
    expect(world.ran.some(line => line.startsWith('git branch -D'))).toBe(false)
  })

  test('cleans up nothing whose pull request was merged from another branch than the run\'s, and keeps the run', async ($, on) => {
    const world = machine(on)
    world.state = 'MERGED'
    world.mergedFrom = 'some-other-branch'
    await $.session.start({} as never)

    expect(await cleaning($, world)).toMatch(/^Nothing kept is merged yet\./)
    expect(world.ran.some(line => line.startsWith('git branch -D'))).toBe(false)
    expect(await call($, 'mcp__theseus__leftovers')).toMatch(/watches 1 leftover; 0 merged/)
  })

  test('cleans up a merged run: back on its base, brought up to date, its branch deleted, and the run and its plan forgotten', async ($, on) => {
    const world = machine(on)
    world.state = 'MERGED'
    await $.session.start({} as never)

    expect(await cleaning($, world)).toBe(`${REF} is cleaned up: back on main, main brought up to date, ${BRANCH} deleted, forgotten by build, planner.`)
    expect(world.ran).toContain('git switch main')
    expect(world.ran).toContain('git pull --ff-only origin main')
    expect(world.ran).toContain(`git branch -D ${BRANCH}`)
    // Nothing is kept of it any more
    expect(await call($, 'mcp__theseus__leftovers')).toMatch(/^Nothing is kept of any run/)
  })

  test('removes the worktree a run was built in before its branch, and leaves one with uncommitted work in it as it is', async ($, on) => {
    const world = machine(on, { tree: TREE })
    world.state = 'MERGED'
    // The person's checkout is elsewhere: the run was built in its worktree
    world.branch = 'main'
    world.treeDirty = ' M beacons/gondor/app.py\n'
    await $.session.start({} as never)

    expect(await cleaning($, world)).toMatch(new RegExp(`${TREE} holds uncommitted changes`))
    expect(world.ran.some(line => line.startsWith('git worktree remove') || line.startsWith('git branch -D'))).toBe(false)

    world.treeDirty = ''
    expect(await cleaning($, world)).toBe(`${REF} is cleaned up: its worktree removed, main brought up to date, ${BRANCH} deleted, forgotten by build, planner.`)
    expect(world.ran.indexOf(`git worktree remove --force ${TREE}`)).toBeGreaterThan(-1)
    expect(world.ran.indexOf(`git worktree remove --force ${TREE}`)).toBeLessThan(world.ran.indexOf(`git branch -D ${BRANCH}`))
  })

  test('removes a worktree that holds only what the mods keep there, the worktrees nested in it first', async ($, on) => {
    const world = machine(on, { tree: TREE })
    world.state = 'MERGED'
    world.branch = 'main'
    // the recorder's build, untracked: none of the run's work
    world.treeDirty = '?? .recorder/\n'
    await $.session.start({} as never)

    expect(await cleaning($, world)).toMatch(/is cleaned up: its worktree removed/)
    expect(world.ran.indexOf(`git worktree remove --force ${TREE}/.recorder/trees/narsil`)).toBeGreaterThan(-1)
    expect(world.ran.indexOf(`git worktree remove --force ${TREE}/.recorder/trees/narsil`)).toBeLessThan(world.ran.indexOf(`git worktree remove --force ${TREE}`))
  })

  test('cleans up every run kept on the branch, and takes a worktree already gone for removed', async ($, on) => {
    const world = machine(on, { tree: TREE, isReviewed: true })
    world.state = 'MERGED'
    world.branch = 'main'
    world.isTreeGone = true
    await $.session.start({} as never)

    expect(await cleaning($, world)).toMatch(/is cleaned up/)
    expect(world.ran.some(line => line.startsWith('git worktree remove'))).toBe(false)
    // Neither run on the branch is kept any more
    const kept = String((await $.tool.call({ tool: 'mcp__theseus__leftovers' } as never)).result)
    expect(kept).not.toContain(REF)
    expect(kept).not.toContain(REVIEW_REF)
  })

  test('counts as forgetting only a part that kept something of it', async ($, on) => {
    const world = machine(on, { isPlanned: false })
    world.state = 'MERGED'
    await $.session.start({} as never)

    expect(await cleaning($, world)).toMatch(/forgotten by build\.$/)
  })

  test('keeps a merged branch that holds commits past the one the forge merged, and says so', async ($, on) => {
    const world = machine(on)
    world.state = 'MERGED'
    world.tip = 'beef002'
    await $.session.start({} as never)

    expect(await cleaning($, world)).toMatch(new RegExp(`${BRANCH} kept: it holds commits past c0ffee1, the one merged`))
    expect(world.ran.some(line => line.startsWith('git branch -D'))).toBe(false)
  })

  test('deletes a merged branch whose tip is a commit before the one the forge merged', async ($, on) => {
    const world = machine(on)
    world.state = 'MERGED'
    world.tip = 'abc0003'
    world.isBehindHead = true
    await $.session.start({} as never)

    expect(await cleaning($, world)).toMatch(new RegExp(`${BRANCH} deleted`))
  })

  test('says when the forge cannot be asked, cleans up nothing, and never takes it for not merged', async ($, on) => {
    const world = machine(on)
    world.state = 'MERGED'
    world.forgeDown = 'gh: authentication required'
    await $.session.start({} as never)

    expect(await call($, 'mcp__theseus__leftovers')).toMatch(/the forge could not say whether it is merged: gh could not read https:.*\/pull\/40/)
    expect(await cleaning($, world)).toMatch(/^Nothing kept is merged yet\./)
    expect(world.ran.some(line => line.startsWith('git branch -D'))).toBe(false)
  })

  test('leaves a checked-out branch with uncommitted changes as it is', async ($, on) => {
    const world = machine(on)
    world.state = 'MERGED'
    world.dirty = ' M beacons/gondor/app.py\n'
    await $.session.start({} as never)

    expect(await cleaning($, world)).toMatch(/is checked out with uncommitted changes/)
    expect(world.ran).not.toContain(`git branch -D ${BRANCH}`)
  })
})
