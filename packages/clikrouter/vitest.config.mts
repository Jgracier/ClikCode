import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: path.dirname(fileURLToPath(import.meta.url)),
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // The publish build sets this (see the repo-root vitest.config.ts): on the shared host a cold
    // import of the router's AI SDK bundle can pass 5 s, which is load, not a broken test.
    ...(Number(process.env.CLIKCODE_TEST_RETRY) ? { retry: Number(process.env.CLIKCODE_TEST_RETRY), testTimeout: 30_000 } : {}),
  },
});
