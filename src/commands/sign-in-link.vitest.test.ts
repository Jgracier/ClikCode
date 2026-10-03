import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withSignIn } from './account.js';
import type { SignInScreen } from '../gateway/login/vendor-sign-in.js';
import { loginNativeHarness } from '../harness/transport/native/login.js';

describe.skipIf(process.platform === 'win32')('a sign-in on the prompter\'s own screen', () => {
  let dir: string;
  const display = { DISPLAY: process.env.DISPLAY, WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY };
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'clikcode-sign-in-cli-'));
    // No local browser: nothing may open on the machine running the tests.
    delete process.env.DISPLAY;
    delete process.env.WAYLAND_DISPLAY;
  });
  afterEach(async () => {
    Object.assign(process.env, Object.fromEntries(Object.entries(display).filter(([, value]) => value !== undefined)));
    await rm(dir, { recursive: true, force: true });
  });

  const prompter = () => {
    const calls: string[] = [];
    const controller = new AbortController();
    const screen: SignInScreen = {
      signal: controller.signal,
      show: (link) => { calls.push(`show ${link.url} ${link.code ?? ''}`.trim()); },
      ask: async (prompt) => { calls.push(`ask ${prompt}`); return ''; },
      choose: async () => undefined,
      stop: () => { calls.push('stop'); },
    };
    return {
      value: {
        signInScreen: (name: string) => { calls.push(`screen ${name}`); return screen; },
        activity: (message: string) => { calls.push(`activity ${message.replace(/\u001b\[[0-9;]*m/g, '')}`); },
      },
      calls,
      cancel: () => controller.abort(),
    };
  };

  const vendor = async (wait: number): Promise<string> => {
    const path = join(dir, 'grok');
    await writeFile(path, `#!/bin/sh\necho "  https://accounts.x.ai/oauth2/device?user_code=5FCB-TTXG"\necho "Confirm this code in your browser:"\necho "  5FCB-TTXG"\nsleep ${wait}\n`);
    await chmod(path, 0o755);
    return path;
  };

  it('shows the link and code on that screen, takes it down, and says how it went', async () => {
    const spec = { command: 'grok', binary: await vendor(0.5), displayName: 'Grok Build', loginArgv: [] };
    const { value, calls } = prompter();
    await withSignIn(value, 'Grok Build', () => loginNativeHarness(spec, {}));
    expect(calls).toEqual([
      'screen Grok Build',
      'show https://accounts.x.ai/oauth2/device?user_code=5FCB-TTXG 5FCB-TTXG',
      'stop',
      'activity signed in to Grok Build',
    ]);
  });

  it('cancels from the screen and says the sign-in did not finish', async () => {
    const spec = { command: 'grok', binary: await vendor(30), displayName: 'Grok Build', loginArgv: [] };
    const { value, calls, cancel } = prompter();
    const login = withSignIn(value, 'Grok Build', () => loginNativeHarness(spec, {}));
    setTimeout(cancel, 1_000);
    await expect(login).rejects.toThrow(/cancelled/);
    expect(calls.at(-2)).toBe('stop');
    expect(calls.at(-1)).toMatch(/sign-in to Grok Build did not finish/);
  });
});
