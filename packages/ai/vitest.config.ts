import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 30000, // 30 seconds for API calls
    // Keep local runs within a shared host budget; CLI and pool overrides still apply.
    maxWorkers: process.env.CI && process.env.CI !== 'false' ? 8 : 2,
    minWorkers: 1,
  }
});
