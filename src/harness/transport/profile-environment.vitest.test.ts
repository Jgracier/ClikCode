import { describe, expect, it } from 'vitest';
import { nativeProfileEnvironment } from './profile-environment';

describe('native profile environments', () => {
  it('isolates HOME-based profiles through USERPROFILE on native Windows', () => {
    const profile = { env: 'HOME', path: 'C:\\profiles\\one', extraEnv: { TOKEN: 'x' } };
    expect(nativeProfileEnvironment(profile, 'win32')).toEqual({
      HOME: 'C:\\profiles\\one', USERPROFILE: 'C:\\profiles\\one', TOKEN: 'x',
    });
    expect(nativeProfileEnvironment(profile, 'darwin')).toEqual({ HOME: 'C:\\profiles\\one', TOKEN: 'x' });
  });
});

