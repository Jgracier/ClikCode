import { describe, expect, it } from 'vitest';
import { isTurboFitModel } from './turbofit-local';
import { TURBOFIT_PLAN_SCRIPT, TURBOFIT_SUPERVISOR_SCRIPT } from './turbofit-scripts';

describe('turbofit local models', () => {
  it('knows which Hermes model ids run on the TurboFit gateway', () => {
    expect(isTurboFitModel('turbofit:auto')).toBe(true);
    expect(isTurboFitModel('turbofit:active:main')).toBe(true);
    expect(isTurboFitModel('custom:turbofit:active:aux')).toBe(true);
    expect(isTurboFitModel('openai-codex:gpt-6-astra')).toBe(false);
    expect(isTurboFitModel('openrouter:turbofit-lookalike')).toBe(false);
    expect(isTurboFitModel(null)).toBe(false);
  });

  it('keeps its Python verbatim: the markers ClikCode parses reach Python as escapes', () => {
    // String.raw: `\x00` must arrive as a Python escape, not a NUL in the source.
    expect(TURBOFIT_PLAN_SCRIPT).toContain('"\\x00TURBOFIT_PLAN"');
    expect(TURBOFIT_PLAN_SCRIPT).not.toContain('\x00');
    expect(TURBOFIT_SUPERVISOR_SCRIPT).toContain('clikcode-leases');
    expect(TURBOFIT_SUPERVISOR_SCRIPT).toContain('llama-server');
  });
});
