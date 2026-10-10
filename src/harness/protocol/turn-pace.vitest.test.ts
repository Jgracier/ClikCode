import { describe, expect, it } from 'vitest';
import { waitStalled } from './turn-pace.js';

const LONG = 4 * 60_000;

describe('a stalled wait', () => {
  it('is a conversation turn gone quiet for three minutes', () => {
    expect(waitStalled({ conversationTurn: true, onUser: false, cancelled: false, quietMs: LONG })).toBe(true);
    expect(waitStalled({ conversationTurn: true, onUser: false, cancelled: false, quietMs: 60_000 })).toBe(false);
  });

  it('is never a download, an install or a shell command, however long it runs', () => {
    expect(waitStalled({ conversationTurn: false, onUser: false, cancelled: false, quietMs: LONG })).toBe(false);
  });

  it('is never a wait on the user, nor a turn already stopping', () => {
    expect(waitStalled({ conversationTurn: true, onUser: true, cancelled: false, quietMs: LONG })).toBe(false);
    expect(waitStalled({ conversationTurn: true, onUser: false, cancelled: true, quietMs: LONG })).toBe(false);
  });
});
