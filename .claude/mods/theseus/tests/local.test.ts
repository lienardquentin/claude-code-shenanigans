import { describe, expect, test } from 'claude-code/testing'

import { local, localIssueOf, parseIssueRef, refOf, refText } from '../core/forge'
import { COMMAND_TIMEOUT_MS, checksVerdict, runCommands } from '../core/verification'
import type { Ran } from '../core/forge'

/** A shell over files kept in memory, as the local forge reads and writes them. */
const shellOver = (files: Record<string, string>) => {
  const ran: string[][] = []

  return {
    ran,
    run: async (argv: readonly string[]): Promise<Ran> => {
      ran.push([...argv])
      if (argv[0] === 'cat') return argv[1] !== undefined && argv[1] in files ? { exitCode: 0, stdout: files[argv[1]] ?? '', stderr: '' } : { exitCode: 1, stdout: '', stderr: 'No such file' }
      if (argv[0] === 'sh' && String(argv[2]).startsWith('for f in')) return { exitCode: 0, stdout: Object.entries(files).map(([path, text]) => `${path}\0${text}\0`).join(''), stderr: '' }
      if (argv[0] === 'sh') {
        const number = Object.keys(files).length + 1
        files[`.theseus/issues/${number}.md`] = `# ${argv[4] ?? ''}\n\n${argv[5] ?? ''}\n`

        return { exitCode: 0, stdout: `${number}\n`, stderr: '' }
      }

      return { exitCode: 127, stdout: '', stderr: `${argv[0] ?? ''}: not found` }
    },
  }
}

describe('a local issue', () => {
  test('is named local:3, local:#3 or local:issues#3, and written back as local:issues#3', () => {
    for (const named of ['local:3', 'local:#3', 'local:issues#3']) expect(parseIssueRef(named)).toEqual({ forge: 'local', server: 'local', repo: 'issues', number: 3 })
    expect(refText({ forge: 'local', server: 'local', repo: 'issues', number: 3 })).toBe('local:issues#3')
    expect(refOf('local:issues#3')).toEqual({ forge: 'local', server: 'local', repo: 'issues', number: 3 })
    // A repository with no remote keeps its issues as files: a bare number names one
    expect(parseIssueRef('#3')).toEqual({ forge: 'local', server: 'local', repo: 'issues', number: 3 })
    expect(parseIssueRef('3', { forge: 'github', server: 'github.com', repo: 'o/r' })).toEqual({ forge: 'github', server: 'github.com', repo: 'o/r', number: 3 })
  })

  test('is read from its file: its first line the title, the rest the body, always the person\'s own', async () => {
    const forge = local(shellOver({ '.theseus/issues/3.md': '# Beacons burn out\n\nA lit beacon goes out after its watch.\n\n## Verification\npytest -q\n' }))

    expect(await forge.readIssue({ forge: 'local', server: 'local', repo: 'issues', number: 3 })).toEqual({
      title: 'Beacons burn out',
      body: 'A lit beacon goes out after its watch.\n\n## Verification\npytest -q',
      url: '.theseus/issues/3.md',
      state: 'open',
      labels: [],
      author: 'you',
      isOutside: false,
      comments: [],
      leftOut: 0,
    })
    expect(await forge.readIssue({ forge: 'local', server: 'local', repo: 'issues', number: 4 })).toBe('No local issue 4: write it in .theseus/issues/4.md, its title on the first line.')
    expect(localIssueOf(5, '\n\nPlain title\nbody')).toMatchObject({ title: 'Plain title', body: 'body' })
  })

  test('is listed, the latest first, and opened as the next number', async () => {
    const files = { '.theseus/issues/1.md': '# One\n', '.theseus/issues/2.md': '# Two\nbody\n' }
    const forge = local(shellOver(files))

    expect((await forge.listIssues({ forge: 'local', server: 'local', repo: 'issues' })) as { number: number; title: string }[]).toMatchObject([
      { number: 2, title: 'Two' },
      { number: 1, title: 'One' },
    ])
    expect(await forge.openIssue({ forge: 'local', server: 'local', repo: 'issues' }, 'Three', 'Why.')).toEqual({ url: '.theseus/issues/3.md', number: 3 })
  })

  test('has no pull request to open: it says to push the branch instead', async () => {
    const forge = local(shellOver({}))

    expect(await forge.openRequest({ branch: 'build/3-beacons', base: 'main', title: 't', body: 'b' })).toBe('build/3-beacons is built and reviewed. Local issues have no forge to open a pull request on: push it and open one where the code is kept (git push -u origin build/3-beacons).')
    expect(await forge.mergedFrom('build/3-beacons')).toBe('')
  })
})

describe('a verification command', () => {
  test('is given no longer than the engine lets a command run, ten minutes, or it would be refused before it starts', async () => {
    const asked: number[] = []

    await runCommands({ run: async (_argv, options) => (asked.push(options?.timeoutMs ?? 0), { exitCode: 0, stdout: '', stderr: '' }) }, ['python3 -m unittest -q'])

    expect(asked).toEqual([COMMAND_TIMEOUT_MS])
    expect(COMMAND_TIMEOUT_MS).toBeLessThanOrEqual(600_000)
  })

  test('that could not be started proves nothing, and stops the run rather than send a builder back to mend the code', () => {
    expect(checksVerdict({ ok: false, command: 'python3 -m unittest', exitCode: -1, output: '$.process.run: timeoutMs is at most 600000' }, ['python3 -m unittest'])).toMatchObject({ verdict: 'unlooked', line: '`python3 -m unittest` could not be started: $.process.run: timeoutMs is at most 600000' })
    expect(checksVerdict({ ok: false, command: 'python3 -m unittest', exitCode: 1, output: 'FAILED' }, ['python3 -m unittest']).verdict).toBe('unsettled')
  })
})
