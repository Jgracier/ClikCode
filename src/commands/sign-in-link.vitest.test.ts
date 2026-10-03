import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withVendorTerminal, type SignInSurface } from './account.js';
import { loginNativeHarness } from '../harness/transport/native/login.js';

describe.skipIf(process.platform === 'win32')('a link sign-in in the CLI', () => {
  let dir: string;
  const display = { DISPLAY: process.env.DISPLAY, WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY };
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'clikcode-link-cli-'));
    // No local browser: nothing may open on the machine running the tests.
    delete process.env.DISPLAY;
    delete process.env.WAYLAND_DISPLAY;
  });
  afterEach(async () => {
    Object.assign(process.env, Object.fromEntries(Object.entries(display).filter(([, value]) => value !== undefined)));
    await rm(dir, { recursive: true, force: true });
  });

  const surface = () => {
    const calls: string[] = [];
    let cancel: (() => void) | undefined;
    const value: SignInSurface = {
      startWaiting: (message) => { calls.push(`wait ${message}`); },
      stopWaiting: () => { calls.push('stop'); },
      suspend: async () => { calls.push('suspend'); },
      resume: () => { calls.push('resume'); },
      activity: (message) => { calls.push(`activity ${message.replace(/\u001b\[[0-9;]*m/g, '')}`); },
      linkWait: (label, onCancel) => {
        calls.push(`linkWait ${label}`);
        cancel = onCancel;
        return {
          show: (lines) => { for (const line of lines) calls.push(`show ${line.replace(/\u001b\[[0-9;]*m/g, '')}`); },
          stop: () => { calls.push('undo'); },
        };
      },
    };
    return { value, calls, cancel: () => cancel?.() };
  };

  const vendor = async (wait: number): Promise<string> => {
    const path = join(dir, 'grok');
    await writeFile(path, `#!/bin/sh\necho "  https://accounts.x.ai/oauth2/device?user_code=5FCB-TTXG"\necho "Confirm this code in your browser:"\necho "  5FCB-TTXG"\nsleep ${wait}\n`);
    await chmod(path, 0o755);
    return path;
  };

  it('keeps ClikCode on screen and shows the link and code, never handing over the terminal', async () => {
    const binary = await vendor(0.5);
    const spec = { command: 'grok', binary, displayName: 'Grok Build', loginArgv: [], loginLink: {} };
    const { value, calls } = surface();
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await withVendorTerminal(value, spec, () => loginNativeHarness(spec, {}));
    } finally { stdout.mockRestore(); }
    expect(calls).not.toContain('suspend');
    expect(calls[0]).toMatch(/^linkWait waiting for you to sign in to Grok Build/);
    expect(calls).toContain('show Sign in to Grok Build · confirm the code 5FCB-TTXG');
    expect(calls).toContain('show https://accounts.x.ai/oauth2/device?user_code=5FCB-TTXG');
    expect(calls).toContain('undo');
    expect(calls.at(-1)).toBe('activity signed in to Grok Build');
  });

  it('cancels on Esc and says the sign-in did not finish', async () => {
    const binary = await vendor(30);
    const spec = { command: 'grok', binary, displayName: 'Grok Build', loginArgv: [], loginLink: {} };
    const { value, calls, cancel } = surface();
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const login = withVendorTerminal(value, spec, () => loginNativeHarness(spec, {}));
    setTimeout(cancel, 1_000);
    try {
      await expect(login).rejects.toThrow(/cancelled/);
    } finally { stdout.mockRestore(); }
    expect(calls.at(-1)).toMatch(/sign-in to Grok Build did not finish/);
  });
});
