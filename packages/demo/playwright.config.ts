import { defineConfig, devices } from '@playwright/test';

// Browser smoke test for the demo page: serves the built static app (dist/app via
// `vite preview`, so the strict-CSP external bundle is exercised, not the dev server) and
// checks the editor mounts, Run draws, and Stop halts. `test:browser` builds first.
export default defineConfig({
  // A separate dir from test/ so `node --test` (the run-core tests) does not pick these up.
  testDir: './e2e',
  testMatch: '**/*.spec.mjs',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 1 : 0,
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run preview',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env['CI'],
    timeout: 60_000,
  },
});
