import { describe, expect, test } from 'claude-code/testing'

import { carriedOf, carryFolder } from '../hooks/stores'

describe("the pipeline's store", () => {
  test('gives up the plans and runs Theseus does not hold yet, and nothing else', () => {
    const kept = JSON.stringify({ 'plan:github:o/r#34': { ref: 'github:o/r#34' }, 'plan:github:o/r#35': { ref: 'github:o/r#35' }, 'run:github:o/r#37': { phase: 'submitted' }, other: 1 })

    expect(carriedOf(kept, ['plan:github:o/r#35'])).toEqual([
      ['plan:github:o/r#34', { ref: 'github:o/r#34' }],
      ['run:github:o/r#37', { phase: 'submitted' }],
    ])
  })

  test('points the paths a run keeps into .theseus/, where its folder is moved', () => {
    const kept = JSON.stringify({ 'run:github:o/r#37': { tree: '/proj/.pipeline/trees/build-37-x', root: '/proj', note: 'a .pipeline word stays' } })

    expect(carriedOf(kept, [])).toEqual([['run:github:o/r#37', { tree: '/proj/.theseus/trees/build-37-x', root: '/proj', note: 'a .pipeline word stays' }]])
  })

  test('is said to be no store when it does not read as one, rather than taken for an empty one', () => {
    for (const text of ['', 'not json', '[1, 2]', 'null']) expect(carriedOf(text, [])).toBeUndefined()
    expect(carriedOf('{}', [])).toEqual([])
  })
})

describe("the pipeline's folder", () => {
  /** A fake engine: the folders that exist, and the commands run, each answered as `answers` says. */
  const engineOf = (exists: string[], answers: Record<string, { exitCode: number; stdout?: string; stderr?: string }> = {}) => {
    const ran: string[] = []
    const $ = {
      fs: { exists: async (path: string) => exists.includes(path) },
      process: {
        run: async (argv: string[]) => {
          const line = argv.join(' ')
          ran.push(line)

          return { stdout: '', stderr: '', ...(line === 'git rev-parse --show-toplevel' ? { exitCode: 0, stdout: '/proj\n' } : (answers[line] ?? { exitCode: 0 })) }
        },
      },
      session: { cwd: async () => '/proj' },
    }

    return { $: $ as never, ran }
  }

  test('is moved to .theseus/, and the worktrees in it repaired at their new paths', async () => {
    const { $, ran } = engineOf(['/proj/.pipeline'], {
      'git worktree list --porcelain': { exitCode: 0, stdout: 'worktree /proj\nHEAD 1\n\nworktree /proj/.pipeline/trees/build-37-x\nHEAD 2\n\nworktree /proj/.recorder/trees/narsil\nHEAD 3\n' },
    })

    await carryFolder($)

    expect(ran).toContain('mv /proj/.pipeline /proj/.theseus')
    expect(ran).toContain('git worktree repair /proj/.theseus/trees/build-37-x')
  })

  test('is left alone once .theseus/ is there, or when there is none', async () => {
    for (const exists of [['/proj/.pipeline', '/proj/.theseus'], []]) {
      const { $, ran } = engineOf(exists)

      await carryFolder($)

      expect(ran.filter(line => line.startsWith('mv '))).toEqual([])
    }
  })

  test('that cannot be moved fails, saying why', async () => {
    const { $ } = engineOf(['/proj/.pipeline'], { 'mv /proj/.pipeline /proj/.theseus': { exitCode: 1, stderr: 'Permission denied\n' } })

    await expect(carryFolder($)).rejects.toThrow('.pipeline/ could not be moved to .theseus/: Permission denied')
  })
})
