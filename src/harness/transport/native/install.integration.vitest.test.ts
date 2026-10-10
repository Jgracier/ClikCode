/** Real installs through real npm, into a machine whose global npm prefix
 * this user cannot write -- a system Node, or the unprivileged user of a
 * container (ClikDeploy's publish runner was one: OpenCode never installed
 * there, and the editor's integration test waited ten minutes for it).
 *
 * HOME, CLIKCODE_HOME and the npm cache are throwaway directories, and the
 * global prefix is a read-only one, so nothing here touches the machine's
 * own npm or harnesses. The always-run case installs a tiny package packed
 * on the spot, so it needs no network; CLIKCODE_REAL_INSTALL=1 adds the real
 * OpenCode package from the registry. */
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { localHarnessForCommand } from '@clikcode/router/ai-local-harness';
import { resolveBinaryPath } from './binary.js';
import { ensureHarnessInstalled, type HarnessInstallReporter } from './install.js';
import { managedNpmPrefix, npmPrefixBinDir } from './install-locations.js';

const unprivileged = process.platform !== 'win32' && process.getuid?.() !== 0;
let npmAvailable = true;
try { execFileSync('npm', ['--version'], { stdio: 'ignore' }); } catch { npmAvailable = false; }

function recorder(): HarnessInstallReporter & { events: string[] } {
  const events: string[] = [];
  return {
    events,
    start: (label) => events.push(`start ${label}`),
    done: (message) => events.push(`done ${message}`),
    failed: (message) => events.push(`failed ${message}`),
  };
}

describe.runIf(unprivileged && npmAvailable)('installing an npm harness when the global prefix is not writable', () => {
  const saved = { ...process.env };
  let root: string;
  let readOnlyPrefix: string;
  let tarball: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'clikcode-install-it-'));
    readOnlyPrefix = join(root, 'system-prefix');
    await mkdir(join(readOnlyPrefix, 'lib', 'node_modules'), { recursive: true });
    await mkdir(join(readOnlyPrefix, 'bin'), { recursive: true });
    for (const dir of [join(readOnlyPrefix, 'lib', 'node_modules'), join(readOnlyPrefix, 'lib'), join(readOnlyPrefix, 'bin'), readOnlyPrefix]) await chmod(dir, 0o555);
    for (const key of Object.keys(process.env)) if (/^npm_config_/i.test(key)) delete process.env[key];
    Object.assign(process.env, {
      HOME: join(root, 'home'),
      USERPROFILE: join(root, 'home'),
      CLIKCODE_HOME: join(root, 'clikcode'),
      NPM_CONFIG_PREFIX: readOnlyPrefix,
      NPM_CONFIG_CACHE: join(root, 'npm-cache'),
      NPM_CONFIG_UPDATE_NOTIFIER: 'false',
      NPM_CONFIG_FUND: 'false',
      NPM_CONFIG_AUDIT: 'false',
    });
    // PATH down to node, npm and the system: a harness this machine really
    // has installed (in ~/.local/bin, say) must not answer for the test.
    process.env.PATH = [dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'].join(delimiter);
    await mkdir(process.env.HOME!, { recursive: true });
    // A harness-shaped package: one bin, packed the way the registry serves it.
    const pkg = join(root, 'pkg');
    await mkdir(pkg);
    await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: 'clikcode-fake-harness', version: '1.2.3', bin: { 'clikcode-fake-harness': 'cli.js' } }));
    await writeFile(join(pkg, 'cli.js'), '#!/usr/bin/env node\nconsole.log("fake harness 1.2.3");\n');
    execFileSync('npm', ['pack', '--pack-destination', root], { cwd: pkg, stdio: 'ignore' });
    tarball = join(root, 'clikcode-fake-harness-1.2.3.tgz');
  }, 120_000);

  afterAll(async () => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    for (const dir of [join(readOnlyPrefix, 'lib', 'node_modules'), join(readOnlyPrefix, 'lib'), join(readOnlyPrefix, 'bin'), readOnlyPrefix]) await chmod(dir, 0o755).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  it('installs into ClikCode\'s own prefix, finds the binary there, and runs it', async () => {
    const spec = { command: 'fake', binary: 'clikcode-fake-harness', displayName: 'Fake Harness', npmPackage: tarball };
    expect(await resolveBinaryPath(spec.binary), 'not installed to begin with').toBeUndefined();
    const reporter = recorder();
    // Two turns choosing it at once: one install, both get the harness.
    const [first, second] = await Promise.all([ensureHarnessInstalled(spec, { reporter }), ensureHarnessInstalled(spec, { reporter })]);
    expect(first && second).toBe(true);
    expect(reporter.events).toEqual(['start installing Fake Harness…', 'done Installed Fake Harness.']);

    const found = await resolveBinaryPath(spec.binary);
    expect(found?.startsWith(npmPrefixBinDir(managedNpmPrefix()))).toBe(true);
    expect(managedNpmPrefix().startsWith(join(root, 'clikcode'))).toBe(true);
    expect(execFileSync(spec.binary, { encoding: 'utf8' }).trim(), 'spawned by name through PATH').toBe('fake harness 1.2.3');
    expect(await readdir(join(readOnlyPrefix, 'lib', 'node_modules')), 'the global prefix is untouched').toEqual([]);

    // Chosen again: already there, nothing shown, nothing run.
    const again = recorder();
    expect(await ensureHarnessInstalled(spec, { reporter: again })).toBe(false);
    expect(again.events).toEqual([]);
  }, 120_000);

  it('reports an npm failure with its tail and the command to run by hand', async () => {
    const spec = { command: 'broken', binary: 'clikcode-no-such-harness', displayName: 'Broken', npmPackage: join(root, 'does-not-exist.tgz') };
    const reporter = recorder();
    const failure = await ensureHarnessInstalled(spec, { reporter }).then(() => undefined, (error: Error) => error);
    expect(failure?.message).toMatch(/^Could not install Broken automatically: npm install --global --prefix .+ exited \d+/);
    expect(failure?.message).toContain(`npm install -g ${spec.npmPackage}`);
    expect(failure?.message).toContain('Then retry /broken.');
    expect(reporter.events[0]).toBe('start installing Broken…');
    expect(reporter.events[1]).toMatch(/^failed Could not install Broken/);
  }, 120_000);

  it.runIf(process.env.CLIKCODE_REAL_INSTALL === '1')('installs the real OpenCode from the registry the same way', async () => {
    const opencode = localHarnessForCommand('opencode')!;
    expect(opencode.npmPackage).toBe('opencode-ai');
    expect(await resolveBinaryPath('opencode'), 'not installed to begin with').toBeUndefined();
    const reporter = recorder();
    expect(await ensureHarnessInstalled(opencode, { reporter })).toBe(true);
    expect((await resolveBinaryPath('opencode'))?.startsWith(npmPrefixBinDir(managedNpmPrefix()))).toBe(true);
    expect(execFileSync('opencode', ['--version'], { encoding: 'utf8' }).trim()).toMatch(/^\d+\.\d+\.\d+/);
  }, 300_000);
});
