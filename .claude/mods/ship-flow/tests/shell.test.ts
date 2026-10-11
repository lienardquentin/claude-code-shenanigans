import { describe, expect, test } from 'claude-code/testing'

import { asWritten, isAllowedShell, isWindowsPath, shellArgv } from '../hooks/shell'
import { verificationOf } from '../hooks/spec'

const VERIFICATION = ['npm test', 'npm run typecheck && npm run lint']

describe('the implementer\'s shell', () => {
  test('runs a verification command exactly as the spec writes it, joins and all', () => {
    expect(isAllowedShell('npm test', VERIFICATION)).toBe(true)
    expect(isAllowedShell('  npm run typecheck && npm run lint ', VERIFICATION)).toBe(true)
    expect(isAllowedShell('npm test -- --watch', VERIFICATION)).toBe(false)
  })

  test('runs the git commands that read the repo and move, remove and stage files', () => {
    for (const command of ['git status', 'git diff HEAD~1', 'git log --oneline -5', 'git rm old.ts', 'git mv a.ts b.ts', 'git add -A']) {
      expect(isAllowedShell(command, VERIFICATION)).toBe(true)
    }
  })

  test('runs no git command that commits, discards or reaches a remote', () => {
    for (const command of ['git commit -m x', 'git push', 'git reset --hard', 'git clean -fd', 'git checkout .', 'git']) {
      expect(isAllowedShell(command, VERIFICATION)).toBe(false)
    }
  })

  test('runs nothing joined to an allowed command', () => {
    for (const command of ['git status; rm -rf .', 'git log | sh', 'git show $(cat key)', 'git diff > out', 'git status\nrm x']) {
      expect(isAllowedShell(command, VERIFICATION)).toBe(false)
    }
  })

  test('reads a command without what the session\'s sandbox put in front of it, and nothing else in front of it', () => {
    const sandboxed =
      "export HTTP_PROXY='http://1-a:x@127.0.0.1:57577' HTTPS_PROXY='http://1-a:x@127.0.0.1:57577' no_proxy='localhost,127.0.0.1,::1'; curl() { command curl --suppress-connect-headers \"$@\"; }\n"

    expect(asWritten(`${sandboxed}git rm -f old.ts`)).toBe('git rm -f old.ts')
    expect(isAllowedShell(`${sandboxed}git rm -f old.ts`, VERIFICATION)).toBe(true)
    expect(isAllowedShell(`${sandboxed}npm test`, VERIFICATION)).toBe(true)
    expect(isAllowedShell(`${sandboxed}git push`, VERIFICATION)).toBe(false)
    expect(isAllowedShell(`${sandboxed}git status; rm -rf .`, VERIFICATION)).toBe(false)
    expect(isAllowedShell("export PATH='/tmp'; curl() { command curl --suppress-connect-headers \"$@\"; }\ngit status", VERIFICATION)).toBe(false)
    expect(isAllowedShell('git -C /elsewhere status', VERIFICATION)).toBe(false)
  })

  test('runs nothing else', () => {
    expect(isAllowedShell('ls', VERIFICATION)).toBe(false)
    expect(isAllowedShell('', VERIFICATION)).toBe(false)
  })
})

describe('a verification command', () => {
  test('is handed to the shell of the machine it runs on', () => {
    expect(isWindowsPath('C:\\Users\\dev\\repo')).toBe(true)
    expect(isWindowsPath('/home/dev/repo')).toBe(false)
    expect(shellArgv('npm test', true)).toEqual(['cmd', '/d', '/s', '/c', 'npm test'])
    expect(shellArgv('npm test', false)).toEqual(['sh', '-c', 'npm test'])
  })

  test('is read from the spec\'s Verification section, fenced or listed, and from no other section', () => {
    expect(verificationOf('# Spec\n\n## Verification\n\n```\nnpm test\nnpm run typecheck\n```\n\n## Out of Scope\n\n- npm publish\n')).toEqual([
      'npm test',
      'npm run typecheck',
    ])
    expect(verificationOf('## Verification\n\n- `npm test`\n- npm run lint\n')).toEqual(['npm test', 'npm run lint'])
    expect(verificationOf('# Spec\n\n## Solution\n\n```\nnpm test\n```\n')).toEqual([])
  })
})
