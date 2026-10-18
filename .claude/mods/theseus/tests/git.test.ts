import { describe, expect, test } from 'claude-code/testing'

import { applyAfresh, commitTask, landLane, leakOf } from '../core/git'
import type { Ran, Shell } from '../core/forge'

const TREE = '/proj/.theseus/trees/build-12-x'

const ok = (stdout = ''): Ran => ({ exitCode: 0, stdout, stderr: '' })
const failed = (stderr: string): Ran => ({ exitCode: 1, stdout: '', stderr })

/** A shell that answers each git command by the first rule its words start with, and keeps every command it ran. */
const shell = (rules: [string, Ran][]) => {
  const ran: string[] = []
  const fake: Shell = {
    run: async argv => {
      const line = argv.join(' ')

      ran.push(line)

      return rules.find(([start]) => line.startsWith(start))?.[1] ?? ok()
    },
  }

  return { fake, ran }
}

const asked = { tree: TREE, taskId: 2, message: '#12: Keep when a beacon is lit', gitRuns: '' }

describe("a task's commit", () => {
  test('stages the change without the mods\' folders, and answers the commit it made', async () => {
    const { fake, ran } = shell([
      ['git status --porcelain -- .', ok(' M beacons/gondor/app.py')],
      ['git rev-parse --path-format=absolute --git-path hooks', ok('/proj/.git/hooks')],
      ['git diff --cached', ok('+++ b/beacons/gondor/app.py\n+    lit = 0')],
      ['git rev-parse HEAD', ok('abcdef1234')],
    ])

    expect(await commitTask(fake, asked)).toEqual({ kind: 'committed', sha: 'abcdef1234' })
    expect(ran.find(line => line.startsWith('git add'))).toBe("git add -A -- . :(exclude).theseus :(exclude).pipeline :(exclude).recorder")
    expect(ran).toContain('git commit -m #12: Keep when a beacon is lit')
  })

  test('is nothing where the tree holds no change', async () => {
    const { fake, ran } = shell([['git status', ok('')]])

    expect(await commitTask(fake, asked)).toEqual({ kind: 'clean' })
    expect(ran).toHaveLength(1)
  })

  test("is refused once what git runs on a commit changed since the run started, or the change touches its hooks", async () => {
    const changed = shell([
      ['git status', ok(' M a.py')],
      ['git config', ok('file:.git/config core.hookspath evil')],
    ])

    expect(await commitTask(changed.fake, asked)).toMatchObject({ kind: 'refused', why: expect.stringMatching(/^git's config of what a commit runs/) })

    const hooked = shell([
      ['git status --porcelain -- .', ok(' M a.py')],
      ['git rev-parse --path-format=absolute --git-path hooks', ok(`${TREE}/.githooks`)],
      [`git status --porcelain -- ${TREE}/.githooks`, ok('?? .githooks/pre-commit')],
    ])

    expect(await commitTask(hooked.fake, asked)).toMatchObject({ kind: 'refused', why: expect.stringMatching(/touches the git hooks its own commit would run/) })
    expect(hooked.ran.some(line => line.startsWith('git commit'))).toBe(false)
  })

  test('unstages and refuses what looks like a secret, and says git\'s refusal to commit', async () => {
    const leaky = shell([
      ['git status', ok(' M settings.py')],
      ['git rev-parse --path-format=absolute --git-path hooks', ok('/proj/.git/hooks')],
      ['git diff --cached', ok('+++ b/settings.py\n+KEY = "AKIAABCDEFGHIJKLMNOP"')],
    ])

    expect(await commitTask(leaky.fake, asked)).toEqual({ kind: 'refused', why: `Task 2's change adds what looks like a secret (settings.py: an AWS access key), so it is not committed: take it out of ${TREE}, then put the task up for verification again.` })
    expect(leaky.ran).toContain('git reset -q')

    const refused = shell([
      ['git status', ok(' M a.py')],
      ['git rev-parse --path-format=absolute --git-path hooks', ok('/proj/.git/hooks')],
      ['git commit', failed('fatal: unable to write new index file')],
    ])

    expect(await commitTask(refused.fake, asked)).toEqual({ kind: 'refused', why: 'Task 2 could not be committed: fatal: unable to write new index file' })
  })
})

describe("a lane's landing", () => {
  const landing = { taskId: 3, sha: 'lane123', branch: 'build/12-x', laneTree: `${TREE}--task-3`, questTree: TREE }

  test("fast-forwards its run's branch where nothing landed since it started", async () => {
    const lane = shell([
      ['git rev-parse refs/heads/build/12-x', ok('tip456')],
      ['git merge-base HEAD tip456', ok('tip456')],
    ])
    const quest = shell([['git rev-parse HEAD', ok('lane123')]])

    expect(await landLane(lane.fake, quest.fake, landing)).toEqual({ kind: 'landed', sha: 'lane123' })
    expect(quest.ran).toEqual(['git merge --ff-only lane123', 'git rev-parse HEAD'])
  })

  test('is taken onto what landed since, and left uncommitted there to be proved again', async () => {
    const lane = shell([
      ['git rev-parse refs/heads/build/12-x', ok('tip789')],
      ['git merge-base HEAD tip789', ok('tip456')],
    ])

    expect(await landLane(lane.fake, shell([]).fake, landing)).toEqual({ kind: 'rebased', onto: 'tip789' })
    expect(lane.ran.slice(-2)).toEqual(['git rebase tip789', 'git reset -q --soft HEAD~1'])
  })

  test('is found in conflict where the rebase stops, and stops where git cannot say where the branch stands', async () => {
    const conflicting = shell([
      ['git rev-parse', ok('tip789')],
      ['git merge-base', ok('tip456')],
      ['git rebase tip789', failed('CONFLICT (content): Merge conflict in a.py')],
    ])

    expect(await landLane(conflicting.fake, shell([]).fake, landing)).toEqual({ kind: 'conflicts', onto: 'tip789' })
    expect(await landLane(shell([['git rev-parse', failed('unknown revision')]]).fake, shell([]).fake, landing)).toEqual({ kind: 'stop', why: 'Task 3 cannot land: git could not say where build/12-x stands against the lane (unknown revision).' })
  })

  test('marks a task that changed nothing as landed with no commit', async () => {
    const quest = shell([])

    expect(await landLane(shell([['git rev-parse', ok('tip456')]]).fake, quest.fake, { ...landing, sha: '' })).toEqual({ kind: 'landed', sha: '' })
    expect(quest.ran).toEqual([])
  })
})

describe('a change applied afresh on what landed', () => {
  test('names the files in conflict, with no commit made and nothing left staged', async () => {
    const lane = shell([
      ['git cherry-pick --no-commit', failed('error: could not apply lane123')],
      ['git diff --name-only --diff-filter=U', ok('beacons/gondor/app.py\n')],
    ])

    expect(await applyAfresh(lane.fake, 'tip789', 'lane123')).toEqual({ kind: 'conflicts', files: ['beacons/gondor/app.py'] })
    expect(lane.ran).toEqual(['git rebase --abort', 'git reset -q --hard tip789', 'git cherry-pick --no-commit lane123', 'git diff --name-only --diff-filter=U', 'git cherry-pick --quit', 'git reset -q'])
  })

  test('applies after all where the rebase stopped on something else, and says why where nothing conflicts but it failed', async () => {
    expect(await applyAfresh(shell([]).fake, 'tip789', 'lane123')).toEqual({ kind: 'applies' })
    expect(await applyAfresh(shell([['git reset -q --hard', failed('fatal: bad object tip789')]]).fake, 'tip789', 'lane123')).toEqual({ kind: 'failed', why: 'fatal: bad object tip789' })
  })
})

describe('a branch about to leave the machine', () => {
  const quest = { kind: 'plan', branch: 'build/12-x', base: 'main' }

  test("is read for secrets in what it adds over origin's base, else the local one", async () => {
    const fetched = shell([['git diff', ok('+++ b/a.py\n+print(1)')]])

    expect(await leakOf(fetched.fake, quest)).toBeUndefined()
    expect(fetched.ran.at(-1)).toBe('git diff --no-color --no-ext-diff origin/main...HEAD')

    const local = shell([['git rev-parse --verify', failed('')], ['git diff', ok('')]])

    await leakOf(local.fake, quest)
    expect(local.ran.at(-1)).toBe('git diff --no-color --no-ext-diff main...HEAD')
  })

  test("stays where what it adds holds a secret, could not be read, or a review's branch is not on origin", async () => {
    expect(await leakOf(shell([['git diff', ok('+++ b/s.py\n+K = "AKIAABCDEFGHIJKLMNOP"')]]).fake, quest)).toBe('build/12-x adds what looks like a secret (s.py: an AWS access key), so it does not leave the machine: take it out of the branch\'s history, then push again.')
    expect(await leakOf(shell([['git diff', failed('fatal: bad revision')]]).fake, quest)).toBe('What build/12-x adds over origin/main could not be read for secrets: fatal: bad revision')
    expect(await leakOf(shell([['git rev-parse --verify', failed('')]]).fake, { ...quest, kind: 'review' })).toBe('origin/build/12-x is not known here, so what build/12-x adds cannot be read for secrets: fetch it, then push again.')
  })
})
