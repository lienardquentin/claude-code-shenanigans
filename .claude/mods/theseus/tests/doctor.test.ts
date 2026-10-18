import { describe, expect, test } from 'claude-code/testing'

import { blocking, doctorText, examine, programOf, programsOf } from '../core/doctor'
import type { DoctorPorts, Project } from '../core/doctor'
import type { Target } from '../types'

const ROOT = '/proj'

/** A target as .claude/verify names it, with nothing set but what a test gives. */
const target = (given: Partial<Target> & Pick<Target, 'label' | 'kind'>): Target => ({ roots: [], tests: [], test: '', app: '', python: '', env: {}, masks: [], requests: [], live: null, db: null, ready: null, affected: '', checks: [], audit: '', ...given })

/** A machine: the programs on its PATH, and what some commands answer; anything else answers 0. */
const machine = (onPath: string[], answers: Record<string, { exitCode: number; stdout?: string; stderr?: string }> = {}, files: string[] = []): DoctorPorts & { ran: string[] } => {
  const ran: string[] = []

  return {
    ran,
    run: async argv => {
      const line = argv.join(' ')
      ran.push(line)
      if (line.startsWith('sh -c command -v')) return { exitCode: onPath.includes(argv.at(-1) ?? '') ? 0 : 1, stdout: '', stderr: '' }

      return { stdout: '', stderr: '', ...(answers[line] ?? { exitCode: onPath.includes(argv[0] ?? '') ? 0 : 127 }) }
    },
    exists: async path => files.includes(path),
  }
}

const project = (given: Partial<Project> = {}): Project => ({ root: ROOT, hasConfig: true, targets: [], configErrors: [], installed: [], lags: [], ...given })
const ORIGIN = { [`git -C ${ROOT} remote get-url origin`]: { exitCode: 0, stdout: 'git@github.com:o/r.git\n' }, [`git -C ${ROOT} rev-parse --show-toplevel`]: { exitCode: 0, stdout: `${ROOT}\n` } }

describe('the doctor', () => {
  test('reads the program a command starts, past the variables it sets', () => {
    expect(programOf('KAFKA_BROKERS= uv run pytest')).toBe('uv')
    expect(programOf('  cargo test --manifest-path x')).toBe('cargo')
    expect([...programsOf([target({ label: 'narsil', kind: 'cli', test: 'cargo test', checks: ['cargo clippy && cargo fmt --check', 'sh scripts/deslop.sh narsil {against}'] })])]).toEqual([
      ['cargo', ['narsil.test', 'narsil.check']],
      ['sh', ['narsil.check']],
    ])
  })

  test('finds nothing missing on a machine that has all a project needs, and says so', async () => {
    const p = machine(['git', 'gh', 'python3', 'cargo'], ORIGIN, [`${ROOT}/.claude/recorder`])
    const checks = await examine(p, project({ targets: [target({ label: 'narsil', kind: 'cli', test: 'cargo test' })], installed: ['recorder@theseus'] }))

    expect(blocking(checks)).toEqual([])
    expect(doctorText(checks)).toMatch(/^Theseus has what it needs here\.\n\n✓ git: [\s\S]*✓ gh sign-in: github\.com[\s\S]*✓ cargo: for narsil\.test\n✓ recorder: installed/)
  })

  test('names each miss with the one step that fixes it, and stops a run on it', async () => {
    const p = machine(['git', 'gh', 'docker'], { ...ORIGIN, 'gh auth status --hostname github.com': { exitCode: 1, stderr: 'You are not logged into any GitHub hosts.\n' }, 'docker info --format {{.ServerVersion}}': { exitCode: 1, stderr: 'Cannot connect to the Docker daemon\n' } })
    const checks = await examine(p, project({ targets: [target({ label: 'gondor', kind: 'service', affected: 'uv run pytest', db: { image: 'postgres:18-alpine', env: 'DATABASE_URL', setup: '' } as never })] }))
    const text = doctorText(checks)

    expect(blocking(checks).map(check => check.name)).toEqual(['gh sign-in', 'python3', 'uv', 'docker'])
    expect(text).toMatch(/^Theseus is missing 4 things it needs here: a run will not start until they are fixed\./)
    expect(text).toContain('✗ gh sign-in: You are not logged into any GitHub hosts.\n    gh auth login --hostname github.com')
    expect(text).toContain('✗ uv: not on the PATH, needed by gondor.affected\n    Install uv, or name another command in .claude/verify')
    expect(text).toContain('✗ docker: Cannot connect to the Docker daemon\n    Start Docker')
  })

  test('checks only what the project needs: no docker, kubectl or recorder for a project with no target', async () => {
    const p = machine(['git', 'gh'], ORIGIN)
    const checks = await examine(p, project({ hasConfig: false }))

    expect(p.ran.some(line => /docker|kubectl|python3/.test(line))).toBe(false)
    expect(checks.find(check => check.name === '.claude/verify')).toMatchObject({ state: 'warn' })
    expect(blocking(checks)).toEqual([])
  })

  test('warns where there is no origin, and asks the forge nothing', async () => {
    const p = machine(['git', 'gh'], { [`git -C ${ROOT} rev-parse --show-toplevel`]: { exitCode: 0, stdout: `${ROOT}\n` }, [`git -C ${ROOT} remote get-url origin`]: { exitCode: 2, stderr: 'error: No such remote' } })
    const checks = await examine(p, project({ hasConfig: false }))

    expect(checks.find(check => check.name === 'origin remote')).toMatchObject({ state: 'warn' })
    expect(p.ran.some(line => line.startsWith('gh '))).toBe(false)
  })

  test('takes a GitLab origin to glab, signed in to its own host', async () => {
    const p = machine(['git', 'glab'], { [`git -C ${ROOT} rev-parse --show-toplevel`]: { exitCode: 0, stdout: `${ROOT}\n` }, [`git -C ${ROOT} remote get-url origin`]: { exitCode: 0, stdout: 'https://gitlab.example.com/g/p.git\n' } })

    await examine(p, project({ hasConfig: false }))

    expect(p.ran).toContain('glab auth status --hostname gitlab.example.com')
  })

  test('stops at once outside a git repository, saying where to start', async () => {
    const checks = await examine(machine(['git'], { [`git -C ${ROOT} rev-parse --show-toplevel`]: { exitCode: 128, stderr: 'fatal: not a git repository' } }), project())

    expect(blocking(checks)).toEqual([{ name: 'git repository', state: 'broken', found: '/proj is not in one', fix: 'Start Claude Code inside the git repository Theseus works on' }])
  })
})
