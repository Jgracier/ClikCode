/** "All harnesses should only open sign in when a user is adding an account."
 * What ClikCode runs on its own decides sign-in state from the files the
 * vendor keeps, and starts no vendor for a profile with none. */
import { chmod, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { AiLocalHarnessDefinition } from '../definition.js';
import { vendorAccountEmail } from './vendor-identity.js';
import { backoffMs, clearBackgroundBackoff, heldOff, recordBackgroundOutcome } from './background-outcome.js';

const SOURCE = fileURLToPath(new URL('../../', import.meta.url));

async function sources(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await sources(path));
    else if (entry.name.endsWith('.ts') && !entry.name.includes('.vitest.') && !entry.name.includes('.test.')) found.push(path);
  }
  return found;
}

describe('the runner nothing in the background may bypass', () => {
  it('captureNativeHarnessOutput is reached only from user-initiated steps', async () => {
    // A turn creating the vendor's session, a sign-in storing a pasted key,
    // a sign-out. Everything else runs through vendor-probe.ts, whose gate
    // refuses a profile with no sign-in. A new caller belongs there.
    const allowed = new Set([
      'harness/transport/native/command.ts',
      'harness/transport/native/login.ts',
      'harness/accounts/auth-files.ts',
      'turn/vendor-cli-attempt.ts',
    ]);
    const callers: string[] = [];
    for (const file of await sources(SOURCE)) {
      if (/\bcaptureNativeHarness(?:Output)?\b/.test(await readFile(file, 'utf8'))) callers.push(relative(SOURCE, file).split('\\').join('/'));
    }
    expect(callers.filter((file) => !allowed.has(file))).toEqual([]);
  });
});

describe.skipIf(process.platform === 'win32')('identity checks read evidence before any vendor runs', () => {
  const saved = process.env.FAKE_KIRO_HOME;
  afterEach(() => { if (saved === undefined) delete process.env.FAKE_KIRO_HOME; else process.env.FAKE_KIRO_HOME = saved; });

  it('never runs `whoami` for a profile with no credential, and does once one is there', async () => {
    const root = await mkdtemp(join(tmpdir(), 'identity-'));
    const marker = join(root, 'ran');
    const binary = join(root, 'kiro-cli');
    await writeFile(binary, `#!/bin/sh\ntouch ${marker}\necho '{"email":"someone@example.com"}'\n`);
    await chmod(binary, 0o755);
    process.env.FAKE_KIRO_HOME = root;
    const harness = { command: 'kiro', binary, displayName: 'Kiro CLI', authFiles: [{ path: '${FAKE_KIRO_HOME}/data.sqlite3', contains: 'kirocli:social:token' }] } as unknown as AiLocalHarnessDefinition;
    expect(await vendorAccountEmail(harness, undefined)).toBeUndefined();
    await expect(stat(marker)).rejects.toThrow();
    await writeFile(join(root, 'data.sqlite3'), 'kirocli:social:token');
    expect(await vendorAccountEmail(harness, undefined)).toBe('someone@example.com');
    expect((await stat(marker)).isFile()).toBe(true);
  });
});

describe('failed background runs are held off', () => {
  afterEach(() => clearBackgroundBackoff());

  it('5 minutes after a first failure, doubling, at most 6 hours, and an answer clears it', async () => {
    expect([1, 2, 3].map(backoffMs)).toEqual([5 * 60_000, 10 * 60_000, 20 * 60_000]);
    expect(backoffMs(20)).toBe(6 * 3_600_000);
    const now = Date.now();
    expect(await heldOff('q', now)).toBe(false);
    await recordBackgroundOutcome('q', 'failed', now);
    expect(await heldOff('q', now + 4 * 60_000)).toBe(true);
    await recordBackgroundOutcome('q', 'failed', now);
    expect(await heldOff('q', now + 9 * 60_000)).toBe(true);
    expect(await heldOff('q', now + 10 * 60_000 + 1)).toBe(false);
    // A signed-out refusal started nothing: not a failure, no hold.
    await recordBackgroundOutcome('signed-out-q', 'signed-out', now);
    expect(await heldOff('signed-out-q', now)).toBe(false);
    await recordBackgroundOutcome('q', 'ok', now);
    expect(await heldOff('q', now)).toBe(false);
  });
});
