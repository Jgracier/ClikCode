import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: ROOT,
  test: {
    environment: 'node',
    include: ['test/unit/**/*.test.ts'],
  },
});
