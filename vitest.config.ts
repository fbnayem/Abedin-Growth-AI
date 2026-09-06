import { defineConfig } from 'vitest/config';

/**
 * P2 — Test runner configuration.
 *
 * Until this existed, no section of docs/production/addendum-status.md could rise above
 * IMPLEMENTED_UNVERIFIED, because §1's grading standard requires a test with real assertions
 * covering the failure, retry, tenant and concurrency paths. A repository with no runner has
 * no way to hold an invariant.
 *
 * `environment: 'node'` because everything under test is backend logic. Frontend component
 * tests would need jsdom; add a second project entry when that work starts rather than
 * loading jsdom for suites that do not need it.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['server/tests/**/*.test.ts'],
    // Each suite manipulates process.env (Safe Mode flags, webhook secrets). Isolation keeps
    // one suite's environment mutations from leaking into another's expectations.
    isolate: true,
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      include: ['server/**/*.ts'],
      exclude: ['server/tests/**', 'server/**/*.d.ts'],
    },
  },
});
