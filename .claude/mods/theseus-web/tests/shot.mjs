// Screenshots of the page on the fixture project, light and dark: node tests/shot.mjs <folder>
import { chromium } from '@playwright/test'

import { project } from './fixture.mjs'
import { serverOf } from '../../theseus/ui/server.mjs'

const out = process.argv[2] ?? '.'
const root = await project()
const server = serverOf({ root, token: 't'.repeat(48), page: new URL('../../theseus/ui/dist/index.html', import.meta.url).pathname })
const port = await server.start(0)
const browser = await chromium.launch()

for (const scheme of ['light', 'dark']) {
  const page = await browser.newPage({ viewport: { width: 1360, height: 980 }, colorScheme: scheme })

  await page.goto(`http://127.0.0.1:${port}/?token=${'t'.repeat(48)}`)
  await page.locator('[data-task="2"]').click()
  await page.waitForTimeout(800)
  await page.screenshot({ path: `${out}/web-${scheme}.png`, fullPage: true })
}
await browser.close()
await server.stop()
