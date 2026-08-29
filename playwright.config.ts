import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the e2e test. We use the built-in `vite preview`
 * server. The backend must already be running on http://localhost:3001
 * (start it with `pnpm dev:be` from the repo root before running tests).
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  reporter: [['list']],
  timeout: 120_000,
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
    actionTimeout: 30_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'pnpm build && pnpm preview',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});