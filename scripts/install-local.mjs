#!/usr/bin/env node
/** Installs the current build as the `clikcode` on PATH, apart from the checkout.
 *
 * `~/.local/bin/clikcode` used to point straight at this checkout's dist/index.js, so every
 * `pnpm run build` -- by anyone, for any reason -- was a new build to every running worker: they
 * retired and the next turn in each conversation started its agent and all its MCP servers cold
 * again. Measured 2026-10-18: 575 of 601 worker exits in a week were "replaced by a newer
 * ClikCode build". Now a build changes nothing that is running; this script is the one step that
 * does, and it only installs a build of the tip of origin/main (an install from an older base once
 * reverted another session's fixes).
 *
 *   node scripts/install-local.mjs           build, check, install
 *   node scripts/install-local.mjs --force   install whatever dist holds (still refused when HEAD is
 *                                            behind origin/main; --even-if-behind overrides that too)
 *
 * Layout: ~/.local/share/clikcode/release/{dist,package.json,node_modules -> checkout's}, swapped
 * in whole by a rename, and ~/.local/bin/clikcode -> release/dist/index.js. */
import { execFileSync } from 'node:child_process';
import { realpathSync, cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, symlinkSync, lstatSync, readlinkSync, unlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const force = process.argv.includes('--force');
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();

// --force skips the clean-tip rules below, never this one. A build whose HEAD lacks commits that are
// already on origin/main takes their features out of every running ClikCode: on 2026-10-21 a --force
// install from a checkout 134 commits behind removed /remote, /machine and /update from the installed
// build, twice.
try { git('fetch', '-q', 'origin', 'main'); } catch { /* offline: judged by the last fetch */ }
const behind = Number(git('rev-list', '--count', 'HEAD..origin/main'));
if (behind > 0 && !process.argv.includes('--even-if-behind')) {
  console.error(`not installing: HEAD is ${behind} commit${behind === 1 ? '' : 's'} behind origin/main, so this build would remove what they added. Merge or rebase onto origin/main first (or pass --even-if-behind to install it anyway).`);
  process.exit(1);
}

if (!force) {
  const head = git('rev-parse', 'HEAD');
  const tip = git('rev-parse', 'origin/main');
  if (head !== tip) {
    console.error(`not installing: HEAD ${head.slice(0, 8)} is not origin/main ${tip.slice(0, 8)} (git pull first, or --force)`);
    process.exit(1);
  }
  const dirty = git('status', '--porcelain', '--', 'src', 'packages', 'scripts/build.mjs');
  if (dirty) {
    console.error(`not installing: uncommitted source changes would be in the build:\n${dirty}`);
    process.exit(1);
  }
  execFileSync('node', ['scripts/build.mjs'], { cwd: repo, stdio: 'inherit' });
}

const dist = join(repo, 'dist');
for (const file of ['index.js', 'cli.js']) if (!existsSync(join(dist, file))) { console.error(`dist/${file} is missing`); process.exit(1); }

const share = join(homedir(), '.local', 'share', 'clikcode');
const release = join(share, 'release');
const next = join(share, `release.${process.pid}`);
rmSync(next, { recursive: true, force: true });
mkdirSync(next, { recursive: true });
cpSync(dist, join(next, 'dist'), { recursive: true });
cpSync(join(repo, 'package.json'), join(next, 'package.json'));
// The bundle leaves npm packages external: they resolve through the checkout's node_modules.
// Its real path: run from a worktree whose node_modules is itself a link, the install must not point into the worktree.
// A target inside the temp folder disappears on reboot or cleanup and takes the installed CLI with it
// ("Cannot find package yaml"). Use the shared deps folder then, or refuse rather than install a time bomb.
let modules = realpathSync(join(repo, 'node_modules'));
if (modules.startsWith(realpathSync(tmpdir()) + '/')) {
  const stable = join(share, 'deps', 'node_modules');
  if (!existsSync(join(stable, 'playwright-core'))) {
    console.error(`node_modules resolves into ${modules} (temporary). Install from a checkout with its own node_modules.`);
    process.exit(1);
  }
  modules = stable;
}
symlinkSync(modules, join(next, 'node_modules'));
execFileSync(process.execPath, [join(next, 'dist', 'index.js'), '--version'], { stdio: 'ignore' });

const old = join(share, `release.old.${process.pid}`);
if (existsSync(release)) renameSync(release, old);
renameSync(next, release);
rmSync(old, { recursive: true, force: true });
for (const stale of readdirSync(share)) if (/^release\.(old\.)?\d+$/.test(stale)) rmSync(join(share, stale), { recursive: true, force: true });

const bin = join(homedir(), '.local', 'bin', 'clikcode');
const target = join(release, 'dist', 'index.js');
const current = existsSync(bin) || lstatSync(bin, { throwIfNoEntry: false }) ? (lstatSync(bin).isSymbolicLink() ? readlinkSync(bin) : undefined) : undefined;
if (current !== target) {
  mkdirSync(dirname(bin), { recursive: true });
  if (lstatSync(bin, { throwIfNoEntry: false })) unlinkSync(bin);
  symlinkSync(target, bin);
}
console.log(`installed ${git('rev-parse', '--short', 'HEAD')} -> ${target}`);
