import { defineConfig, devices } from '@playwright/test'

// Both demos must be built first: npm run demo:build -- consent && npm run demo:build -- notice
export default defineConfig({
  testDir: 'tests/e2e',
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  // Short locally so a failing run ends quickly; CI runners are slower and get more room.
  timeout: process.env.CI ? 60_000 : 20_000,
  expect: { timeout: process.env.CI ? 10_000 : 4_000 },
  use: { baseURL: 'http://localhost:4321', actionTimeout: process.env.CI ? 10_000 : 4_000 },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node demo/dist-consent/server/entry.mjs',
      env: { PORT: '4321', HOST: '127.0.0.1' },
      port: 4321,
      reuseExistingServer: false,
    },
    {
      command: 'node demo/dist-notice/server/entry.mjs',
      env: { PORT: '4322', HOST: '127.0.0.1' },
      port: 4322,
      reuseExistingServer: false,
    },
  ],
})
