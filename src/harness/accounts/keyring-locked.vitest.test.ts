import { describe, expect, it } from 'vitest';
import { lockedKeyringMessage, lockedReading } from './keyring-locked.js';

describe('keyring lock state', () => {
  it('reads busctl variant booleans', () => {
    expect(lockedReading('v b true\n')).toBe(true);
    expect(lockedReading('v b false\n')).toBe(false);
    expect(lockedReading('')).toBe(false);
  });
  it('names the locked keyring and the way out', () => {
    expect(lockedKeyringMessage('Factory Droid')).toMatch(/Factory Droid did not start: the system keyring is locked.*Unlock it/);
  });
});
