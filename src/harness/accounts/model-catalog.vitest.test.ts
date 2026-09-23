import { describe, expect, it } from 'vitest';
import { nativeModelLabel } from './model-catalog.js';

describe('native model display metadata', () => {
  it('shows a Claude alias as it is named until the installed table has been read', () => {
    // Never a remembered label: before the table is read there is nothing to
    // say what `sonnet` means in THIS build, and a constant is how the picker
    // said "Opus 5" for a release after Opus 5.5 shipped.
    expect(nativeModelLabel('claude', 'sonnet')).toBe('sonnet');
    expect(nativeModelLabel('codex', 'sonnet')).toBe('sonnet');
    expect(nativeModelLabel(undefined, 'custom-model')).toBe('custom-model');
    expect(nativeModelLabel('claude', undefined)).toBeUndefined();
  });
});
