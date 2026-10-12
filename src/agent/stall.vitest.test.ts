import { describe, expect, it } from 'vitest';
import { StallGuard, STALL_LIMIT } from './stall.js';

const fail = { failed: true, mayChangeState: false };
const okRead = { failed: false, mayChangeState: false };
const okWrite = { failed: false, mayChangeState: true };

describe('StallGuard', () => {
  it(`flags a call that has failed ${STALL_LIMIT} times in a row with nothing changed`, () => {
    const guard = new StallGuard();
    expect(guard.record('read\0a', fail)).toBe(false);
    expect(guard.record('read\0a', fail)).toBe(false);
    expect(guard.record('read\0a', fail)).toBe(true);
  });

  it('counts each call (name and arguments) against itself only', () => {
    const guard = new StallGuard();
    for (let i = 0; i < STALL_LIMIT - 1; i++) { guard.record('read\0a', fail); guard.record('read\0b', fail); }
    expect(guard.record('read\0a', fail)).toBe(true);
    expect(new StallGuard().record('read\0b', fail)).toBe(false);
  });

  it('forgets every earlier failure when a write or command succeeds: edit, rerun, edit, rerun is the normal loop', () => {
    const guard = new StallGuard();
    for (let round = 0; round < 10; round++) {
      expect(guard.record('bash\0npm test', fail)).toBe(false);
      expect(guard.record('bash\0npm test', fail)).toBe(false);
      expect(guard.record('edit\0fix', okWrite)).toBe(false);
    }
  });

  it('forgets only its own failures when a read succeeds', () => {
    const guard = new StallGuard();
    guard.record('read\0a', fail); guard.record('read\0a', fail);
    guard.record('read\0b', fail); guard.record('read\0b', fail);
    expect(guard.record('read\0b', okRead)).toBe(false);
    expect(guard.record('read\0a', fail)).toBe(true);
    expect(guard.record('read\0b', fail)).toBe(false);
  });
});
