// Asks the tabs of a Chrome that listens on a debug port what `page.js` says of each, and what the console of each
// holds of errors and warnings, and prints the answers as
// one JSON line: {"tabs": 3, "pages": [...]}, or {"error": "..."} when the browser could not be asked. palantir
// runs it with Node, which its own environment is not: the DevTools protocol is spoken over a WebSocket.
//
//   node ask.mjs <debug port> '<the watched apps as JSON: [{"label","roots","port"}]>'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const FLAG = '--experimental-websocket'
const TAB_TIMEOUT_MS = 3000

const [port = '9222', watched = '[]'] = process.argv.slice(2)

const print = answer => {
  process.stdout.write(`${JSON.stringify(answer)}\n`)
}

// Node has a WebSocket of its own from 22 on, and behind a flag from 20.10: asked for once, by running again
if (typeof WebSocket === 'undefined') {
  if (process.execArgv.includes(FLAG)) {
    print({ error: `Node ${process.versions.node} has no WebSocket: 20.10 or later is needed` })
    process.exit(0)
  }

  const again = spawnSync(process.execPath, [FLAG, '--no-warnings', ...process.argv.slice(1)], { stdio: ['ignore', 'inherit', 'ignore'] })

  if (again.status !== 0) print({ error: `Node ${process.versions.node} has no WebSocket: 20.10 or later is needed` })

  process.exit(0)
}

// The file is one function, under its comments
const expression = `(\n${readFileSync(new URL('./page.js', import.meta.url), 'utf8')}\n)(${JSON.stringify(JSON.parse(watched))})`

const MAX_SAID = 50
const MAX_WORDS = 400

// What was handed to the console, as the words it shows
const wordsOf = args =>
  (Array.isArray(args) ? args : [])
    .map(arg => (arg?.type === 'string' ? arg.value : (arg?.description ?? (arg?.value === undefined ? (arg?.type ?? '') : JSON.stringify(arg.value)))))
    .join(' ')

// Where it was raised: the first frame that is the app's own, as its path and its line
const whereOf = (frames, url, line) => {
  const own = (Array.isArray(frames) ? frames : []).find(frame => typeof frame?.url === 'string' && frame.url !== '' && !frame.url.includes('/node_modules/'))
  const [address, at] = own === undefined ? [url, line] : [own.url, own.lineNumber]

  if (typeof address !== 'string' || address === '') return ''

  try {
    return `${new URL(address).pathname}${typeof at === 'number' ? `:${at + 1}` : ''}`
  } catch {
    return ''
  }
}

// An error or a warning the tab's console holds, from what the browser says of it; undefined for anything else.
// What the browser remarks of its own accord (a slow handler, something deprecated) is not the app going wrong
const saidOf = ({ method, params }) => {
  if (method === 'Runtime.consoleAPICalled' && ['error', 'assert', 'warning'].includes(params?.type)) {
    return { level: params.type === 'warning' ? 'warn' : 'error', text: wordsOf(params.args), at: params.timestamp, where: whereOf(params.stackTrace?.callFrames) }
  }

  if (method === 'Runtime.exceptionThrown') {
    const details = params?.exceptionDetails ?? {}

    return {
      level: 'error',
      text: `Uncaught ${String(details.exception?.description ?? details.text ?? 'error').split('\n')[0]}`.replace(/^Uncaught Uncaught/, 'Uncaught'),
      at: params?.timestamp,
      where: whereOf(details.stackTrace?.callFrames, details.url, details.lineNumber),
    }
  }

  if (method === 'Log.entryAdded' && ['error', 'warning'].includes(params?.entry?.level) && ['network', 'javascript', 'security', 'other'].includes(params.entry.source)) {
    const { level, text, url, timestamp, lineNumber } = params.entry

    return { level: level === 'warning' ? 'warn' : 'error', text: `${text}${typeof url === 'string' && url !== '' && !String(text).includes(url) ? ` (${url})` : ''}`, at: timestamp, where: whereOf(undefined, url, lineNumber) }
  }

  return undefined
}

// What `page.js` answers in one tab, with the errors and the warnings its console holds past what was read the last
// time; undefined when the tab does not answer, or is none of the watched apps. The browser hands over what the
// console already holds when it is asked to say what comes, which is how what was said before the asking is read
const askTab = ({ webSocketDebuggerUrl }) =>
  new Promise(resolve => {
    const socket = new WebSocket(webSocketDebuggerUrl)
    const said = []
    let page
    let enabled = 0

    const done = answer => {
      clearTimeout(timer)
      socket.close()
      resolve(answer)
    }

    // A tab that answered for its page and not for its console is still that page
    const timer = setTimeout(() => done(page), TAB_TIMEOUT_MS)
    const send = (id, method, params = {}) => socket.send(JSON.stringify({ id, method, params }))

    const finish = () => {
      const fresh = said
        .filter(line => typeof line.at === 'number' && line.at > (page.heard ?? 0))
        .sort((a, b) => a.at - b.at)
        .slice(-MAX_SAID)
        .map(line => ({ ...line, at: Math.round(line.at), text: String(line.text).replace(/\s+/g, ' ').trim().slice(0, MAX_WORDS) }))

      page = { ...page, said: fresh }

      if (fresh.length === 0) return done(page)

      // Left in the page: one that is loaded again is read from its start
      send(4, 'Runtime.evaluate', { expression: `window.__palantir_heard__ = ${Math.max(...said.map(line => (typeof line.at === 'number' ? line.at : 0)))}` })
    }

    socket.onopen = () => send(1, 'Runtime.evaluate', { expression, returnByValue: true })
    socket.onerror = () => done(page)

    socket.onmessage = ({ data }) => {
      try {
        const reply = JSON.parse(String(data))

        if (reply.id === 1) {
          const answered = reply.result?.result?.value

          page = typeof answered === 'string' ? (JSON.parse(answered) ?? undefined) : undefined

          if (page === undefined) return done(undefined)

          send(2, 'Runtime.enable')
          send(3, 'Log.enable')
        } else if (reply.id === 2 || reply.id === 3) {
          enabled += 1

          if (enabled === 2) finish()
        } else if (reply.id === 4) {
          done(page)
        } else if (page !== undefined && typeof reply.method === 'string') {
          const line = saidOf(reply)

          if (line !== undefined) said.push(line)
        }
      } catch {
        done(page)
      }
    }
  })

try {
  // 127.0.0.1 and not localhost: Chrome listens on IPv4 only
  const listed = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) }).then(reply => reply.json())
  const tabs = (Array.isArray(listed) ? listed : []).filter(tab => tab?.type === 'page' && /^https?:/.test(tab.url ?? '') && typeof tab.webSocketDebuggerUrl === 'string')
  const pages = (await Promise.all(tabs.map(askTab))).filter(page => page !== undefined)

  print({ tabs: tabs.length, pages })
} catch {
  print({ error: 'no-browser' })
}

process.exit(0)
