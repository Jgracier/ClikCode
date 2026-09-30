import { describe, expect, it } from 'vitest';
import { isEffortRefusal } from './vendor-turn';

describe('a vendor refusing the reasoning level', () => {
  it('is recognized in the words the CLIs use', () => {
    // Verbatim from Command Code 1.65.2, whose levels vary per model.
    expect(isEffortRefusal(new Error('cmdc exited 1: Unknown effort "medium". Supported: high, max.'))).toBe(true);
    expect(isEffortRefusal(Object.assign(new Error('droid exited 1'), { stderrTail: 'Error: reasoning effort "xhigh" is not supported by this model' }))).toBe(true);
    expect(isEffortRefusal(new Error('Invalid reasoning_effort: ultra'))).toBe(true);
  });

  it('is not any other failure', () => {
    expect(isEffortRefusal(new Error('Codex: You have exceeded your monthly quota'))).toBe(false);
    expect(isEffortRefusal(new Error('Unknown model "gpt-9"'))).toBe(false);
  });
});
