import { defineConfig, devices } from '@playwright/test'

// Fixed, isolated loopback target only. Never point this synthetic-data test at a public site.
export default defineConfig({
  testDir: './deployment-e2e',
  outputDir: 'test-results/deployment',
  workers: 1,
  retries: 0,
  timeout: 60_000,
  forbidOnly: Boolean(process.env.CI),
  use: {
    ...devices['Desktop Chrome'],
    channel: process.env.PLAYWRIGHT_CHANNEL,
    baseURL: 'https://armeniabus.localhost:18443',
    ignoreHTTPSErrors: true, // Only the ephemeral Caddy internal CA in deployment_smoke.py.
    trace: 'retain-on-failure',
    launchOptions: {
      args: ['--host-resolver-rules=MAP armeniabus.localhost 127.0.0.1'],
    },
  },
})
