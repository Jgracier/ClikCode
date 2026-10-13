/** Bundles the extension host code and the chat webview.
 *
 *   dist/extension.js  CommonJS for the extension host; `vscode` is provided.
 *   dist/webview.js    One IIFE for the webview (Preact), loaded under a nonce CSP.
 *   dist/webview.css   Its stylesheet; dist/codicon.css + codicon.ttf, VS Code's
 *                      own icon font, so no image is ever fetched from anywhere.
 *
 * `--production` minifies without source maps (what is packaged);
 * `--tests` also builds the integration test runner and suite into out/.
 * Protocol types come from ../../src/ide/protocol.ts and are erased here.
 * Some ClikCode source IS bundled, as pure helpers the page and the reducer
 * share with the terminal so the two cannot disagree: IDE_PROTOCOL
 * (src/ide/protocol-version.ts), the turn-flow, activity-view and diff-unwind
 * rules, usage and steer wording, and the notice-level parse. The agent, the
 * worker and the CLI itself are not: the extension runs the user's installed
 * ClikCode (see src/runtime.ts for why), which may be a different build than
 * the one these helpers came from. So the build records the protocol and
 * revision (and the commit) it was made against (`__CLIKCODE_BUILT_AGAINST__`),
 * and the extension says so when the installed ClikCode's `ready` differs
 * (compat.ts versionSkew) instead of failing silently.
 */
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const production = process.argv.includes('--production');
const tests = process.argv.includes('--tests');

/** The protocol the bundled helpers were taken from: read from the source, and
 * the build fails rather than ship a bundle that cannot say what it expects. */
const protocolSource = await readFile('../../src/ide/protocol-version.ts', 'utf8');
const protocolNumber = (key) => {
  const value = Number(new RegExp(`\\b${key}:\\s*(\\d+)`).exec(protocolSource)?.[1]);
  if (!Number.isInteger(value)) throw new Error(`build: cannot read ${key} from src/ide/protocol-version.ts`);
  return value;
};
let commit = 'unknown';
try { commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || commit; } catch { /* a build outside git */ }
const builtAgainst = { protocol: protocolNumber('version'), revision: protocolNumber('revision'), commit };
console.log(`built against ClikCode bridge protocol ${builtAgainst.protocol}.${builtAgainst.revision} (${commit})`);

await rm('dist', { recursive: true, force: true });
const common = { bundle: true, logLevel: 'warning', sourcemap: !production, minify: production, legalComments: 'none' };
await Promise.all([
  build({ ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'],
    define: { __CLIKCODE_BUILT_AGAINST__: JSON.stringify(builtAgainst) } }),
  build({
    ...common, entryPoints: ['src/webview/main.tsx'], outfile: 'dist/webview.js', platform: 'browser', format: 'iife', target: 'es2022',
    jsx: 'automatic', jsxImportSource: 'preact',
  }),
  build({ ...common, sourcemap: false, entryPoints: ['src/webview/styles.css'], outfile: 'dist/webview.css', loader: { '.css': 'css' } }),
]);
await mkdir('dist', { recursive: true });
const codicons = 'node_modules/@vscode/codicons/dist';
await Promise.all([copyFile(`${codicons}/codicon.css`, 'dist/codicon.css'), copyFile(`${codicons}/codicon.ttf`, 'dist/codicon.ttf')]);
if (tests) {
  await rm('out', { recursive: true, force: true });
  await build({
    ...common, sourcemap: true, minify: false, platform: 'node', format: 'cjs', target: 'node20',
    entryPoints: ['test/integration/run.ts', 'test/integration/suite/index.ts'], outdir: 'out/test/integration', outbase: 'test/integration',
    external: ['vscode', 'mocha', '@vscode/test-electron'],
  });
}
