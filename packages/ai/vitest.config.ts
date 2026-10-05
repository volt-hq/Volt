import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 30000, // 30 seconds for API calls
    // Local runs use half the host's cores; set VITEST_MAX_WORKERS to share a busy host. CLI and pool overrides still apply.
    maxWorkers: process.env.CI && process.env.CI !== 'false' ? 8 : '50%',
  }
});
