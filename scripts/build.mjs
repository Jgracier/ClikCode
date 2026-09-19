import { chmod } from 'node:fs/promises';
import { build } from 'esbuild';

const checkOnly = process.argv.includes('--check');
const common = { bundle: true, platform: 'node', target: 'node22', logLevel: 'info' };

await build({
  ...common,
  entryPoints: ['src/index.ts'],
  packages: 'external',
  format: 'esm',
  banner: { js: '#!/usr/bin/env node' },
  ...(checkOnly ? { write: false } : { outfile: 'dist/index.js' }),
});

await build({
  ...common,
  entryPoints: ['../cli/src/ai-router-runtime.ts'],
  format: 'cjs',
  external: ['@basetenlabs/performance-client'],
  ...(checkOnly ? { write: false } : { outfile: 'dist/ai-router-runtime.cjs' }),
});

if (!checkOnly && process.platform !== 'win32') await chmod('dist/index.js', 0o755);
