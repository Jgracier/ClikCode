import { describe, expect, it } from 'vitest';
import { harnessModelLabel, modelSettingsDetail, rememberVendorModelNames } from './model-catalog.js';
import type { AiLocalHarnessDefinition } from '../definition.js';

// Cursor Agent's ACP model list, 2026-09-30.
const cursor = { command: 'cursor', provider: 'cursor', displayName: 'Cursor Agent' } as AiLocalHarnessDefinition;

describe('bracketed vendor model ids', () => {
  it('reads as the vendor names them once the list is known, the bare id before', () => {
    expect(harnessModelLabel(cursor, 'default[]')).toBe('default');
    expect(harnessModelLabel(cursor, 'claude-opus-5-5[context=300k,effort=medium,fast=false]')).toBe('claude-opus-5-5');
    rememberVendorModelNames(cursor, { labels: { 'default[]': 'Auto', 'claude-opus-5-5[context=300k,effort=medium,fast=false]': 'claude-opus-5-5' } });
    expect(harnessModelLabel(cursor, 'default[]')).toBe('Auto');
  });

  it('spells out the variant settings, leaving out flags that are off', () => {
    expect(modelSettingsDetail('claude-opus-5-5[context=300k,effort=medium,fast=false]')).toBe('300k context · effort medium');
    expect(modelSettingsDetail('grok-4.7[context=256k,reasoning_effort=high,fast=true]')).toBe('256k context · reasoning effort high · fast');
    expect(modelSettingsDetail('claude-opus-4-5[thinking=true]')).toBe('thinking');
    expect(modelSettingsDetail('default[]')).toBeUndefined();
    expect(modelSettingsDetail('gpt-5.5')).toBeUndefined();
  });
});
