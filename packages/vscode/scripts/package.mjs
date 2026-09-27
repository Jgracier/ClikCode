/** `pnpm run package`: the .vsix, built for production.
 *
 * vsce runs `vscode:prepublish` through npm, and pnpm hands its own
 * npm_config_* settings to every script it runs -- which npm then warns
 * about ("Unknown env config"). They mean nothing to npm, so they are left
 * out of vsce's environment and the package builds without warnings.
 * Extra arguments are passed to vsce (e.g. `--out <path>`).
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_(config|package|lifecycle)_/i.test(key)));
const vsce = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'vsce.cmd' : 'vsce');
const extra = process.argv.slice(2);
const args = ['package', '--no-dependencies', ...(extra.includes('--out') ? [] : ['--out', `clikcode-${version}.vsix`]), ...extra];
const result = spawnSync(vsce, args, { cwd: root, env, stdio: 'inherit', shell: process.platform === 'win32' });
process.exit(result.status ?? 1);
