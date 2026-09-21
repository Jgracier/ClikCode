import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: ROOT,
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.vitest.test.ts'],
    // forks, not threads: several suites drive raw-mode terminal state and spawn
    // child processes, which a shared worker thread cannot isolate.
    pool: 'forks',
  },
});
