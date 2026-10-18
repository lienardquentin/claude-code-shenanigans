#!/usr/bin/env node
// The web view's server: serves the built page, the runs Theseus keeps in a project's .theseus/ folder, a stream of
// what changes in them, and the actions a person asks for, which it hands to the plugin by a file. It listens on
// 127.0.0.1 alone, answers no API call without the session's token, and reaches nothing beyond the project's folder.
// Plain Node, no dependency: the plugin starts it with `node server.mjs --root <project> --token <token>`.
//
// On start it prints `listening <port>` on a line of its own, the port the system gave it.

import { createServer } from 'node:http'
import { appendFile, mkdir, readdir, readFile, stat } from 'node:fs/promises'
import { watch } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { timingSafeEqual } from 'node:crypto'

const ACTIONS = new Set(['next', 'commit', 'submit', 'halt', 'auto', 'abandon'])

/** The arguments it was started with: `--root`, `--token`, `--port`, `--page`. */
export const argsOf = argv => {
  const named = {}

  for (let at = 0; at < argv.length; at += 1) if (argv[at].startsWith('--')) named[argv[at].slice(2)] = argv[at + 1] ?? ''

  return named
}

/** Whether two tokens are the same, in a time that does not say how much of them is. */
export const isToken = (given, token) => {
  const one = Buffer.from(String(given ?? ''))
  const other = Buffer.from(token)

  return one.length === other.length && timingSafeEqual(one, other)
}

/** A file's lines as JSON, a line that does not read left out. */
const jsonLines = text =>
  text
    .split('\n')
    .filter(line => line.trim() !== '')
    .flatMap(line => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })

const readOr = async (path, fallback) => readFile(path, 'utf8').catch(() => fallback)

/** The server, on a project's folder, with its token and its page. */
export const serverOf = ({ root, token, page }) => {
  const theseus = join(root, '.theseus')
  const views = join(theseus, 'views')
  const runs = join(theseus, 'runs')
  const streams = new Set()

  /** The runs a project's views hold: each one's latest view, and its history of views for replay. */
  const runsNow = async () => {
    const names = await readdir(views).catch(() => [])
    const all = []

    for (const name of names.filter(one => one.endsWith('.jsonl'))) {
      const snapshots = jsonLines(await readOr(join(views, name), ''))
      const last = snapshots.at(-1)

      if (last !== undefined) all.push({ file: name.replace(/\.jsonl$/, ''), view: last })
    }

    return all.sort((one, other) => (other.view.lastAt ?? 0) - (one.view.lastAt ?? 0))
  }

  const send = (response, status, body, type = 'application/json') => {
    response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' })
    response.end(typeof body === 'string' ? body : JSON.stringify(body))
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')

    // The page holds no data: it asks for it with the token the address carries
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return send(response, 200, await readOr(page, '<!doctype html><p>The web view is not built: run npm run build in the plugin\'s ui folder.</p>'), 'text/html; charset=utf-8')
    }

    if (!url.pathname.startsWith('/api/')) return send(response, 404, { error: 'not found' })
    if (!isToken(request.headers['x-theseus-token'] ?? url.searchParams.get('token'), token)) return send(response, 403, { error: 'this address needs the token /theseus ui gave' })

    if (request.method === 'GET' && url.pathname === '/api/runs') return send(response, 200, { runs: await runsNow() })

    if (request.method === 'GET' && url.pathname === '/api/run') {
      const file = url.searchParams.get('file') ?? ''

      if (!/^[A-Za-z0-9._-]+$/.test(file)) return send(response, 400, { error: 'no such run' })

      return send(response, 200, { views: jsonLines(await readOr(join(views, `${file}.jsonl`), '')), events: jsonLines(await readOr(join(runs, `${file}.jsonl`), '')) })
    }

    if (request.method === 'GET' && url.pathname === '/api/stream') {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
      response.write(`event: runs\ndata: ${JSON.stringify(await runsNow())}\n\n`)
      streams.add(response)
      request.on('close', () => streams.delete(response))

      return undefined
    }

    if (request.method === 'POST' && url.pathname === '/api/action') {
      let body = ''

      for await (const piece of request) {
        body += piece
        if (body.length > 4096) return send(response, 413, { error: 'too large' })
      }

      let asked

      try {
        asked = JSON.parse(body)
      } catch {
        return send(response, 400, { error: 'not JSON' })
      }

      const known = (await runsNow()).some(one => one.view.ref === asked?.ref)

      if (!ACTIONS.has(asked?.action) || !known) return send(response, 400, { error: 'no such action on a run under way' })

      await mkdir(theseus, { recursive: true })
      await appendFile(join(theseus, 'requests.jsonl'), `${JSON.stringify({ ref: asked.ref, action: asked.action, at: Date.now() })}\n`)

      return send(response, 202, { asked: true })
    }

    return send(response, 404, { error: 'not found' })
  })

  // What changes under .theseus/views or .theseus/runs is sent on every stream, once the writes settle
  let pending
  const changed = () => {
    clearTimeout(pending)
    pending = setTimeout(async () => {
      const data = `event: runs\ndata: ${JSON.stringify(await runsNow())}\n\n`

      for (const stream of streams) stream.write(data)
    }, 120)
  }
  const watchers = []
  const watchFolder = async folder => {
    await mkdir(folder, { recursive: true })
    watchers.push(watch(folder, changed))
  }

  return {
    server,
    start: async (port = 0) => {
      await watchFolder(views)
      await watchFolder(runs)
      await new Promise(resolve => server.listen(port, '127.0.0.1', resolve))

      return server.address().port
    },
    stop: async () => {
      for (const watcher of watchers) watcher.close()
      for (const stream of streams) stream.end()
      await new Promise(resolve => server.close(resolve))
    },
  }
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]

if (isMain) {
  const args = argsOf(process.argv.slice(2))
  const page = args.page ?? join(dirname(fileURLToPath(import.meta.url)), 'dist', 'index.html')

  if (!args.root || !args.token || (await stat(args.root).catch(() => null)) === null) {
    process.stderr.write('usage: node server.mjs --root <project folder> --token <token> [--port <port>]\n')
    process.exit(2)
  }

  const { start } = serverOf({ root: args.root, token: args.token, page })
  const port = await start(Number(args.port ?? 0))

  process.stdout.write(`listening ${port}\n`)
}
