#!/usr/bin/env node
/** Builds packages/chat-client into packages/chat-client/dist: the chat model
 * as one dependency-free ES module (index.js) and its declarations (types/,
 * entered through index.d.ts), stamped with the commit they were built from.
 *
 * A client outside this repository (the ClikDeploy app) copies dist in whole.
 * `platform: neutral` is the check that it stays usable there: an import of
 * Node or VS Code anywhere in the model fails this build.
 *
 *   node scripts/build-chat-client.mjs [--out <directory>] */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = join(repo, 'packages/chat-client');
const dist = join(pkg, 'dist');
const outFlag = process.argv.indexOf('--out');
const out = outFlag > 0 ? resolve(process.argv[outFlag + 1]) : undefined;

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
await build({ entryPoints: [join(pkg, 'index.ts')], bundle: true, format: 'esm', platform: 'neutral', target: 'es2020', outfile: join(dist, 'index.js'), logLevel: 'warning' });
execFileSync(process.execPath, [join(repo, 'node_modules/typescript/bin/tsc'), '-p', join(pkg, 'tsconfig.json')], { cwd: repo, stdio: 'inherit' });
writeFileSync(join(dist, 'index.d.ts'), "export * from './types/packages/chat-client/index.js';\n");
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const dirty = git('status', '--porcelain', '--', 'src', 'packages/vscode/src', 'packages/chat-client') !== '';
writeFileSync(join(dist, 'source.json'), `${JSON.stringify({ commit: git('rev-parse', 'HEAD'), dirty }, null, 2)}\n`);
if (out) {
  rmSync(out, { recursive: true, force: true });
  cpSync(dist, out, { recursive: true });
}
console.log(`chat client built${out ? ` -> ${out}` : ''}`);
