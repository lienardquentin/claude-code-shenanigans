// Asks the tabs of a Chrome that listens on a debug port what `page.js` says of each, and prints the answers as
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

// What `page.js` answers in one tab; undefined when the tab does not answer, or is none of the watched apps
const askTab = ({ webSocketDebuggerUrl }) =>
  new Promise(resolve => {
    const socket = new WebSocket(webSocketDebuggerUrl)

    const done = answer => {
      clearTimeout(timer)
      socket.close()
      resolve(answer)
    }

    const timer = setTimeout(() => done(undefined), TAB_TIMEOUT_MS)

    socket.onopen = () => socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }))
    socket.onerror = () => done(undefined)

    socket.onmessage = ({ data }) => {
      try {
        const reply = JSON.parse(String(data))

        if (reply.id !== 1) return

        const said = reply.result?.result?.value

        done(typeof said === 'string' ? (JSON.parse(said) ?? undefined) : undefined)
      } catch {
        done(undefined)
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
