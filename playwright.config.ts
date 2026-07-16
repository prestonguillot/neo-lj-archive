import { defineConfig, devices } from '@playwright/test';

/**
 * The archive opens from file://, so there is no webServer here and there must
 * never be one. A dev server would test something the reader will never have
 * (DESIGN.md §13).
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: 0, // No network and no server: a flake here would be a real bug.
  reporter: process.env['CI'] ? 'github' : 'list',
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
