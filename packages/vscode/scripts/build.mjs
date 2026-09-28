/** Bundles the extension host code and the chat webview.
 *
 *   dist/extension.js  CommonJS for the extension host; `vscode` is provided.
 *   dist/webview.js    One IIFE for the webview, loaded under a nonce CSP.
 *
 * `--production` minifies without source maps (what is packaged);
 * `--tests` also builds the integration test runner and suite into out/.
 * Protocol types come from ../../src/ide/protocol.ts and are erased here;
 * the one value taken from ClikCode is IDE_PROTOCOL
 * (../../src/ide/protocol-version.ts, which imports nothing). No ClikCode code
 * is bundled -- the extension runs the user's installed ClikCode (see
 * src/runtime.ts for why).
 */
import { build } from 'esbuild';
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const production = process.argv.includes('--production');
const tests = process.argv.includes('--tests');

await rm('dist', { recursive: true, force: true });
const common = { bundle: true, logLevel: 'warning', sourcemap: !production, minify: production, legalComments: 'none' };
await Promise.all([
  build({ ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'] }),
  build({ ...common, entryPoints: ['src/webview/main.ts'], outfile: 'dist/webview.js', platform: 'browser', format: 'iife', target: 'es2022' }),
]);
if (tests) {
  await rm('out', { recursive: true, force: true });
  await build({
    ...common, sourcemap: true, minify: false, platform: 'node', format: 'cjs', target: 'node20',
    entryPoints: ['test/integration/run.ts', 'test/integration/suite/index.ts'], outdir: 'out/test/integration', outbase: 'test/integration',
    external: ['vscode', 'mocha', '@vscode/test-electron'],
  });
}
