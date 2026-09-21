import { describe, expect, it } from 'vitest';
import { nativeModelLabel } from './model-catalog.js';

describe('native model display metadata', () => {
  it('keeps provider-specific aliases behind the model-catalog boundary', () => {
    expect(nativeModelLabel('claude', 'sonnet')).toBe('Sonnet 5');
    expect(nativeModelLabel('codex', 'sonnet')).toBe('sonnet');
    expect(nativeModelLabel(undefined, 'custom-model')).toBe('custom-model');
    expect(nativeModelLabel('claude', undefined)).toBeUndefined();
  });
});
