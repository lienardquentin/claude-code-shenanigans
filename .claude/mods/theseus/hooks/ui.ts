import type { EngineInterface } from 'claude-code'

import { RUNS_DIR, VIEWS_DIR } from '../core/events'
import { rootOf } from './flow'
import { reported } from './trouble'

// /theseus ui: the web view, served by a small Node server the session starts and ends with, on 127.0.0.1 alone and
// behind a token of the session's own; and a run's report, the same page with the run written into it.
// A helper that takes `$` is a function declaration: past an import, the engine follows `$` into no other kind.

type $ = EngineInterface

// How long the server may take to say where it listens
const LISTEN_MS = 10_000

/** The web view this session serves, once started. */
let served: { url: string } | undefined

/** A token no other page can guess: 24 random bytes, in hex. */
const tokenOf = (): string => [...crypto.getRandomValues(new Uint8Array(24))].map(byte => byte.toString(16).padStart(2, '0')).join('')

/** A run's file name, as its log and its views are named. */
const slugOf = (ref: string): string => ref.replace(/[^A-Za-z0-9._-]+/g, '-')

/** The page with a run's data written into it, as a script that runs before the page's own. */
export const reportPage = (page: string, file: string, data: { views: unknown[]; events: unknown[] }): string => {
  // `<` is written escaped, so no text of the run can close the script it is in
  const json = JSON.stringify({ file, data }).replaceAll('<', '\\u003c')
  const at = page.indexOf('<script')

  if (at < 0) throw new Error('the web view page holds no script: build it again (npm run build in the plugin\'s ui folder)')

  return `${page.slice(0, at)}<script>window.__THESEUS_REPORT__ = ${json}</script>\n${page.slice(at)}`
}

/** The JSON lines of a file, or none where it is not there. */
async function linesOf($: $, path: string): Promise<unknown[]> {
  if (!(await $.fs.exists(path))) return []

  return String(await $.fs.read(path))
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line) as unknown)
}

/** Starts the server for the session's life, and answers where it listens. */
async function start($: $): Promise<string> {
  const node = await $.process.run(['node', '--version'], { timeoutMs: 10_000 }).catch(() => ({ exitCode: -1, stdout: '' }))

  if (node.exitCode !== 0) return 'The web view needs Node.js 18 or later on the PATH: https://nodejs.org. /theseus doctor checks the rest.'

  const root = await rootOf($)
  const token = tokenOf()
  const server = $.process.spawn({ argv: ['node', `${$.plugin.root.replace(/\/+$/, '')}/ui/server.mjs`, '--root', root, '--token', token], cwd: root })
  const port = await new Promise<number>((resolve, reject) => {
    // A promise settled already is not moved by the clock's later reject
    $.clock.after(LISTEN_MS, () => reject(new Error(`the web view's server did not start within ${LISTEN_MS / 1000}s`)))

    // The loop is the server's life: it reads what the server says until it ends, with the session or the module
    void (async () => {
      let said = ''

      for await (const piece of server) {
        said += piece.text
        const listening = /listening (\d+)/.exec(said)

        if (listening !== null) resolve(Number(listening[1]))
      }
      served = undefined
      reject(new Error(`the web view's server ended: ${said.trim().split('\n').at(-1) ?? 'it said nothing'}`))
    })().catch(reported($, 'the web view'))
  })

  served = { url: `http://127.0.0.1:${port}/?token=${token}` }

  return served.url
}

/** `/theseus ui [report <run>]`: the web view's address, starting its server; or a run's report, written as a file. */
export async function uiCommand($: $, args: string): Promise<{ text: string }> {
  const [verb = '', ...rest] = args.trim().split(/\s+/).filter(word => word !== '')

  if (verb === 'report') {
    const named = rest.join(' ')
    const root = await rootOf($)
    const listed = (await $.fs.exists(`${root}/${VIEWS_DIR}`)) ? (await $.fs.list(`${root}/${VIEWS_DIR}`)).map(one => one.name.replace(/\.jsonl$/, '')) : []
    const file = listed.find(one => named !== '' && (one === slugOf(named) || one.endsWith(slugOf(named)))) ?? (named === '' && listed.length === 1 ? listed[0] : undefined)

    if (file === undefined) return { text: named === '' ? `Name the run: ${listed.join(', ') || 'no run has a view yet'}.` : `No run named ${named} has a view: ${listed.join(', ') || 'none has'}.` }

    const page = String(await $.fs.read(`${$.plugin.root.replace(/\/+$/, '')}/ui/dist/index.html`))
    const path = `${root}/.theseus/reports/${file}.html`

    await $.fs.write(path, reportPage(page, file, { views: await linesOf($, `${root}/${VIEWS_DIR}/${file}.jsonl`), events: await linesOf($, `${root}/${RUNS_DIR}/${file}.jsonl`) }))

    return { text: `Wrote the report of ${file} to ${path}: one page, nothing in it fetched from anywhere, that plays the run again. Attach it to the pull request if you want reviewers to see how the change was built.` }
  }

  if (verb !== '') return { text: `/theseus ui does not know ${verb}. It takes nothing (the web view's address) or report <run>.` }
  if (served !== undefined) return { text: `The web view: ${served.url}` }

  const url = await start($)

  return { text: url.startsWith('http') ? `The web view: ${url}\nIt lives as long as this session, and answers this machine alone.` : url }
}
