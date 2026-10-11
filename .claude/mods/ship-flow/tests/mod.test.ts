import { describe, expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

type On = Parameters<TestBody>[1]

const ticket = (number: string, title: string, fields: readonly string[]) =>
  [`# ${number}: ${title}`, '', '**What to build:** Something.', '', ...fields.flatMap(field => [field, ''])].join('\n')

// Stands for the engine's file system: the files of a repo by path, and the folders that hold them
const answerFiles = (on: On, files: Readonly<Record<string, string>>) => {
  const paths = Object.keys(files)
  const isDir = (path: string) => paths.some(file => file.startsWith(`${path}/`))

  // The engine hands a hook the path made absolute under the working directory, in the machine's own spelling
  const inRepo = (path: string) => path.replaceAll('\\', '/').replace(/^.*?(?=\.scratch(\/|$))/, '')

  on('fs.exists', (_, e) => ({ value: inRepo(e.path) in files || isDir(inRepo(e.path)) }) as never)
  on('fs.read', (_, e) => ({ value: files[inRepo(e.path)] }) as never)
  on('fs.list', (_, e) => {
    const dir = inRepo(e.path)
    const names = new Set(
      paths.filter(file => file.startsWith(`${dir}/`)).map(file => file.slice(dir.length + 1).split('/')[0] ?? ''),
    )

    return {
      value: Array.from(names, name => ({
        name,
        kind: isDir(`${dir}/${name}`) ? 'dir' : 'file',
        size: 0,
        mtimeMs: 0,
        isLink: false,
      })),
    } as never
  })
}

const status = async ($: Parameters<TestBody>[0]) =>
  (await $.command.run({ command: 'ship', args: 'status' } as never)).text ?? ''

describe('/ship status', () => {
  test('says there is no run, and how to start one, in a repo with no ticket folder', async ($, on) => {
    answerFiles(on, { 'README.md': '# A repo' })

    expect(await status($)).toMatch(/No run in this repo/)
    expect(await status($)).toMatch(/\/ship <idea \| #issue>/)
  })

  test('lists every ticket with its state and blockers, and says which can be taken now', async ($, on) => {
    answerFiles(on, {
      '.scratch/checkout/spec.md': '# Spec',
      '.scratch/checkout/issues/01-cart.md': ticket('01', 'A cart holds items', ['**Blocked by:** None', '**Status:** done']),
      '.scratch/checkout/issues/02-pay.md': ticket('02', 'A cart is paid', ['**Blocked by:** 01', '**Status:** ready', '**Model:** opus']),
      '.scratch/checkout/issues/03-receipt.md': ticket('03', 'A receipt is sent', ['**Blocked by:** 02', '**Status:** ready']),
      '.scratch/checkout/issues/04-tax.md': ticket('04', 'Tax is added', ['**Blocked by:** 01', '**Status:** too-large']),
    })

    expect((await status($)).split('\n')).toEqual([
      'checkout: 1 of 4 tickets done, 1 takeable now',
      '  01  done       A cart holds items',
      '  02  ready      A cart is paid      blocked by 01 · model opus · takeable now',
      '  03  ready      A receipt is sent   blocked by 02',
      '  04  too-large  Tax is added        blocked by 01 · too large for one context window: split it into smaller tickets',
    ])
  })

  test('reports a broken graph by ticket number with the reason, instead of the list', async ($, on) => {
    answerFiles(on, {
      '.scratch/checkout/issues/01-cart.md': ticket('01', 'A cart holds items', ['**Blocked by:** 02', '**Status:** ready']),
      '.scratch/checkout/issues/02-pay.md': ticket('02', 'A cart is paid', ['**Blocked by:** 01, 07', '**Status:** ready']),
      '.scratch/checkout/issues/03-receipt.md': ticket('03', 'A receipt is sent', ['**Blocked by:** None']),
    })

    expect((await status($)).split('\n')).toEqual([
      'checkout: the ticket folder cannot be run',
      '  01 is in a cycle: 01 → 02 → 01',
      '  02 is blocked by 07, which does not exist',
      '  02 is in a cycle: 01 → 02 → 01',
      '  03 has no Status line',
    ])
  })

  test('shows each feature of a repo that has several, and skips a folder with no tickets folder', async ($, on) => {
    answerFiles(on, {
      '.scratch/notes/ideas.md': '# Not a run',
      '.scratch/search/issues/01-index.md': ticket('01', 'Pages are indexed', ['**Blocked by:** None', '**Status:** ready']),
      '.scratch/checkout/issues/01-cart.md': ticket('01', 'A cart holds items', ['**Blocked by:** None', '**Status:** blocked']),
    })

    expect((await status($)).split('\n')).toEqual([
      'checkout: 0 of 1 tickets done, 0 takeable now',
      '  01  blocked  A cart holds items  fix its ticket file, set it back to ready',
      '',
      'search: 0 of 1 tickets done, 1 takeable now',
      '  01  ready  Pages are indexed  takeable now',
    ])
  })

  test('says so when the ticket folders cannot be read', async ($, on) => {
    on('fs.exists', () => ({ value: true }) as never)
    on('fs.list', () => {
      throw new Error('EACCES')
    })

    expect(await status($)).toMatch(/could not read or write the run's files under \.scratch/)
  })

  test('any other argument answers with how the command is used', async $ => {
    expect((await $.command.run({ command: 'ship', args: '' } as never)).text).toMatch(/^Usage:/)
  })
})
