import { describe, expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { foundUrl, gathered } from '../hooks/doom'

type Engine = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

const CWD = '/proj'
const REF = 'github:lienardquentin/claude-code-shenanigans#34'
const BRANCH = 'fellowship/34-gondor-quench-a-single-beacon'
const PR = 'https://github.com/lienardquentin/claude-code-shenanigans/pull/40'

describe('the relics', () => {
  test('are one a branch: a quest and the gate open on its pull request are one, kept by the issue\'s ref', () => {
    const relics = gathered([
      { keeper: 'fellowship', text: JSON.stringify([{ ref: REF, branch: BRANCH, base: 'main', pr: '', phase: 'sailed' }]) },
      { keeper: 'bombadil', text: JSON.stringify([{ ref: 'github:o/r#35', branch: 'bombadil/35-x', base: 'main', pr: '', phase: 'home' }]) },
      { keeper: 'blackgate', text: JSON.stringify([{ ref: 'lienardquentin/claude-code-shenanigans#40', branch: BRANCH, base: 'main', pr: PR, phase: 'done' }]) },
      { keeper: 'fellowship', text: 'not json' },
    ])

    expect(relics).toEqual([
      { ref: REF, branch: BRANCH, base: 'main', pr: PR, keepers: ['fellowship', 'blackgate'], isMerged: false },
      { ref: 'github:o/r#35', branch: 'bombadil/35-x', base: 'main', pr: '', keepers: ['bombadil'], isMerged: false },
    ])
  })

  test('find a merged pull request by its branch on either forge', () => {
    expect(foundUrl(JSON.stringify([{ url: PR }]))).toBe(PR)
    expect(foundUrl(JSON.stringify([{ web_url: 'https://gitlab.com/g/p/-/merge_requests/3' }]))).toBe('https://gitlab.com/g/p/-/merge_requests/3')
    expect(foundUrl('[]')).toBe('')
  })
})

/** Stands for the machine, the forge, the mods that keep work, and the engine beneath the mod. */
const machine = (on: On) => {
  const world = {
    tools: [] as string[],
    ran: [] as string[],
    forgot: [] as string[],
    keepsNothing: [] as string[],
    branch: BRANCH,
    dirty: '',
    state: 'OPEN',
    toasts: [] as string[],
    kept: { fellowship: [{ ref: REF, branch: BRANCH, base: 'main', pr: '', phase: 'sailed' }], bombadil: [], blackgate: [{ ref: 'lienardquentin/claude-code-shenanigans#40', branch: BRANCH, base: 'main', pr: PR, phase: 'done' }] } as Record<string, unknown[]>,
    clock: mock.clock(on, { now: 1_800_000_000_000 }),
  }

  on('session.cwd', () => ({ value: CWD }) as never)
  on('process.run', (_, e) => {
    const line = e.argv.join(' ')
    world.ran.push(line)
    const answer = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: exitCode === 0 ? '' : 'no', isStdoutTruncated: false, isStderrTruncated: false } }) as never

    if (line === 'git remote get-url origin') return answer('git@github.com:lienardquentin/claude-code-shenanigans.git\n')
    if (line.startsWith('gh pr view')) return answer(JSON.stringify({ state: world.state, headRefName: BRANCH }))
    if (line.startsWith('gh pr list')) return answer('[]')
    if (line === 'git rev-parse --abbrev-ref HEAD') return answer(`${world.branch}\n`)
    if (line === 'git status --porcelain') return answer(world.dirty)
    if (line.startsWith('git switch ')) {
      world.branch = e.argv.at(-1) ?? ''

      return answer('')
    }
    if (line.startsWith('git rev-parse --verify')) return answer('', 0)

    return answer('')
  })
  on('mcp.call', (_, e) => {
    const text = (said: string) => ({ value: { content: [{ type: 'text', text: said }], isError: false } }) as never

    if (e.tool === 'relics') return text(JSON.stringify(world.kept[e.server] ?? []))
    if (e.tool === 'forget') {
      world.forgot.push(`${e.server} ${String(e.args.ref ?? '')} ${String(e.args.pr ?? '')}`.trim())
      world.kept[e.server] = []
      // A mod that keeps nothing of the relic says so, and is not counted
      const forgotten = !world.keepsNothing.includes(e.server)

      return text(e.args.json === true ? JSON.stringify({ forgotten, text: forgotten ? 'It is forgotten.' : 'Nothing is kept.' }) : 'It is forgotten.')
    }

    return { value: { content: [], isError: true } } as never
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
  test('watches what the mods keep, tells the person once when it is merged, and offers Claude no way to cast it', async ($, on) => {
    const world = machine(on)
    await $.session.start({} as never)

    expect(world.tools).toEqual(['pane', 'relics'])
    expect(await call($, 'mcp__mountdoom__relics')).toMatch(/watches 1 relic; 0 merged[\s\S]*· github:.*#34 on fellowship\/34-gondor-quench-a-single-beacon \(fellowship, blackgate\) · https:.*\/pull\/40$/)

    world.state = 'MERGED'
    await world.clock.advance(31_000)
    await world.clock.advance(10 * 60_000)

    expect(world.toasts).toHaveLength(1)
    expect(await call($, 'mcp__mountdoom__relics')).toMatch(/1 merged, ready for the fire[\s\S]*🔥[\s\S]*merged\n\nThe person casts them with \/mountdoom cast/)
  })

  test('casts nothing that is not merged', async ($, on) => {
    const world = machine(on)
    await $.session.start({} as never)

    expect(await casting($, world)).toMatch(/^Nothing kept is merged yet\./)
    expect(world.forgot).toEqual([])
    expect(world.ran.some(line => line.startsWith('git branch -D'))).toBe(false)
  })

  test('casts a merged quest into the fire: back on its base, brought up to date, its branch deleted, and every mod made to forget', async ($, on) => {
    const world = machine(on)
    world.state = 'MERGED'
    await $.session.start({} as never)

    // Nothing is asked of the other mods beneath the command's hooks
    expect((await $.command.run({ command: 'mountdoom', args: 'cast' } as never)).text).toMatch(/the pane says/)
    expect(world.forgot).toEqual([])

    await world.clock.advance(600)

    const said = (world.toasts.at(-1) ?? '').replace(/^Mount Doom: /, '')

    expect(world.ran).toContain('git switch main')
    expect(world.ran).toContain('git pull --ff-only origin main')
    expect(world.ran).toContain(`git branch -D ${BRANCH}`)
    // The Mirror is asked to forget the vision of this issue alone
    expect(world.forgot).toEqual([`fellowship ${REF} ${PR}`, `blackgate ${REF} ${PR}`, `elrond ${REF} ${PR}`, `lothlorien ${REF}`])
    expect(said).toBe(`${REF} is cast into the fire: back on main, main brought up to date, ${BRANCH} deleted, forgotten by fellowship, blackgate, elrond, lothlorien.`)
  })

  test('counts as forgetting only a mod that says, as JSON, it forgot', async ($, on) => {
    const world = machine(on)
    world.state = 'MERGED'
    world.keepsNothing = ['lothlorien', 'blackgate']
    await $.session.start({} as never)

    expect(await casting($, world)).toMatch(/forgotten by fellowship, elrond\.$/)
  })

  test('leaves a checked-out branch with uncommitted changes as it is', async ($, on) => {
    const world = machine(on)
    world.state = 'MERGED'
    world.dirty = ' M beacons/gondor/app.py\n'
    await $.session.start({} as never)

    expect(await casting($, world)).toMatch(/is checked out with uncommitted changes/)
    expect(world.forgot).toEqual([])
  })
})
