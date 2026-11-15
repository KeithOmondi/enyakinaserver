import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    // Tests share one database; run files sequentially to keep state predictable.
    fileParallelism: false,
    testTimeout: 15_000,
  },
});
