import { defineConfig } from '@playwright/test'

// The built page, served by the real server on a fixture project, in Chromium
export default defineConfig({
  testDir: 'tests',
  testMatch: /.*\.spec\.mjs$/,
  timeout: 30_000,
  use: { browserName: 'chromium', viewport: { width: 1360, height: 900 } },
  reporter: 'list',
})
