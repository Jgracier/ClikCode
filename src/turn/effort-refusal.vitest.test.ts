import { describe, expect, it } from 'vitest';
import { isEffortRefusal } from './vendor-recovery';

describe('a vendor refusing the reasoning level', () => {
  it('is recognized in the words the CLIs use', () => {
    // Verbatim from Command Code 1.65.2, whose levels vary per model.
    expect(isEffortRefusal(new Error('cmdc exited 1: Unknown effort "medium". Supported: high, max.'))).toBe(true);
    expect(isEffortRefusal(Object.assign(new Error('droid exited 1'), { stderrTail: 'Error: reasoning effort "xhigh" is not supported by this model' }))).toBe(true);
    expect(isEffortRefusal(new Error('Invalid reasoning_effort: ultra'))).toBe(true);
  });

  it('is an ACP session that offers no such level, which the CLI fallback could not take', () => {
    expect(isEffortRefusal(Object.assign(new Error('kimi ACP does not offer effort high'), { acpUnsupportedEffort: true }))).toBe(true);
  });

  it('is not any other failure', () => {
    expect(isEffortRefusal(new Error('Codex: You have exceeded your monthly quota'))).toBe(false);
    expect(isEffortRefusal(new Error('Unknown model "gpt-9"'))).toBe(false);
  });
});

describe('a sign-in nobody can do here', () => {
  it('is recognized by the words a script or a window-less worker answers with', async () => {
    const { signInNotPossibleHere } = await import('./vendor-sign-in');
    expect(signInNotPossibleHere(new Error('Amp is not signed in; run "clikcode accounts login <harness>" in a terminal'))).toBe(true);
    expect(signInNotPossibleHere(new Error('sign in to Amp needs an open ClikCode window'))).toBe(true);
    expect(signInNotPossibleHere(new Error('browser closed before the code arrived'))).toBe(false);
  });
});
