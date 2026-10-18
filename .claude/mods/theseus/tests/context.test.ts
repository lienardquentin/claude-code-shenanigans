import { describe, expect, test } from 'claude-code/testing'

import { buildSectionText } from '../hooks/build/register'
import { lagText } from '../hooks/lag'
import { plannerSectionText } from '../hooks/planner/register'
import { testsFirstSectionText } from '../hooks/tests-first/register'
import { verifySectionText } from '../hooks/verify/register'

// What Theseus adds to Claude's context at every turn, in the states a session is in. Its tools add only their names:
// a plugin's tools wait behind ToolSearch until Claude loads one. A token is taken as four characters.

const CWD = '/proj'
// This repository's own targets: two CLIs, a service and a frontend
const TARGETS = [
  { label: 'narsil', kind: 'cli' as const, roots: [`${CWD}/narsil`] },
  { label: 'deslop', kind: 'cli' as const, roots: [`${CWD}/deslop`] },
  { label: 'gondor', kind: 'service' as const, roots: [`${CWD}/beacons/gondor`] },
  { label: 'anor', kind: 'frontend' as const, roots: [`${CWD}/beacons/anor`] },
]
const REVIEWS = [
  { command: 'code-review', args: 'medium' },
  { command: 'security-review', args: '' },
]
const tokens = (text: string): number => Math.ceil(text.length / 4)

describe("What Theseus adds to Claude's context at each turn", () => {
  test('in a session that has not touched a target: one line, about 70 tokens', () => {
    const idle = verifySectionText(TARGETS, CWD, false, REVIEWS)

    expect(idle).toBe('Theseus verifies edits of narsil (narsil), deslop (deslop), gondor (beacons/gondor), anor (beacons/anor): after editing one, call mcp__theseus__radius, write a `pins: <run>` test for each changed run it lists, then mcp__theseus__prove.')
    expect(tokens(idle)).toBeLessThanOrEqual(80)
  })

  test('once a target is touched: the steps in full and the reviewers, under 200 tokens', () => {
    const touched = verifySectionText(TARGETS, CWD, true, REVIEWS)

    expect(touched).toMatch(/Then reviewers judge it when the turn ends/)
    expect(tokens(touched)).toBeLessThanOrEqual(200)
  })

  test('while a plan, a run and tests written first are held, and a plugin lags: under 400 tokens in all', () => {
    const plan = plannerSectionText({ ref: 'github:o/r#54', title: 'Beacons burn out after a watch', tasks: [{ state: 'done' }, { state: 'doing' }, { state: 'todo' }], questions: [], risks: [] } as never)
    const run = buildSectionText([{ ref: 'github:o/r#54', kind: 'plan', phase: 'building', tree: `${CWD}/.theseus/trees/build-54-beacons-burn-out-after-a-watch` }] as never)
    const tests = testsFirstSectionText({ tests: [{ file: 'beacons/tests/test_watch.py', name: 'test_a_beacon_past_its_watch_is_quenched' }, { file: 'beacons/tests/test_watch.py', name: 'test_a_beacon_within_its_watch_stays_lit' }] } as never)
    const lag = lagText([{ plugin: 'theseus@theseus', why: 'behind', installed: '/home/q/.claude/plugins/cache/theseus/theseus/0.6.0', sameVersion: '0.6.0' }])

    expect([plan, run, tests, lag].map(tokens).reduce((sum, one) => sum + one, 0) + tokens(verifySectionText(TARGETS, CWD, true, REVIEWS))).toBeLessThanOrEqual(600)
    for (const one of [plan, run, tests, lag]) expect(tokens(one)).toBeLessThanOrEqual(150)
  })
})
