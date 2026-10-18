import { expect, test } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { EVENTS, FILE, REF, VIEWS, project } from './fixture.mjs'
import { serverOf } from '../../theseus/ui/server.mjs'

const PAGE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'theseus', 'ui', 'dist', 'index.html')
const TOKEN = 'c'.repeat(48)

let root
let server
let address

test.beforeEach(async ({ page }) => {
  root = await project()
  server = serverOf({ root, token: TOKEN, page: PAGE })
  address = `http://127.0.0.1:${await server.start(0)}/?token=${TOKEN}`

  // Nothing the page asks for may leave this machine
  page.on('request', request => {
    const url = new URL(request.url())

    expect(['127.0.0.1', ''].includes(url.hostname) || url.protocol === 'data:' || url.protocol === 'file:', `the page asked ${request.url()}`).toBe(true)
  })
})

test.afterEach(async () => {
  await server.stop()
})

test('draws the run live: its standing, each task with its steps, and nothing fetched from outside', async ({ page }) => {
  await page.goto(address)

  await expect(page.getByRole('heading', { level: 1 })).toContainText('Beacons burn out after a watch')
  await expect(page.locator('.top .pill').first()).toHaveText('stopped for you')
  await expect(page.locator('.facts')).toContainText('1 of 3 tasks done')
  await expect(page.locator('[data-task]')).toHaveCount(3)
  await expect(page.locator('[data-task="1"] [data-step="tests"]')).toHaveAttribute('data-state', 'skipped')
  await expect(page.locator('[data-task="2"] [data-step="prove"]')).toHaveAttribute('data-state', 'failed')
  await expect(page.locator('[data-task="2"]')).toContainText('try 2')
  await expect(page.locator('[data-task="3"]')).toContainText('waits for task 2')
})

test('shows a task picked in full, and asks for an action through the server', async ({ page }) => {
  await page.goto(address)
  await page.locator('[data-task="2"]').click()

  const drawer = page.getByRole('complementary', { name: 'Detail' })

  await expect(drawer).toContainText('Quench beacons past their watch')
  await expect(drawer.locator('tr[data-step="prove"] .dot')).toHaveClass(/failed/)
  await expect(drawer).toContainText('Sent Service builder on task 2')

  await drawer.getByRole('button', { name: 'Send the next task' }).click()
  await expect(page.getByRole('status')).toContainText('Asked: Send the next task')

  const asked = JSON.parse((await readFile(join(root, '.theseus', 'requests.jsonl'), 'utf8')).trim())

  expect(asked).toMatchObject({ ref: REF, action: 'next' })
})

test('plays the run again from its first view, its events following', async ({ page }) => {
  await page.goto(address)
  await page.getByRole('button', { name: 'Play the run again' }).click()

  await expect(page.locator('.top .pill').first()).toHaveText('building')
  await expect(page.getByRole('button', { name: 'Back to live' })).toBeEnabled()
  await expect(page.locator('.top .pill').first()).toHaveText('stopped for you', { timeout: 10_000 })

  await page.getByRole('slider', { name: 'Moment of the run' }).fill('1')
  await expect(page.locator('[data-task="2"] [data-step="prove"]')).toHaveAttribute('data-state', 'running')
  await expect(page.getByRole('list', { name: 'Events' })).not.toContainText('stopped for you')
})

test('lists every run in the history, and opens one', async ({ page }) => {
  await page.goto(address)
  await page.getByRole('tab', { name: 'History' }).click()

  const row = page.getByRole('row', { name: new RegExp(REF.replace(/[#/]/g, '.')) })

  await expect(row).toContainText('stopped')
  await expect(row).toContainText('1 / 3')
  await row.click()
  await expect(page.locator('[data-task]')).toHaveCount(3)
})

test('opens as a report from a file alone: the run written in, no server', async ({ page }) => {
  const built = await readFile(PAGE, 'utf8')
  const json = JSON.stringify({ file: FILE, data: { views: VIEWS, events: EVENTS } }).replaceAll('<', '\\u003c')
  const at = built.indexOf('<script')
  const path = join(root, 'report.html')

  await writeFile(path, `${built.slice(0, at)}<script>window.__THESEUS_REPORT__ = ${json}</script>\n${built.slice(at)}`)
  await page.goto(pathToFileURL(path).href)

  await expect(page.getByRole('heading', { level: 1 })).toContainText('Beacons burn out after a watch')
  await expect(page.locator('.pill', { hasText: 'report' })).toBeVisible()
  await expect(page.locator('[data-task]')).toHaveCount(3)
  // A report plays the run again; it offers no action
  await page.locator('[data-task="2"]').click()
  await expect(page.getByRole('button', { name: 'Send the next task' })).toHaveCount(0)
})

// The same fields the terminal view's coverage test holds it to, found on the page
test('draws every field of the model the terminal view draws', async ({ page }) => {
  await page.goto(address)
  await page.locator('[data-task="2"]').click()

  const body = page.locator('body')

  for (const text of [REF, 'Beacons burn out after a watch', 'stopped for you', 'build/54-beacons-burn-out ← main', '1 of 3', 'Keep when a beacon was lit', 'Committed a41c9e2', 'Service builder', 'try 2', 'Proving → stopped for you', 'waits for task 2', 'Send the next task', 'Abandon the run']) {
    await expect(body).toContainText(text)
  }
})
