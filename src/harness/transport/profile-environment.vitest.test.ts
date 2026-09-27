import { describe, expect, it } from 'vitest';
import { nativeAccountEnvironment, nativeProfileEnvironment } from './profile-environment';

describe('native profile environments', () => {
  it('isolates HOME-based profiles through USERPROFILE on native Windows', () => {
    const profile = { env: 'HOME', path: 'C:\\profiles\\one', extraEnv: { TOKEN: 'x' } };
    expect(nativeProfileEnvironment(profile, 'win32')).toEqual({
      HOME: 'C:\\profiles\\one', XDG_CONFIG_HOME: 'C:\\profiles\\one/.config',
      XDG_DATA_HOME: 'C:\\profiles\\one/.local/share', XDG_STATE_HOME: 'C:\\profiles\\one/.local/state',
      USERPROFILE: 'C:\\profiles\\one', APPDATA: 'C:\\profiles\\one/AppData/Roaming',
      LOCALAPPDATA: 'C:\\profiles\\one/AppData/Local', TOKEN: 'x',
    });
    expect(nativeProfileEnvironment(profile, 'darwin')).toMatchObject({ HOME: 'C:\\profiles\\one', XDG_CONFIG_HOME: 'C:\\profiles\\one/.config', TOKEN: 'x' });
  });

  it('only exposes the API key referenced by the selected account', () => {
    const harness = { authEnv: ['OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY'] };
    const account = { authKind: 'api-key' as const, credentialRef: 'env:ANTHROPIC_API_KEY' };
    expect(nativeAccountEnvironment(harness, account)).toEqual({ OPENROUTER_API_KEY: '' });
  });

  it('does not mask provider credentials for native-login accounts', () => {
    expect(nativeAccountEnvironment({ authEnv: ['ANTHROPIC_API_KEY'] }, {
      authKind: 'vendor-cli', credentialRef: 'native:claude',
    })).toEqual({});
  });
});
