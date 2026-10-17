import { describe, expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { parseIssues } from '../core/forge'
import { listedOf, standingOf } from '../hooks/issues/listed'

type Engine = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

const CWD = '/proj'
const REPO = 'lienardquentin/claude-code-shenanigans'
const ORIGIN = { forge: 'github', server: 'github.com', repo: REPO } as const

const issue = (number: number, title: string, labels: string[] = []) => ({ number, title, url: `https://github.com/${REPO}/issues/${number}`, labels: labels.map(name => ({ name })), author: { login: 'quent' }, updatedAt: '2026-10-14T09:00:00Z', body: `The body of #${number}.` })

const GH_LIST = JSON.stringify([issue(12, 'Beacons answer how long they have burned', ['ready-for-agent']), issue(21, 'Quench answers 404 for an unknown beacon')])

const GH_ISSUE = (number: number, title: string) => JSON.stringify({ number, title, body: `The body of #${number}.`, url: `https://github.com/${REPO}/issues/${number}`, state: 'OPEN', labels: [], comments: [] })

/** Stands for the machine, the forge and the engine beneath the mod. */
const machine = (on: On) => {
  const world = { ran: [] as string[], spawned: [] as Record<string, unknown>[], submitted: [] as string[], toasts: [] as string[], store: {} as Record<string, unknown>, list: GH_LIST, clock: mock.clock(on, { now: 1_800_000_000_000 }), files: {} as Record<string, string> }

  on('fs.write', (_, e) => {
    world.files[e.path] = e.text

    return { value: undefined } as never
  })
  on('fs.read', (_, e) => {
    const text = world.files[e.path]
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)

    return { value: text } as never
  })
  on('session.cwd', () => ({ value: CWD }) as never)
  // No run has cost anything yet: the build's record of it is not there
  on('fs.exists', () => ({ value: false }) as never)
  on('process.run', (_, e) => {
    const line = e.argv.join(' ')
    world.ran.push(line)

    const viewed = e.argv[0] === 'gh' && e.argv[2] === 'view' ? Number(e.argv[3]) : 0
    const stdout =
      line === 'git rev-parse --show-toplevel'
        ? `${CWD}\n`
        : e.argv[0] === 'git'
          ? `git@github.com:${REPO}.git\n`
          : e.argv[0] === 'gh' && e.argv[2] === 'list'
            ? world.list
            : viewed > 0
              ? GH_ISSUE(viewed, viewed === 12 ? 'Beacons answer how long they have burned' : 'Quench answers 404 for an unknown beacon')
              : ''

    return { value: { exitCode: stdout === '' ? 1 : 0, stdout, stderr: stdout === '' ? 'not found' : '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
  on('agent.spawn', (_, e) => {
    world.spawned.push(e as unknown as Record<string, unknown>)

    return { model: 'opus' } as never
  })
  on('agent.list', () => ({ value: [{ id: 'planner-1', description: 'Plan', type: 'pipeline:planner', status: 'running' }] }) as never)
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
  on('store.keys', () => ({ value: Object.keys(world.store) }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('agent.register', () => ({ value: { agent: 'pipeline:planner' } }) as never)
  on('tool.register', () => ({ value: undefined }) as never)
  on('session.start', () => ({ cwd: CWD }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.toast', (_, e) => {
    world.toasts.push(String((e as unknown as { text?: string }).text ?? e))

    return { value: undefined } as never
  })
  on('ui.notify', () => ({ value: { isSent: true, channel: 'terminal_bell' } }) as never)
  on('turn.complete', () => ({ text: '' }) as never)

  return world
}

const call = async ($: Engine, tool: string, input: Record<string, unknown> = {}) => String((await $.tool.call({ tool, ...input } as never)).result)

const ends = ($: Engine, agentId: string, answer: string) => $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId: 't', reason: 'answer', agentId } as never)

describe('the issues listed', () => {
  test('read each issue with the ref Elrond and the build know it by, from either forge, its body cut for the pane', () => {
    expect(listedOf(parseIssues(GH_LIST) ?? [], ORIGIN)).toEqual([
      { ref: `github:${REPO}#12`, number: 12, title: 'Beacons answer how long they have burned', url: `https://github.com/${REPO}/issues/12`, labels: ['ready-for-agent'], author: 'quent', updatedAt: '2026-10-14T09:00:00Z', body: 'The body of #12.' },
      expect.objectContaining({ ref: `github:${REPO}#21`, labels: [] }),
    ])

    const gitlab = listedOf(parseIssues(JSON.stringify([{ iid: 3, title: 'T', web_url: 'https://git.example.com/g/p/-/issues/3', labels: ['bug'], author: { username: 'ann' }, updated_at: '2026-10-01', description: 'x'.repeat(700) }])) ?? [], { forge: 'gitlab', server: 'git.example.com', repo: 'g/p' })

    expect(gitlab).toEqual([expect.objectContaining({ ref: 'gitlab:git.example.com/g/p#3', number: 3, labels: ['bug'], author: 'ann', body: `${'x'.repeat(600)}…` })])
  })

  test("say where an issue stands: its run first, else its plan", () => {
    expect(standingOf({ kind: 'errand', phase: 'building' }, 'planned · 0/2 done')).toBe('errand · building')
    expect(standingOf(undefined, 'in council')).toBe('in council')
    expect(standingOf(undefined, '')).toBe('')
  })
})

describe('issues', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`lists the open issues, and sends the one opened as an errand to the build, on ${surface}`, async ($, on) => {
      const world = machine(on)
      await $.session.start({ source: 'startup', cwd: CWD } as never)

      expect((await $.command.run({ command: 'issues', args: '' } as never)).text).toBe(`2 open issues on ${REPO}.`)

      const pane = await $.ui.mount({ plugin: 'pipeline', surface, component: 'Pane', props: { bodyColumns: 120 } as never, requestId: 'issues' })
      expect(await call($, 'mcp__pipeline__pane', { pane: 'issues' })).toMatch(/2 open · lienardquentin\/claude-code-shenanigans[\s\S]*#12 Beacons answer how long they have burned \[ready-for-agent\][\s\S]*#21 Quench answers 404/)

      await pane.press({ key: 'issue-21' })
      expect(await call($, 'mcp__pipeline__pane', { pane: 'issues' })).toMatch(/#21 Quench answers 404 for an unknown beacon\s+by quent · updated 2026-10-14[\s\S]*The body of #21\.[\s\S]*\[e Errand\][\s\S]*\[c Send to the planner\]/)

      // The press only asks: the build's clock sets the errand out, which sends no agent
      await pane.press({ key: 'errand' })
      await world.clock.advance(600)
      await world.clock.advance(600)
      expect(world.toasts.find(toast => toast.startsWith('Build: '))).toMatch(new RegExp(`^Build: The build starts on github:${REPO}#21, "Quench answers 404 for an unknown beacon"`))

      // Once on the build's road, the issue is the build's: no second errand, no council
      expect(await call($, 'mcp__pipeline__pane', { pane: 'issues' })).toMatch(/#21 Quench answers 404 for an unknown beacon errand · [\s\S]*The build is on it \(errand · \w+\): \/build goes on with it\./)
      expect(await call($, 'mcp__pipeline__pane', { pane: 'issues' })).not.toContain('[e Errand]')
    })
  }

  test('sends the issue opened to the council, which sits where it is held, and opens a kept plan rather than planning afresh', async ($, on) => {
    const world = machine(on)
    await $.session.start({ source: 'startup', cwd: CWD } as never)
    await $.command.run({ command: 'issues', args: '' } as never)

    const pane = await $.ui.mount({ plugin: 'pipeline', surface: 'terminal', component: 'Pane', props: { bodyColumns: 120 } as never, requestId: 'issues' })
    await pane.press({ key: 'issue-12' })
    await pane.press({ key: 'planner' })

    // Outside a hook the council would sit unheld: the press asks, and it is sent where Claude calls for it
    expect(world.spawned).toEqual([])
    expect(await call($, 'mcp__pipeline__pane', { pane: 'issues' })).toMatch(/#12 Beacons answer how long they have burned \[ready-for-agent\] asked of the planner/)
    await call($, 'mcp__pipeline__pump')
    expect(world.spawned.map(one => one.subagentType ?? one.subagent_type)).toEqual(['pipeline:planner'])
    await world.clock.advance(600)
    expect(await call($, 'mcp__pipeline__pane', { pane: 'issues' })).toMatch(/#12 Beacons answer how long they have burned \[ready-for-agent\] being planned/)

    // A plan kept of the issue is opened, and no council reviews it again
    world.store[`plan:github:${REPO}#21`] = { ref: `github:${REPO}#21`, url: '', title: 'Quench answers 404 for an unknown beacon', summary: '', approach: '', tasks: [{ id: 1, title: 'Answer 404', why: '', steps: [], files: [], dependsOn: [], acceptance: '', weight: 'light', state: 'todo' }], questions: [], risks: [], accepted: [], at: 1_800_000_000_000 }
    await pane.press({ key: 'issue-21' })
    expect(await call($, 'mcp__pipeline__pane', { pane: 'issues' })).toMatch(/#21 Quench answers 404 for an unknown beacon planned · 0\/1 done[\s\S]*\[c Open its plan\]/)
    await ends($, 'planner-1', 'No plan.')
    await pane.press({ key: 'planner' })
    await call($, 'mcp__pipeline__pump')
    expect(world.spawned).toHaveLength(1)
    expect(await call($, 'mcp__pipeline__pane', { pane: 'issues' })).toMatch(new RegExp(`A plan of github:${REPO}#21 is kept from \\d{4}-\\d\\d-\\d\\d \\(0/1 done\\): shown in the pane\\.`))
  })

  test('keeps where an issue stands in a narrow pane, its title cut and whole once opened', async ($, on) => {
    machine(on)
    await $.session.start({ source: 'startup', cwd: CWD } as never)
    await $.command.run({ command: 'issues', args: '' } as never)

    const pane = await $.ui.mount({ plugin: 'pipeline', surface: 'terminal', component: 'Pane', props: { bodyColumns: 40 } as never, requestId: 'issues' })
    await pane.press({ key: 'issue-12' })
    await pane.press({ key: 'planner' })

    const drawn = await call($, 'mcp__pipeline__pane', { pane: 'issues' })
    // Each row fits the pane: the title gives way, where the issue stands does not, and no label crowds it out
    expect(drawn).toContain('40 columns wide')
    const row = /\[(▸ #12 [^\]]*)\]/.exec(drawn)?.[1] ?? ''
    expect(row).toMatch(/^▸ #12 Beacons answ.*… asked of the planner$/)
    expect(row.length).toBeLessThanOrEqual(40)
    expect(row).not.toContain('ready-for-agent')
    // Opened, the title is said whole, and the labels with it
    expect(drawn).toMatch(/#12 Beacons answer how long they have burned\n\s+by quent · updated 2026-10-14\n\s+\[ready-for-agent\]/)
  })

  test('says what the forge said when the issues cannot be listed, and lists none', async ($, on) => {
    const world = machine(on)
    world.list = ''
    await $.session.start({ source: 'startup', cwd: CWD } as never)

    expect((await $.command.run({ command: 'issues', args: '' } as never)).text).toBe(`gh could not list the issues of ${REPO}: not found`)
    await $.ui.mount({ plugin: 'pipeline', surface: 'terminal', component: 'Pane', props: { bodyColumns: 120 } as never, requestId: 'issues' })
    expect(await call($, 'mcp__pipeline__pane', { pane: 'issues' })).toMatch(/not read[\s\S]*gh could not list the issues/)
  })
})
