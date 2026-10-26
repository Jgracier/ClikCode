import { describe, expect, it } from 'vitest';
import { isModelStartPhase, modelStartWord } from './turn-pace.js';

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
