import { describe, expect, it } from 'vitest';
import { echoesRefusal } from './vendor-turn.js';

describe('an attempt whose only text is the refusal it failed with', () => {
  const refusal = new Error("Internal error: You've hit your session limit · resets 3:50pm (America/Denver)");

  it('is the refusal, as Claude streams it before failing the prompt', () => {
    expect(echoesRefusal("You've hit your session limit · resets 3:50pm (America/Denver)", refusal)).toBe(true);
    expect(echoesRefusal("You've hit your session limit · resets 3:50pm (America/Denver)\n\n", refusal)).toBe(true);
  });

  it('is an answer when it says anything else', () => {
    expect(echoesRefusal('I checked the build and the tests pass.', refusal)).toBe(false);
    expect(echoesRefusal('', refusal)).toBe(false);
  });
});
