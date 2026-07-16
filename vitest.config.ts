import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Vitest's default glob matches *.spec.ts, which grabs the Playwright suite
    // and fails on import — Playwright's `test` and vitest's are different
    // runners with the same name. Unit tests are *.test.ts and E2E is *.spec.ts;
    // that split is the only thing keeping them apart, so it's enforced here.
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['node_modules', 'dist', 'tests/e2e/**'],
  },
});
