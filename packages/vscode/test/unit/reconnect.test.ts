import { describe, expect, it } from 'vitest';
import { AutoReconnect, RECONNECT_PAUSES_MS, STABLE_MS } from '../../src/controller/reconnect';
import { startLogCause } from '../../src/compat';

describe('a bridge that drops after it was ready', () => {
  it('reconnects at once, then again after a longer pause, instead of ending at the banner on the second drop', () => {
    const reconnect = new AutoReconnect();
    reconnect.ready(0);
    expect(reconnect.next(true, 10_000)).toBe(0);
    // Dropped again while coming back: not ready, but a reconnect is under way.
    expect(reconnect.next(false, 12_000)).toBe(1_000);
    expect(reconnect.next(false, 14_000)).toBe(2_000);
  });

  it('gives up only after every pause is spent, and says nothing of a bridge that never worked', () => {
    const reconnect = new AutoReconnect();
    expect(reconnect.next(false, 0)).toBeUndefined();
    reconnect.ready(0);
    for (const pause of RECONNECT_PAUSES_MS) expect(reconnect.next(true, 1_000)).toBe(pause);
    expect(reconnect.next(true, 1_000)).toBeUndefined();
  });

  it('starts the pauses again once a bridge has stayed up', () => {
    const reconnect = new AutoReconnect();
    reconnect.ready(0);
    reconnect.next(true, 1_000);
    reconnect.next(false, 2_000);
    reconnect.ready(3_000);
    expect(reconnect.next(true, 3_000 + STABLE_MS)).toBe(0);
  });
});

describe('what the banner adds from the bridge\'s output', () => {
  it('is the whole region of what it wrote, wrapped under the words', () => {
    expect(startLogCause(['ssh: connect to host x port 22: Connection reset', 'Killed'])).toBe(':\nssh: connect to host x port 22: Connection reset\nKilled');
    expect(startLogCause([], ' and said nothing')).toBe(' and said nothing');
  });
});
