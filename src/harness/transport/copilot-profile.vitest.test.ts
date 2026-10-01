/** An added Copilot account signs in on its own: inside its profile Copilot
 * cannot borrow the GitHub CLI's login (copilot 1.0.87 runs
 * `gh auth token --hostname github.com` when it has none of its own). */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { nativeProfileEnvironment } from './profile-environment.js';
import { parseCopilotConfig } from '../accounts/vendor-identity.js';

const state = mkdtempSync(join(tmpdir(), 'copilot-profile-'));
process.env.CLIKCODE_HOME = state;
afterAll(() => rmSync(state, { recursive: true, force: true }));

describe.skipIf(process.platform === 'win32')('a Copilot account profile', () => {
  it('puts a gh that refuses `auth token` ahead of the real one, for Copilot only', () => {
    const env = nativeProfileEnvironment({ env: 'COPILOT_HOME', path: '/profiles/copilot/a' });
    expect(env.COPILOT_HOME).toBe('/profiles/copilot/a');
    expect(env.PATH?.split(':')[0]).toBe(join(state, 'tools', 'copilot-gh-shim'));
    expect(nativeProfileEnvironment({ env: 'CODEX_HOME', path: '/profiles/codex/a' }).PATH).toBeUndefined();
  });

  it('refuses only the token and passes every other gh command through', () => {
    const shim = nativeProfileEnvironment({ env: 'COPILOT_HOME', path: '/p' }).PATH!.split(':')[0]!;
    const realBin = mkdtempSync(join(tmpdir(), 'real-gh-'));
    try {
      writeFileSync(join(realBin, 'gh'), '#!/bin/sh\necho "real gh: $*"\n');
      chmodSync(join(realBin, 'gh'), 0o755);
      const run = (...args: string[]) => {
        try { return execFileSync('gh', args, { env: { PATH: `${shim}:${realBin}:/usr/bin:/bin` }, encoding: 'utf8' }); } catch { return 'refused'; }
      };
      expect(run('auth', 'token', '--hostname', 'github.com')).toBe('refused');
      expect(run('pr', 'list')).toBe('real gh: pr list\n');
    } finally { rmSync(realBin, { recursive: true, force: true }); }
  });
});

it('names a Copilot account by the GitHub login it signed in as', () => {
  const config = '// User settings belong in settings.json.\n{"firstLaunchAt":"x","lastLoggedInUser":{"host":"https://github.com","login":"octocat"},"loggedInUsers":[]}';
  expect(parseCopilotConfig(config)).toBe('octocat');
  expect(parseCopilotConfig('{"firstLaunchAt":"x"}')).toBeUndefined();
});
