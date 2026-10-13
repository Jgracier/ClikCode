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
    // Its own empty home per test file: see vitest.setup.ts.
    setupFiles: ['./vitest.setup.ts'],
    // The publish build runs the whole suite on a shared host and sets this: a test that fails
    // once under load and passes on a retry is not a broken build. Unset (the default), no retries.
    retry: Number(process.env.CLIKCODE_TEST_RETRY) || 0,
    // ...and the host is slower than the 5 s default assumes (file-heavy tests time out and then
    // fail their own cleanup), so the same switch widens the timeouts.
    ...(Number(process.env.CLIKCODE_TEST_RETRY) ? { testTimeout: 30_000, hookTimeout: 30_000 } : {}),
  },
});
