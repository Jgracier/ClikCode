/** `pnpm run package`: the .vsix, built for production.
 *
 * vsce runs `vscode:prepublish` through npm, and pnpm hands its own
 * npm_config_* settings to every script it runs -- which npm then warns
 * about ("Unknown env config"). They mean nothing to npm, so they are left
 * out of vsce's environment and the package builds without warnings.
 * Extra arguments are passed to vsce (e.g. `--out <path>`).
 */
import { spawnSync } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const repo = join(root, '..', '..');

/** Where a package's dependency `name` is, resolved the way Node would from its real directory.
 * pnpm keeps a package's dependencies as siblings inside `.pnpm/<id>/node_modules`, so both the
 * ordinary walk up and the sibling lookup are needed. */
function resolvePackage(from, name) {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidates = [join(dir, 'node_modules', name), ...(basename(dir) === 'node_modules' ? [join(dir, name)] : [])];
    const found = candidates.find((candidate) => existsSync(join(candidate, 'package.json')));
    if (found) return realpathSync(found);
    if (dirname(dir) === dir) throw new Error(`cannot resolve ${name} from ${from}`);
  }
}

/** The ClikCode that ships inside the extension, so one Marketplace install works with nothing
 * else on the machine (src/runtime.ts uses it only when no ClikCode is installed).
 *
 *   bundled/clikcode/dist/             the CLI build (pnpm build:strict output)
 *   bundled/clikcode/package.json      "type": "module", so dist/index.js loads as ESM
 *   bundled/clikcode/node_modules/     the few packages dist/ imports at runtime, and theirs
 */
function stageClikcode() {
  const rootPackage = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  if (!existsSync(join(repo, 'dist', 'index.js'))) {
    const built = spawnSync(process.execPath, [join(repo, 'scripts', 'build.mjs')], { cwd: repo, stdio: 'inherit' });
    if (built.status !== 0) process.exit(built.status ?? 1);
  }
  const target = join(root, 'bundled', 'clikcode');
  rmSync(join(root, 'bundled'), { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  cpSync(join(repo, 'dist'), join(target, 'dist'), { recursive: true });
  writeFileSync(join(target, 'package.json'), `${JSON.stringify({
    name: rootPackage.name, version: rootPackage.version, type: 'module', engines: rootPackage.engines,
    dependencies: rootPackage.dependencies,
  }, null, 2)}\n`);
  const staged = new Set();
  const stage = (name, from) => {
    if (staged.has(name)) return;
    staged.add(name);
    const real = resolvePackage(from, name);
    cpSync(real, join(target, 'node_modules', name), { recursive: true, dereference: true, filter: (source) => basename(source) !== 'node_modules' });
    const manifest = JSON.parse(readFileSync(join(real, 'package.json'), 'utf8'));
    for (const dependency of Object.keys(manifest.dependencies ?? {})) stage(dependency, real);
  };
  for (const name of Object.keys(rootPackage.dependencies ?? {})) stage(name, repo);
  console.log(`bundled ClikCode ${rootPackage.version}: dist + ${[...staged].join(', ')}`);
}
stageClikcode();

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_(config|package|lifecycle)_/i.test(key)));
const vsce = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'vsce.cmd' : 'vsce');
const extra = process.argv.slice(2);
const args = ['package', '--no-dependencies', ...(extra.includes('--out') ? [] : ['--out', `clikcode-${version}.vsix`]), ...extra];
const result = spawnSync(vsce, args, { cwd: root, env, stdio: 'inherit', shell: process.platform === 'win32' });
process.exit(result.status ?? 1);
