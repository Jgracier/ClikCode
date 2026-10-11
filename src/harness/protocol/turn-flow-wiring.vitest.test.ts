/** Capabilities a harness declares must be wired from its wire to the
 * surfaces, not only parsed: a parser that reads `reasoning` events is no use
 * when the turn argv never asks the CLI for them. */
import { describe, expect, it } from 'vitest';
import { AI_LOCAL_HARNESSES } from '@clikcode/router/ai-local-harness';

describe('the structured-CLI path asks for what the harness declares', () => {
  it('opencode-json: thinking is only printed when `run --thinking` is passed (verified in opencode 1.x and kilo 7.x `run --help`)', () => {
    const family = AI_LOCAL_HARNESSES.filter((harness) => harness.parser === 'opencode-json');
    expect(family.length).toBeGreaterThan(0);
    for (const harness of family) {
      if (!harness.capabilities?.thinking) continue;
      expect(harness.turn.startArgv, `${harness.command}: declares thinking but its CLI turn never requests reasoning`).toContain('--thinking');
    }
  });
});
