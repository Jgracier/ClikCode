import { describe, expect, it } from 'vitest';
import { isModelStartPhase, modelStartWord, waitStalled } from './turn-pace.js';

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

describe('a private model\'s start', () => {
  it('is recognised by what the agent says while it runs', () => {
    for (const phase of ['Finding an available server', 'Finding an available server · 2 min', 'Starting model · about 4 min left', 'Starting model · taking longer than usual · 31 min', 'Starting model · almost ready']) {
      expect(isModelStartPhase(phase)).toBe(true);
    }
    for (const phase of ['thinking', 'generating response', 'waiting for model capacity', undefined]) expect(isModelStartPhase(phase)).toBe(false);
  });

  it('has the short word a conversation row shows', () => {
    expect(modelStartWord('Finding an available server · 1 min')).toBe('finding a server');
    expect(modelStartWord('Starting model · almost ready')).toBe('starting model');
  });
});
