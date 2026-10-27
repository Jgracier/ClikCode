#!/usr/bin/env node
/**
 * Runs every real-Chrome ("smoke") test headless, with no display and no setup:
 *   pnpm test:browser [extra vitest args or file filters]
 * Builds dist/ first when it is missing or older than src/ (the browser host is a child process
 * running this checkout's dist/index.js), then runs the integration tests that need only Chrome.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist', 'index.js');

/** Tests that look like browser tests but cannot run unattended, and why. */
const SKIPPED = {
  'src/agent/computer/browser-attach.integration.test.ts': 'needs CLIKCODE_BROWSER_ATTACH_STATE_DIR (a browser already started by another process)',
  'src/agent/computer/browser-launch.integration.vitest.test.ts': 'needs CLIKCODE_COMPUTER_DOWNLOAD (downloads Chrome over the network)',
  'src/agent/computer/driver.integration.vitest.test.ts': 'drives the real desktop through Cua Driver (needs a display and a visible Chrome window, not headless)',
};

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}
const newest = (dir) => walk(dir).reduce((latest, file) => Math.max(latest, statSync(file).mtimeMs), 0);

const rel = (file) => relative(root, file).split('\\').join('/');
const all = walk(join(root, 'src', 'agent')).map(rel).filter((file) => /integration.*\.test\.ts$/.test(file)).sort();
const run = all.filter((file) => !(file in SKIPPED) && /CLIKCODE_COMPUTER_SMOKE/.test(readFileSync(join(root, file), 'utf8')));
const unmarked = all.filter((file) => !(file in SKIPPED) && !run.includes(file));
for (const file of Object.keys(SKIPPED)) if (all.includes(file)) console.log(`skipped ${file}: ${SKIPPED[file]}`);
for (const file of unmarked) console.log(`skipped ${file}: does not use CLIKCODE_COMPUTER_SMOKE (not a real-Chrome test)`);

if (!existsSync(dist) || statSync(dist).mtimeMs < newest(join(root, 'src'))) {
  console.log('building dist/ (missing or older than src/)...');
  const built = spawnSync(process.execPath, [join(root, 'scripts', 'build.mjs')], { cwd: root, stdio: 'inherit' });
  if (built.status !== 0) process.exit(built.status ?? 1);
}

const env = { ...process.env, CLIKCODE_BROWSER_HEADLESS: '1', CLIKCODE_BROWSER_HOST_ENTRY: dist, CLIKCODE_COMPUTER_SMOKE: '1' };
delete env.DISPLAY;
delete env.WAYLAND_DISPLAY;
delete env.CLIKCODE_COMPUTER_DOWNLOAD;

const extra = process.argv.slice(2);
const files = extra.some((arg) => !arg.startsWith('-')) ? [] : run;
const vitest = join(root, 'node_modules', 'vitest', 'vitest.mjs');
const started = Date.now();
const result = spawnSync(process.execPath, [vitest, 'run', ...files, ...extra], { cwd: root, env, stdio: 'inherit' });
const seconds = Math.round((Date.now() - started) / 1000);
console.log(`test:browser: ${result.status === 0 ? 'PASS' : 'FAIL'}, ${files.length || 'selected'} files in ${seconds}s (${all.length - run.length} skipped)`);
process.exit(result.status ?? 1);
