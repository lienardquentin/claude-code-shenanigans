import { describe, expect, test } from 'claude-code/testing'

import { rootOf, underRoot } from '../hooks/root'

const holding = (...dirs: string[]) => async (path: string) => dirs.some(dir => `${dir}/.git` === path)

describe('the repo root of a session', () => {
  test('is the working directory when it holds .git', async () => {
    expect(await rootOf('C:\\Users\\dev\\repo', holding('C:\\Users\\dev\\repo'))).toBe('C:\\Users\\dev\\repo')
  })

  test('is the nearest folder above the working directory that holds .git', async () => {
    expect(await rootOf('/home/dev/repo/.claude/mods/ship-flow', holding('/home/dev/repo'))).toBe('/home/dev/repo')
    expect(await rootOf('C:\\Users\\dev\\repo\\.claude\\mods', holding('C:\\Users\\dev\\repo'))).toBe('C:\\Users\\dev\\repo')
  })

  test('is undefined when no folder above holds .git', async () => {
    expect(await rootOf('/home/dev/repo', holding())).toBeUndefined()
  })
})

describe('a path the run keeps', () => {
  test('goes under the root when it is relative, and stays as it is when absolute or when there is no root', () => {
    expect(underRoot('/home/dev/repo', '.scratch/checkout/run.json')).toBe('/home/dev/repo/.scratch/checkout/run.json')
    expect(underRoot('/home/dev/repo', '/tmp/x')).toBe('/tmp/x')
    expect(underRoot('/home/dev/repo', 'C:\\x\\y')).toBe('C:\\x\\y')
    expect(underRoot(undefined, '.scratch')).toBe('.scratch')
  })
})
