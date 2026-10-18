import { strict as assert } from 'node:assert'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { FILE, REF, project } from './fixture.mjs'
import { isToken, serverOf } from '../../theseus/ui/server.mjs'

const TOKEN = 'a'.repeat(48)

const started = async () => {
  const root = await project()
  const server = serverOf({ root, token: TOKEN, page: join(root, 'missing.html') })
  const port = await server.start(0)
  const at = path => `http://127.0.0.1:${port}${path}`

  return { root, server, at }
}

test('answers no API call without the token, and the page with no data in it', async () => {
  const { server, at } = await started()

  try {
    assert.equal((await fetch(at('/api/runs'))).status, 403)
    assert.equal((await fetch(at('/api/runs'), { headers: { 'x-theseus-token': 'b'.repeat(48) } })).status, 403)
    assert.match(await (await fetch(at('/'))).text(), /not built/)
    assert.equal(isToken(TOKEN, TOKEN), true)
    assert.equal(isToken('short', TOKEN), false)
  } finally {
    await server.stop()
  }
})

test("lists the runs by their latest view, and gives a run's views and log", async () => {
  const { server, at } = await started()
  const get = async path => (await fetch(at(path), { headers: { 'x-theseus-token': TOKEN } })).json()

  try {
    const { runs } = await get('/api/runs')

    assert.equal(runs.length, 1)
    assert.equal(runs[0].file, FILE)
    assert.equal(runs[0].view.said, 'stopped for you')

    const run = await get(`/api/run?file=${FILE}`)

    assert.equal(run.views.length, 3)
    assert.equal(run.events.length, 6)
    assert.equal((await fetch(at('/api/run?file=../../etc/passwd'), { headers: { 'x-theseus-token': TOKEN } })).status, 400)
  } finally {
    await server.stop()
  }
})

test('takes an action on a run under way into the requests file, and refuses any other', async () => {
  const { root, server, at } = await started()
  const post = body => fetch(at('/api/action'), { method: 'POST', headers: { 'x-theseus-token': TOKEN, 'content-type': 'application/json' }, body: JSON.stringify(body) })

  try {
    assert.equal((await post({ ref: REF, action: 'rm -rf' })).status, 400)
    assert.equal((await post({ ref: 'github:o/r#999', action: 'next' })).status, 400)
    assert.equal((await post({ ref: REF, action: 'next' })).status, 202)

    const [line] = (await readFile(join(root, '.theseus', 'requests.jsonl'), 'utf8')).trim().split('\n')

    assert.deepEqual({ ...JSON.parse(line), at: 0 }, { ref: REF, action: 'next', at: 0 })
  } finally {
    await server.stop()
  }
})

test('streams the runs at once, and again when a view is written', async () => {
  const { root, server, at } = await started()
  const answer = await fetch(at(`/api/stream?token=${TOKEN}`))
  const reader = answer.body.getReader()
  const read = async () => new TextDecoder().decode((await reader.read()).value)

  try {
    assert.match(await read(), /^event: runs\ndata: \[\{"file":"github-o-r-54"/)

    const { appendFile } = await import('node:fs/promises')
    await appendFile(join(root, '.theseus', 'views', `${FILE}.jsonl`), `${JSON.stringify({ ref: REF, said: 'built', lastAt: 1 })}\n`)

    assert.match(await read(), /"said":"built"/)
  } finally {
    await reader.cancel()
    await server.stop()
  }
})
