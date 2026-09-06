import { defineConfig, devices } from '@playwright/test'
import os from 'node:os'
import path from 'node:path'

const externalBaseUrl = process.env.PLAYWRIGHT_BASE_URL
const baseURL = externalBaseUrl ?? 'http://127.0.0.1:3100'
const useProductionBuild = !!process.env.CI

export default defineConfig({
  testDir: './tests/browser',
  workers: 1,
  outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR ?? path.join(os.tmpdir(), 'segov-dev-playwright'),
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: externalBaseUrl
    ? undefined
    : {
        command: useProductionBuild
          ? 'node tests/browser/start-production.mjs'
          : 'pnpm dev --hostname 127.0.0.1 --port 3100',
        url: `${baseURL}/ama`,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        env: { AMA_TRACE_LOGGING_ENABLED: '0', HOSTNAME: '127.0.0.1', PORT: '3100' },
      },
})
