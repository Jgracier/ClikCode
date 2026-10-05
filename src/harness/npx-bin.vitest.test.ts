/** An npx MCP entry becomes `node <bin>` only when that is exactly what npx would run. */
import { execFile } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import { allLocalHarnesses } from '@clikcode/router/ai-local-harness';
import type { AiHarnessAccount } from './definition.js';
import { writeMcpConfigEntry } from './mcp-registry.js';
import { parseNpxCommand, resolveNpxBin, withoutNpx, type NpxRoots } from './npx-bin.js';
import { provisionChosenHarness } from './provision.js';

/** One `_npx/<dir>` as npm leaves it: the spec it was made for, the package. */
async function npxDir(roots: NpxRoots, dir: string, spec: string, name: string, manifest: Record<string, unknown>, files: Record<string, string>): Promise<string> {
  const root = join(roots.cache, '_npx', dir);
  const packageDir = join(root, 'node_modules', name);
  await mkdir(packageDir, { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: { [name]: '^1.0.0' }, _npx: { packages: [spec] } }));
  await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name, ...manifest }));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(packageDir, path, '..'), { recursive: true });
    await writeFile(join(packageDir, path), text);
  }
  return packageDir;
}

const LAUNCHER = { target: '/opt/clikcode/bin/clikcode', args: [] };
const launched = (bin: string, start: number, target: string, args: string[]) => ({ target: LAUNCHER.target, args: ['npx-mcp', bin, String(start), target, ...args] });

async function roots(): Promise<NpxRoots> {
  const root = await mkdtemp(join(tmpdir(), 'clikcode-npx-'));
  return { cache: join(root, 'cache'), globals: [join(root, 'global', 'lib', 'node_modules')] };
}

describe('reading an npx command line', () => {
  it('finds the package, its version and the arguments after it', () => {
    expect(parseNpxCommand('npx', ['-y', 'mcp-remote', 'http://x/sse', '--allow-http'])).toEqual({ name: 'mcp-remote', spec: 'mcp-remote', rest: ['http://x/sse', '--allow-http'] });
    expect(parseNpxCommand('/usr/bin/npx', ['--yes', '@upstash/context7-mcp@1.2.3'])).toEqual({ name: '@upstash/context7-mcp', version: '1.2.3', spec: '@upstash/context7-mcp@1.2.3', rest: [] });
  });

  it('leaves anything that is not plainly one package', () => {
    expect(parseNpxCommand('node', ['x.js'])).toBeUndefined();
    expect(parseNpxCommand('npx', ['-p', 'a', 'b'])).toBeUndefined();
    expect(parseNpxCommand('npx', ['--package=a', 'b'])).toBeUndefined();
    expect(parseNpxCommand('npx', ['-y'])).toBeUndefined();
  });
});

describe('the bin npx would run', () => {
  it('is the cached package\'s bin named after it, for the spec that cache was made for', async () => {
    const at = await roots();
    const dir = await npxDir(at, 'aaa', 'mcp-remote', 'mcp-remote', { version: '0.14.3', bin: { 'mcp-remote': 'dist/proxy.js', 'mcp-remote-client': 'dist/client.js' } }, { 'dist/proxy.js': '', 'dist/client.js': '' });
    const entry = { name: 'brain', target: 'npx', args: ['-y', 'mcp-remote', 'http://x/sse', '--header', 'K: v'] };
    expect(await withoutNpx(entry, async () => at, LAUNCHER)).toEqual({ name: 'brain', ...launched(join(dir, 'dist/proxy.js'), 2, 'npx', entry.args) });
  });

  it('takes an exact version only when that version is the one installed', async () => {
    const at = await roots();
    await npxDir(at, 'bbb', 'pkg@1.0.0', 'pkg', { version: '1.0.1', bin: 'cli.js' }, { 'cli.js': '' });
    expect(await resolveNpxBin(parseNpxCommand('npx', ['pkg@1.0.0'])!, at)).toBeUndefined();
    const right = await npxDir(at, 'ccc', 'pkg@1.0.1', 'pkg', { version: '1.0.1', bin: 'cli.js' }, { 'cli.js': '' });
    expect(await resolveNpxBin(parseNpxCommand('npx', ['pkg@1.0.1'])!, at)).toBe(join(right, 'cli.js'));
  });

  it('leaves a tag or a range to npx, which resolves it again on every start', async () => {
    const at = await roots();
    await npxDir(at, 'ddd', 'ctx@latest', 'ctx', { version: '4.1.1', bin: 'index.js' }, { 'index.js': '' });
    const entry = { name: 'ctx', target: 'npx', args: ['-y', 'ctx@latest'] };
    expect(await withoutNpx(entry, async () => at, LAUNCHER)).toBe(entry);
    expect(await resolveNpxBin(parseNpxCommand('npx', ['ctx@^4'])!, at)).toBeUndefined();
  });

  it('does not use a cache made for another spec, or guess among bins', async () => {
    const at = await roots();
    await npxDir(at, 'eee', 'other-spec', 'tool', { version: '1.0.0', bin: 'a.js' }, { 'a.js': '' });
    expect(await resolveNpxBin(parseNpxCommand('npx', ['tool'])!, at)).toBeUndefined();
    await npxDir(at, 'fff', 'multi', 'multi', { version: '1.0.0', bin: { one: 'a.js', two: 'b.js' } }, { 'a.js': '', 'b.js': '' });
    expect(await resolveNpxBin(parseNpxCommand('npx', ['multi'])!, at)).toBeUndefined();
  });

  it('runs only a Node script under node', async () => {
    const at = await roots();
    await npxDir(at, 'ggg', 'native', 'native', { version: '1.0.0', bin: 'bin/native' }, { 'bin/native': '\x7fELF' });
    expect(await resolveNpxBin(parseNpxCommand('npx', ['native'])!, at)).toBeUndefined();
    const shebang = await npxDir(at, 'hhh', 'script', 'script', { version: '1.0.0', bin: 'bin/script' }, { 'bin/script': '#!/usr/bin/env node\n' });
    expect(await resolveNpxBin(parseNpxCommand('npx', ['script'])!, at)).toBe(join(shebang, 'bin/script'));
  });

  it('uses a global install of the same package', async () => {
    const at = await roots();
    const global = join(at.globals[0]!, '@scope', 'srv');
    await mkdir(global, { recursive: true });
    await writeFile(join(global, 'package.json'), JSON.stringify({ name: '@scope/srv', version: '2.0.0', bin: { srv: 'main.mjs' } }));
    await writeFile(join(global, 'main.mjs'), '');
    expect(await resolveNpxBin(parseNpxCommand('npx', ['-y', '@scope/srv'])!, at)).toBe(join(global, 'main.mjs'));
    expect(await resolveNpxBin(parseNpxCommand('npx', ['-y', '@scope/srv@3.0.0'])!, at)).toBeUndefined();
  });
});

describe('provisioning an npx server', () => {
  it('writes the bin into the vendor and leaves the user\'s own mcp.json as it was', async () => {
    const at = await roots();
    const dir = await npxDir(at, 'aaa', 'mcp-remote', 'mcp-remote', { version: '0.14.3', bin: { 'mcp-remote': 'dist/proxy.js' } }, { 'dist/proxy.js': '' });
    const base = await mkdtemp(join(tmpdir(), 'clikcode-provision-npx-'));
    const home = join(base, 'home');
    const state = join(base, 'state');
    await mkdir(join(home, '.cursor'), { recursive: true });
    await mkdir(state, { recursive: true });
    const source = JSON.stringify({ mcpServers: { brain: { command: 'npx', args: ['-y', 'mcp-remote', 'http://x/sse'] }, ctx: { command: 'npx', args: ['-y', 'ctx@latest'] } } });
    await writeFile(join(state, 'mcp.json'), source);
    const cursor = allLocalHarnesses().find((item) => item.command === 'cursor')!;
    const account: AiHarnessAccount = {
      id: 'acct', provider: 'cursor', label: 'Cursor', authKind: 'oauth', models: [], status: 'ready', credentialRef: 'none', nativeProfile: { env: 'HOME', path: home },
    };
    const result = await provisionChosenHarness({
      harness: cursor, account, workspace: base, stateDir: state, home, npx: at, launcher: LAUNCHER,
      install: async (_harness, entry) => {
        await writeMcpConfigEntry(join(home, '.cursor', 'mcp.json'), 'mcpServers', entry);
        return { harness: 'cursor', ok: true };
      },
    });
    expect(result.mcpInstalled).toEqual(['brain', 'ctx']);
    const written = JSON.parse(await readFile(join(home, '.cursor', 'mcp.json'), 'utf8')) as { mcpServers: Record<string, unknown> };
    const brain = launched(join(dir, 'dist/proxy.js'), 2, 'npx', ['-y', 'mcp-remote', 'http://x/sse']);
    expect(written.mcpServers.brain).toEqual({ command: brain.target, args: brain.args });
    expect(written.mcpServers.ctx).toEqual({ command: 'npx', args: ['-y', 'ctx@latest'] });
    expect(await readFile(join(state, 'mcp.json'), 'utf8')).toBe(source);
  });
});

describe('a vendor starting a rewritten npx server', () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const entry = join(repoRoot, 'dist', 'index.js');
  beforeAll(async () => {
    if (!await access(entry).then(() => true, () => false)) await promisify(execFile)('node', ['scripts/build.mjs'], { cwd: repoRoot });
  }, 60_000);

  it.skipIf(process.platform === 'win32')('runs the cached bin while it is there, and the npx command once the cache is gone', async () => {
    const at = await roots();
    const dir = await npxDir(at, 'aaa', 'srv', 'srv', { version: '1.0.0', bin: 'cli.js' }, {
      'cli.js': '#!/usr/bin/env node\nconsole.log(JSON.stringify({ main: require.main === module, argv: process.argv.slice(2) }));\n',
    });
    // Stands in for npx: says what it was asked to run.
    const npx = join(at.cache, '..', 'npx');
    await writeFile(npx, '#!/bin/sh\necho "npx $*"\n');
    await chmod(npx, 0o755);
    const written = await withoutNpx({ name: 'srv', target: npx, args: ['-y', 'srv', '--port', '7'] }, async () => at, { target: process.execPath, args: [entry] });
    const run = async () => (await promisify(execFile)(written.target, [...written.args!])).stdout.trim();
    expect(JSON.parse(await run())).toEqual({ main: true, argv: ['--port', '7'] });
    await rm(join(at.cache, '_npx'), { recursive: true, force: true });
    expect(dir).toContain('_npx');
    expect(await run()).toBe('npx -y srv --port 7');
  }, 30_000);

  it('runs an ES module bin as the main script too', async () => {
    const at = await roots();
    await npxDir(at, 'bbb', 'esm', 'esm', { version: '1.0.0', type: 'module', bin: { esm: 'bin.js' } }, {
      'bin.js': '#!/usr/bin/env node\nimport { argv } from "node:process";\nconsole.log(argv.slice(2).join(" "), import.meta.url.endsWith("/bin.js"));\n',
    });
    const written = await withoutNpx({ name: 'esm', target: 'npx', args: ['-y', 'esm', 'a', 'b'] }, async () => at, { target: process.execPath, args: [entry] });
    expect((await promisify(execFile)(written.target, [...written.args!])).stdout.trim()).toBe('a b true');
  }, 30_000);
});
