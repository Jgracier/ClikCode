/** Installing a harness when it is chosen: which route each catalog harness
 * takes on each OS, where its binary is looked for afterwards, and that two
 * installs of the same harness never run at once. The real installs are in
 * install.integration.vitest.test.ts. */
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { allLocalHarnesses } from '@clikcode/router/ai-local-harness';
import { harnessInstallRoute, manualInstallCommand } from './install-route.js';
import { expandInstallDir, harnessInstallDirs, installStepFor, npmPrefixBinDir, withPathDirs } from './install-locations.js';
import { assertInstallerUrl, ensureHarnessInstalled, isPermissionFailure, npmPrefixWritable, withInstallLock } from './install.js';

const PLATFORMS: readonly NodeJS.Platform[] = ['linux', 'darwin', 'win32'];

describe('every catalog harness installs when it is chosen', () => {
  const terminal = allLocalHarnesses().filter((harness) => harness.surface === 'terminal');

  it('has an automatic route on Linux, macOS and Windows', () => {
    const missing = PLATFORMS.flatMap((platform) => terminal
      .filter((harness) => harnessInstallRoute(harness, platform).kind === 'none')
      .map((harness) => `${harness.command} on ${platform}`));
    expect(missing, 'terminal harnesses with no npm package and no declared installer').toEqual([]);
  });

  it('prefers the npm package, and declares an installer only where there is none', () => {
    for (const harness of terminal) {
      expect(Boolean(harness.npmPackage) !== Boolean(harness.installer), `${harness.command}: exactly one of npmPackage / installer`).toBe(true);
    }
  });

  it('only ever runs an https installer, and says where it writes the binary', () => {
    for (const harness of terminal) {
      for (const platform of PLATFORMS) {
        const step = installStepFor(harness.installer, platform);
        if (!step) continue;
        expect(step.binDirs.length, `${harness.command} ${platform} binDirs`).toBeGreaterThan(0);
        if (step.kind === 'script') expect(() => assertInstallerUrl(step.url), `${harness.command} ${platform}`).not.toThrow();
      }
      if (harness.installer) expect(harness.installer.docs).toMatch(/^https:\/\//);
    }
  });

  it('gives an editor extension no route, with the reason', () => {
    const route = harnessInstallRoute({ command: 'ext', binary: 'ext', displayName: 'Some Extension', surface: 'editor-extension', npmPackage: 'ext' });
    expect(route).toMatchObject({ kind: 'none' });
    expect(route.kind === 'none' && route.reason).toContain('editor extension');
  });

  it('gives a custom harness outside the catalog a clear instruction instead of a guess', () => {
    const route = harnessInstallRoute({ command: 'mine', binary: 'mine-acp', displayName: 'Mine', surface: 'terminal' });
    expect(route.kind === 'none' && route.reason).toContain('`mine-acp` command is on PATH');
  });
});

describe('the route for one harness', () => {
  const byCommand = (command: string) => allLocalHarnesses().find((harness) => harness.command === command)!;

  it('runs the vendor script on POSIX and uv on Windows where that is all the vendor ships', () => {
    expect(harnessInstallRoute(byCommand('vibe'), 'linux')).toMatchObject({ kind: 'script', step: { url: 'https://mistral.ai/vibe/install.sh' } });
    expect(harnessInstallRoute(byCommand('vibe'), 'win32')).toMatchObject({ kind: 'uv-tool', step: { package: 'mistral-vibe' } });
    expect(harnessInstallRoute(byCommand('antigravity'), 'win32')).toMatchObject({ kind: 'script', step: { url: 'https://antigravity.google/cli/install.ps1' } });
    expect(harnessInstallRoute(byCommand('opencode'), 'win32')).toEqual({ kind: 'npm', package: 'opencode-ai' });
  });

  it('writes the same install as a command someone could run by hand', () => {
    expect(manualInstallCommand(harnessInstallRoute(byCommand('opencode'), 'linux'), 'linux')).toBe('npm install -g opencode-ai');
    expect(manualInstallCommand(harnessInstallRoute(byCommand('goose'), 'linux'), 'linux'))
      .toBe("curl -fsSL 'https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh' | CONFIGURE=false bash");
    expect(manualInstallCommand(harnessInstallRoute(byCommand('hermes'), 'darwin'), 'darwin'))
      .toBe("curl -fsSL 'https://hermes-agent.nousresearch.com/install.sh' | bash -s -- --non-interactive");
    expect(manualInstallCommand(harnessInstallRoute(byCommand('cursor'), 'win32'), 'win32')).toBe("irm 'https://cursor.com/install?win32=true' | iex");
    expect(manualInstallCommand(harnessInstallRoute(byCommand('openhands'), 'win32'), 'win32')).toBe('uv tool install --python 3.12 openhands');
    expect(manualInstallCommand(harnessInstallRoute(byCommand('dcode'), 'linux'), 'linux')).toBe('uv tool install deepagents-code --with deepagents-acp');
  });
});

describe('where an installed binary is looked for', () => {
  it('expands ~ and ${NAME}, and skips a directory whose variable is unset', () => {
    expect(expandInstallDir('~/.local/bin', {}, '/home/me')).toBe(join('/home/me', '.local/bin'));
    expect(expandInstallDir('${LOCALAPPDATA}/agy/bin', { LOCALAPPDATA: 'C:/Users/me/AppData/Local' })).toBe('C:/Users/me/AppData/Local/agy/bin');
    expect(expandInstallDir('${LocalAppData}/x', { LOCALAPPDATA: 'L' }), 'Windows variables are case-insensitive').toBe('L/x');
    expect(expandInstallDir('${LOCALAPPDATA}/agy/bin', {})).toBeUndefined();
  });

  it('appends, never prepends, so a binary the user put on PATH still wins', () => {
    expect(withPathDirs('/usr/bin:/bin', ['/home/me/.local/bin'], 'linux')).toBe('/usr/bin:/bin:/home/me/.local/bin');
    expect(withPathDirs('/usr/bin:/home/me/.local/bin/', ['/home/me/.local/bin'], 'linux'), 'no duplicate').toBe('/usr/bin:/home/me/.local/bin/');
    expect(withPathDirs('C:\\Windows;C:\\Users\\Me\\.local\\bin', ['c:\\users\\me\\.local\\bin'], 'win32')).toBe('C:\\Windows;C:\\Users\\Me\\.local\\bin');
    expect(withPathDirs('', ['/a'], 'linux')).toBe('/a');
  });

  it('searches every declared directory for the OS and ClikCode\'s own npm prefix', () => {
    const dirs = harnessInstallDirs(allLocalHarnesses(), { platform: 'linux', env: {}, home: '/home/me' });
    expect(dirs).toContain(join('/home/me', '.local/bin'));
    expect(dirs[dirs.length - 1]).toMatch(/tools[\\/]npm[\\/]bin$/);
    const windows = harnessInstallDirs(allLocalHarnesses(), { platform: 'win32', env: { LOCALAPPDATA: 'L', ProgramFiles: 'P' }, home: 'H' });
    expect(windows).toEqual(expect.arrayContaining(['L/cursor-agent', 'L/agy/bin', 'L/hermes/bin', 'P/Kiro-Cli']));
  });

  it('knows npm writes Windows shims into the prefix itself', () => {
    expect(npmPrefixBinDir('/p', 'linux')).toBe(join('/p', 'bin'));
    expect(npmPrefixBinDir('C:\\p', 'win32')).toBe('C:\\p');
  });
});

describe('deciding to fall back to ClikCode\'s own npm prefix', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) { await chmod(dir, 0o755).catch(() => undefined); await rm(dir, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('sees a global prefix this user cannot write', async () => {
    const prefix = await mkdtemp(join(tmpdir(), 'clikcode-ro-prefix-'));
    dirs.push(prefix);
    expect(await npmPrefixWritable(prefix, 'linux'), 'writable while it is ours').toBe(true);
    await chmod(prefix, 0o555);
    expect(await npmPrefixWritable(prefix, 'linux')).toBe(false);
  });

  it('reads npm\'s permission failures as "use another prefix", and nothing else', () => {
    expect(isPermissionFailure('npm error code EACCES\nnpm error syscall mkdir')).toBe(true);
    expect(isPermissionFailure('npm error code EROFS')).toBe(true);
    expect(isPermissionFailure('npm error code E404\nnpm error 404 Not Found')).toBe(false);
    expect(isPermissionFailure('npm error code ENOTFOUND registry.npmjs.org')).toBe(false);
  });
});

describe('what is fetched and run', () => {
  it('refuses anything but https', () => {
    expect(() => assertInstallerUrl('http://example.com/install.sh')).toThrow(/non-https/);
    expect(() => assertInstallerUrl('file:///etc/passwd')).toThrow(/non-https/);
    expect(() => assertInstallerUrl('not a url')).toThrow(/not a URL/);
    expect(assertInstallerUrl('https://cli.kiro.dev/install').host).toBe('cli.kiro.dev');
  });
});

describe('one install at a time', () => {
  let root: string;
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

  it('makes a second install of the same harness wait for the first', async () => {
    root = await mkdtemp(join(tmpdir(), 'clikcode-lock-'));
    const events: string[] = [];
    let waited = 0;
    const slow = (name: string) => async () => {
      events.push(`${name} start`);
      await new Promise((resolve) => setTimeout(resolve, 150));
      events.push(`${name} end`);
      return name;
    };
    const options = { directory: root, pollMs: 20 };
    const first = withInstallLock('opencode', slow('first'), undefined, options);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = withInstallLock('opencode', slow('second'), () => { waited += 1; }, options);
    expect(await Promise.all([first, second])).toEqual(['first', 'second']);
    expect(events).toEqual(['first start', 'first end', 'second start', 'second end']);
    expect(waited).toBe(1);
  });

  it('takes over a lock whose holder died', async () => {
    root = await mkdtemp(join(tmpdir(), 'clikcode-lock-'));
    await mkdir(join(root, 'opencode.lock'));
    // A pid that is not running: far above any real pid range.
    await writeFile(join(root, 'opencode.lock', 'owner.json'), JSON.stringify({ pid: 2 ** 22 + 12345, at: Date.now() }));
    let waited = false;
    expect(await withInstallLock('opencode', async () => 'mine', () => { waited = true; }, { directory: root, pollMs: 20 })).toBe('mine');
    expect(waited).toBe(false);
  });

  it('takes over a lock held past any install\'s time limit', async () => {
    root = await mkdtemp(join(tmpdir(), 'clikcode-lock-'));
    await mkdir(join(root, 'opencode.lock'));
    await writeFile(join(root, 'opencode.lock', 'owner.json'), JSON.stringify({ pid: process.pid, at: Date.now() - 60_000 }));
    expect(await withInstallLock('opencode', async () => 'mine', undefined, { directory: root, pollMs: 20, staleMs: 1_000 })).toBe('mine');
  });
});

describe('ensureHarnessInstalled', () => {
  it('does nothing, and shows nothing, for a harness already on PATH', async () => {
    const shown: string[] = [];
    const reporter = { start: (label: string) => shown.push(label), done: (message: string) => shown.push(message), failed: (message: string) => shown.push(message) };
    expect(await ensureHarnessInstalled({ command: 'node', binary: 'node', displayName: 'Node', surface: 'terminal', npmPackage: 'node' }, { reporter })).toBe(false);
    expect(shown).toEqual([]);
  });

  it('refuses an editor extension with the reason', async () => {
    await expect(ensureHarnessInstalled({ command: 'ext', binary: 'ext', displayName: 'Ext', surface: 'editor-extension' })).rejects.toThrow(/editor extension/);
  });

  it('says what to do for a missing harness it has no installer for', async () => {
    const reporter = { start: () => undefined, done: () => undefined, failed: () => undefined };
    await expect(ensureHarnessInstalled({ command: 'nope', binary: 'clikcode-no-such-binary', displayName: 'Nope', surface: 'terminal' }, { reporter }))
      .rejects.toThrow(/`clikcode-no-such-binary` command is on PATH\. Then retry \/nope\./);
  });
});

describe('withInstallLock deadline', () => {
  it('gives up with a clear error when a live holder outlasts the maximum wait', async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { withInstallLock } = await import('./install.js');
    const directory = await mkdtemp(join(tmpdir(), 'clikcode-install-lock-'));
    try {
      const lock = join(directory, 'hung.lock');
      await mkdir(lock);
      await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, at: Date.now() }));
      await expect(withInstallLock('hung', async () => 'ran', undefined, { directory, pollMs: 5, maxWaitMs: 50 }))
        .rejects.toThrow(/still running/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
