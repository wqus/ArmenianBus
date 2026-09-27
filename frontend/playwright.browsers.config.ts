import { defineConfig, devices } from '@playwright/test'
import base from './playwright.config'

// A small engine matrix against the production bundle, with synthetic API responses only.
export default defineConfig({
  ...base,
  testMatch: 'hardening.spec.ts',
  outputDir: 'test-results/browsers',
  use: { ...base.use, channel: undefined },
  projects: [
    {
      name: 'chromium-qa',
      use: { ...devices['Desktop Chrome'], channel: process.env.PLAYWRIGHT_CHANNEL },
    },
    { name: 'firefox-qa', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit-qa', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: 'npm run preview -- --port 5174',
    url: 'http://127.0.0.1:5174',
    reuseExistingServer: false,
  },
})
