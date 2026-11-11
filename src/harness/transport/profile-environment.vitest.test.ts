import { describe, expect, it } from 'vitest';
import { nativeAccountEnvironment, nativeProfileEnvironment } from './profile-environment.js';
import { stateDirectory } from '../../session/store/paths.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('native profile environments', () => {
  it('isolates HOME-based profiles through USERPROFILE on native Windows', () => {
    const profile = { env: 'HOME', path: 'C:\\profiles\\one', extraEnv: { TOKEN: 'x' } };
    expect(nativeProfileEnvironment(profile, 'win32')).toEqual({
      HOME: 'C:\\profiles\\one', XDG_CONFIG_HOME: 'C:\\profiles\\one/.config',
      XDG_DATA_HOME: 'C:\\profiles\\one/.local/share', XDG_STATE_HOME: 'C:\\profiles\\one/.local/state',
      USERPROFILE: 'C:\\profiles\\one', APPDATA: 'C:\\profiles\\one/AppData/Roaming',
      LOCALAPPDATA: 'C:\\profiles\\one/AppData/Local', TOKEN: 'x',
      // A `clikcode` the harness runs still finds this install.
      CLIKCODE_HOME: stateDirectory(),
    });
    expect(nativeProfileEnvironment(profile, 'darwin')).toMatchObject({ HOME: 'C:\\profiles\\one', XDG_CONFIG_HOME: 'C:\\profiles\\one/.config', TOKEN: 'x' });
  });

  it('only exposes the API key referenced by the selected account', () => {
    const harness = { provider: 'aider', authEnv: ['OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'VERTEXAI_PROJECT'] };
    const account = { authKind: 'api-key' as const, credentialRef: 'env:ANTHROPIC_API_KEY' };
    expect(nativeAccountEnvironment(harness, account)).toEqual({ OPENROUTER_API_KEY: '' });
  });

  it('does not mask provider credentials for native-login accounts', () => {
    expect(nativeAccountEnvironment({ provider: 'anthropic', authEnv: ['ANTHROPIC_API_KEY'] }, {
      authKind: 'vendor-cli', credentialRef: 'native:claude',
    })).toEqual({});
  });

  it('hides exported keys from an account signed in through its own profile', () => {
    const profile = mkdtempSync(join(tmpdir(), 'cc-profile-env-'));
    try {
      const account = { authKind: 'vendor-cli' as const, credentialRef: 'native:claude', nativeProfile: { env: 'CLAUDE_CONFIG_DIR', path: profile } };
      expect(nativeAccountEnvironment({ provider: 'anthropic', authEnv: ['ANTHROPIC_API_KEY'] }, account)).toMatchObject({ ANTHROPIC_API_KEY: '' });
      expect(nativeAccountEnvironment({ provider: 'openai', authEnv: undefined }, { ...account, authKind: 'oauth' })).toMatchObject({ OPENAI_API_KEY: '' });
      // A key pasted into the profile at sign-in is that account's own.
      writeFileSync(join(profile, '.clikcode-key.json'), JSON.stringify({ ANTHROPIC_API_KEY: 'pasted' }));
      expect(nativeAccountEnvironment({ provider: 'anthropic', authEnv: ['ANTHROPIC_API_KEY'] }, account)).toMatchObject({ ANTHROPIC_API_KEY: 'pasted' });
    } finally { rmSync(profile, { recursive: true, force: true }); }
  });
});
