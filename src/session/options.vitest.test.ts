/** Validation and lookup for a session's harness options.
 *
 * These are the pure functions a `/settings` write and a `/option` write both
 * go through before a value ever reaches a session record: parsing a raw
 * string against an option's declared kind, validating a default-settings
 * key/value pair, applying a parsed value to the right session field, and
 * resolving an option id (or one of its aliases) against a harness's
 * published manifest.
 *
 * `sessionPickerOptions`, `providerPickerOptions` and `accountPickerOptions`
 * are out of scope here and remain uncovered as a follow-up. */
import { describe, expect, it, vi } from 'vitest';

// The router runtime is a separately bundled .cjs that unit tests do not
// build; only the catalog lookups these functions call are needed here, and
// each test configures them directly.
const harnessSupportsEffort = vi.fn<(harness: unknown) => boolean>(() => true);
const harnessSupportsPermissionMode = vi.fn<(harness: unknown, mode: unknown) => boolean>(() => true);
let capabilityManifest: { options: unknown[] } = { options: [] };

vi.mock('../runtime/lazy-bridge', () => ({
  localRouter: () => ({ AI_LOCAL_HARNESSES: [] }),
  localHarnessForCommand: () => undefined,
  localHarnessForProvider: () => undefined,
  localHarnessCapabilityManifest: () => capabilityManifest,
  harnessSupportsEffort: (harness: unknown) => harnessSupportsEffort(harness),
  harnessSupportsPermissionMode: (harness: unknown, mode: unknown) => harnessSupportsPermissionMode(harness, mode),
  harnessSupportsImages: () => false,
  harnessIntegrationLevel: () => 'basic',
  streamLocalAiTurn: async () => ({}),
}));

import {
  applyDefaultSetting, normalizeFailoverWord, optionForControl, optionForHarness,
  parseHarnessOption, setSessionHarnessOption, VALID_EFFORTS, VALID_PERMISSION_MODES,
} from './options';
import type {
  AiHarnessOptionDefinition, AiLocalHarnessDefinition, HarnessDefaultSettings, HarnessSession,
} from '../harness/types.js';

const option = (overrides: Partial<AiHarnessOptionDefinition>): AiHarnessOptionDefinition => ({
  id: 'flag', label: 'Flag', description: 'a flag', category: 'general', kind: 'boolean',
  ...overrides,
});

const harness = (overrides: Partial<AiLocalHarnessDefinition> = {}): AiLocalHarnessDefinition => ({
  command: 'acme', provider: 'acme', displayName: 'Acme CLI', surface: 'terminal',
  localAuth: ['api-key'], binary: 'acme',
  ...overrides,
} as AiLocalHarnessDefinition);

const session = (overrides: Partial<HarnessSession> = {}): HarnessSession => ({
  id: 'sess-1', conversationId: 'sess-1', route: 'local', accountId: null,
  provider: 'acme', model: null, effort: 'medium', permissionMode: 'ask',
  accountFailover: 'on-quota-exhausted',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', status: 'active',
  ...overrides,
});

describe('parseHarnessOption', () => {
  describe('boolean', () => {
    const boolOption = option({ id: 'stream', label: 'Stream', kind: 'boolean' });

    it.each(['true', 'on', 'yes', '1', 'enabled', 'TRUE'])('parses %s as true', (raw) => {
      expect(parseHarnessOption(boolOption, raw)).toBe(true);
    });

    it.each(['false', 'off', 'no', '0', 'disabled'])('parses %s as false', (raw) => {
      expect(parseHarnessOption(boolOption, raw)).toBe(false);
    });

    it('rejects a value that is neither on nor off', () => {
      expect(() => parseHarnessOption(boolOption, 'maybe')).toThrow('Stream must be on or off');
    });
  });

  describe('number', () => {
    const numberOption = option({ id: 'max-turns', label: 'Max turns', kind: 'number' });

    it('parses a non-negative number', () => {
      expect(parseHarnessOption(numberOption, '5')).toBe(5);
    });

    it('parses zero', () => {
      expect(parseHarnessOption(numberOption, '0')).toBe(0);
    });

    it('rejects a negative number', () => {
      expect(() => parseHarnessOption(numberOption, '-1')).toThrow('Max turns must be a non-negative number');
    });

    it('rejects a non-finite value', () => {
      expect(() => parseHarnessOption(numberOption, 'not-a-number')).toThrow('Max turns must be a non-negative number');
    });
  });

  describe('string-list and path-list', () => {
    it('splits a comma-separated string-list, trimming entries', () => {
      const listOption = option({ id: 'allowed-tools', label: 'Allowed tools', kind: 'string-list' });
      expect(parseHarnessOption(listOption, 'read, write , exec')).toEqual(['read', 'write', 'exec']);
    });

    it('drops empty entries from a string-list', () => {
      const listOption = option({ id: 'allowed-tools', label: 'Allowed tools', kind: 'string-list' });
      expect(parseHarnessOption(listOption, 'read,,write')).toEqual(['read', 'write']);
    });

    it('rejects a string-list with no surviving values', () => {
      const listOption = option({ id: 'allowed-tools', label: 'Allowed tools', kind: 'string-list' });
      expect(() => parseHarnessOption(listOption, ' , ,')).toThrow('Allowed tools requires at least one value');
    });

    it('splits a comma-separated path-list the same way', () => {
      const pathOption = option({ id: 'add-dir', label: 'Additional directories', kind: 'path-list' });
      expect(parseHarnessOption(pathOption, '/a,/b')).toEqual(['/a', '/b']);
    });

    it('rejects an empty path-list', () => {
      const pathOption = option({ id: 'add-dir', label: 'Additional directories', kind: 'path-list' });
      expect(() => parseHarnessOption(pathOption, '')).toThrow('Additional directories requires at least one value');
    });
  });

  describe('enum', () => {
    const enumOption = option({ id: 'mode', label: 'Mode', kind: 'enum', values: ['plan', 'edit'] });

    it('accepts a declared value', () => {
      expect(parseHarnessOption(enumOption, 'plan')).toBe('plan');
    });

    it('rejects a value outside the declared set', () => {
      expect(() => parseHarnessOption(enumOption, 'yolo')).toThrow('Mode must be one of plan, edit');
    });
  });

  describe('plain string', () => {
    const stringOption = option({ id: 'title', label: 'Title', kind: 'string' });

    it('accepts a non-empty string', () => {
      expect(parseHarnessOption(stringOption, 'my session')).toBe('my session');
    });

    it('rejects an empty string', () => {
      expect(() => parseHarnessOption(stringOption, '   ')).toThrow('Title cannot be empty');
    });
  });
});

describe('normalizeFailoverWord', () => {
  it('maps auto to on-quota-exhausted', () => {
    expect(normalizeFailoverWord('auto')).toBe('on-quota-exhausted');
  });

  it('leaves never as never', () => {
    expect(normalizeFailoverWord('never')).toBe('never');
  });

  it('rejects anything else', () => {
    expect(() => normalizeFailoverWord('sometimes')).toThrow('failover must be auto or never');
  });
});

describe('applyDefaultSetting', () => {
  // `'model' in target` is an own-property check, so a target that CAN carry
  // a model must actually have the key present (even as undefined) for the
  // special-case branch to engage -- this is how the provider-scoped path
  // (which does carry `model`) differs from the global-settings path (which
  // does not).
  const settings = (): Partial<HarnessDefaultSettings & { model: string }> => ({ model: undefined });

  it('treats model auto as clearing the default when the target has a model field', () => {
    const target = settings();
    applyDefaultSetting(target, 'model', 'auto');
    expect(target.model).toBeUndefined();
  });

  it('treats model default the same as model auto', () => {
    const target = settings();
    applyDefaultSetting(target, 'model', 'default');
    expect(target.model).toBeUndefined();
  });

  it('sets an explicit model value', () => {
    const target = settings();
    applyDefaultSetting(target, 'model', 'gpt-5');
    expect(target.model).toBe('gpt-5');
  });

  it('treats "model" itself as an unknown key on a target with no model field', () => {
    // The global-settings target has no model field at all, so `model` falls
    // through to the same unknown-key branch as any other unrecognised key.
    const target: Partial<HarnessDefaultSettings> = {};
    expect(() => applyDefaultSetting(target as Partial<HarnessDefaultSettings & { model: string }>, 'model', 'gpt-5'))
      .toThrow('unknown setting "model"; choose effort, permissions, or failover');
  });

  it('sets effort when no harness is given to gate against', () => {
    const target = settings();
    applyDefaultSetting(target, 'effort', 'high');
    expect(target.effort).toBe('high');
  });

  it('rejects an effort value outside VALID_EFFORTS', () => {
    const target = settings();
    expect(() => applyDefaultSetting(target, 'effort', 'ludicrous')).toThrow(`effort must be one of ${VALID_EFFORTS.join(', ')}`);
  });

  it('sets effort when the given harness supports it', () => {
    harnessSupportsEffort.mockReturnValueOnce(true);
    const target = settings();
    applyDefaultSetting(target, 'effort', 'low', harness());
    expect(target.effort).toBe('low');
  });

  it('rejects effort when the given harness does not support it', () => {
    harnessSupportsEffort.mockReturnValueOnce(false);
    const target = settings();
    const acme = harness({ displayName: 'Acme CLI' });
    expect(() => applyDefaultSetting(target, 'effort', 'low', acme))
      .toThrow('Acme CLI does not publish a configurable reasoning-effort flag; setting one here would silently do nothing.');
  });

  it('sets permissions when no harness is given', () => {
    const target = settings();
    applyDefaultSetting(target, 'permissions', 'bypass');
    expect(target.permissionMode).toBe('bypass');
  });

  it('also accepts the permissionmode spelling of the key', () => {
    const target = settings();
    applyDefaultSetting(target, 'permissionmode', 'auto');
    expect(target.permissionMode).toBe('auto');
  });

  it('rejects a permission mode outside VALID_PERMISSION_MODES', () => {
    const target = settings();
    expect(() => applyDefaultSetting(target, 'permissions', 'godmode')).toThrow('permissions must be ask, bypass, or auto');
  });

  it('sets permissions when the given harness maps that mode', () => {
    harnessSupportsPermissionMode.mockReturnValueOnce(true);
    const target = settings();
    applyDefaultSetting(target, 'permissions', 'bypass', harness());
    expect(target.permissionMode).toBe('bypass');
  });

  it('rejects permissions when the given harness does not map that mode', () => {
    harnessSupportsPermissionMode.mockReturnValueOnce(false);
    const target = settings();
    const acme = harness({ displayName: 'Acme CLI' });
    expect(() => applyDefaultSetting(target, 'permissions', 'bypass', acme))
      .toThrow("Acme CLI does not map ClikCode's permission modes to a real flag; setting one here would silently do nothing.");
  });

  it('sets failover through the same normalizeFailoverWord rules', () => {
    const target = settings();
    applyDefaultSetting(target, 'failover', 'auto');
    expect(target.accountFailover).toBe('on-quota-exhausted');
  });

  it('is case-insensitive on the key', () => {
    const target = settings();
    applyDefaultSetting(target, 'EFFORT', 'high');
    expect(target.effort).toBe('high');
  });

  it('rejects an unknown key, mentioning model only when the target has one', () => {
    const target = settings();
    expect(() => applyDefaultSetting(target, 'bogus', 'x')).toThrow('unknown setting "bogus"; choose model, effort, permissions, or failover');
  });

  it('omits model from the unknown-key message when the target has no model field', () => {
    const target: Partial<HarnessDefaultSettings> = {};
    expect(() => applyDefaultSetting(target as Partial<HarnessDefaultSettings & { model: string }>, 'bogus', 'x'))
      .toThrow('unknown setting "bogus"; choose effort, permissions, or failover');
  });
});

describe('optionForHarness', () => {
  it('finds an option published under its exact id', () => {
    capabilityManifest = { options: [option({ id: 'sandbox', label: 'Sandbox' })] };
    const found = optionForHarness(harness(), 'sandbox');
    expect(found?.id).toBe('sandbox');
  });

  it('returns undefined for an id no harness publishes at all', () => {
    capabilityManifest = { options: [option({ id: 'sandbox', label: 'Sandbox' })] };
    expect(optionForHarness(harness(), 'nonexistent')).toBeUndefined();
  });

  it('falls back to the alias a harness actually publishes for the same control', () => {
    // add-dir and include-directories are one control; Gemini/Qwen spell it
    // include-directories, so looking it up as add-dir must still find it.
    capabilityManifest = { options: [option({ id: 'include-directories', label: 'Include directories', kind: 'path-list' })] };
    const found = optionForHarness(harness(), 'add-dir');
    expect(found?.id, 'the alias fallback did not find the option under its other spelling').toBe('include-directories');
  });

  it('returns undefined when the id maps to a control but the harness publishes neither spelling', () => {
    capabilityManifest = { options: [] };
    expect(optionForHarness(harness(), 'add-dir')).toBeUndefined();
  });
});

describe('optionForControl', () => {
  it('finds the option that owns a given control', () => {
    capabilityManifest = { options: [option({ id: 'include-directories', label: 'Include directories', kind: 'path-list' })] };
    const found = optionForControl(harness(), '/add-dir');
    expect(found?.id).toBe('include-directories');
  });

  it('returns undefined when nothing published owns that control', () => {
    capabilityManifest = { options: [option({ id: 'sandbox', label: 'Sandbox' })] };
    expect(optionForControl(harness(), '/add-dir')).toBeUndefined();
  });
});

describe('setSessionHarnessOption', () => {
  it('throws when the harness does not support the requested option at all', () => {
    capabilityManifest = { options: [] };
    const acme = harness({ displayName: 'Acme CLI' });
    expect(() => setSessionHarnessOption(session(), acme, 'sandbox', 'on'))
      .toThrow('Acme CLI does not support option "sandbox"');
  });

  it('writes model to the named session field, not the harnessOptions bag', () => {
    capabilityManifest = { options: [option({ id: 'model', label: 'Model', kind: 'string' })] };
    const target = session();
    setSessionHarnessOption(target, harness(), 'model', 'gpt-5');
    expect(target.model).toBe('gpt-5');
    expect(target.harnessOptions).toBeUndefined();
  });

  it('writes effort to the named session field', () => {
    capabilityManifest = { options: [option({ id: 'effort', label: 'Effort', kind: 'string' })] };
    const target = session();
    setSessionHarnessOption(target, harness(), 'effort', 'high');
    expect(target.effort).toBe('high');
  });

  it('writes workspace to the named session field', () => {
    capabilityManifest = { options: [option({ id: 'workspace', label: 'Workspace', kind: 'string' })] };
    const target = session();
    setSessionHarnessOption(target, harness(), 'workspace', '/repo');
    expect(target.workspace).toBe('/repo');
  });

  it('writes permissions to permissionMode, cast to AiHarnessPermissionMode', () => {
    capabilityManifest = { options: [option({ id: 'permissions', label: 'Permissions', kind: 'enum', values: ['ask', 'bypass', 'auto'] })] };
    const target = session();
    setSessionHarnessOption(target, harness(), 'permissions', 'bypass');
    expect(target.permissionMode).toBe('bypass');
  });

  it('stores any other option under harnessOptions, keyed by the id the harness actually publishes', () => {
    capabilityManifest = { options: [option({ id: 'include-directories', label: 'Include directories', kind: 'path-list' })] };
    const target = session();
    setSessionHarnessOption(target, harness(), 'add-dir', '/a,/b');
    expect(target.harnessOptions).toEqual({ 'include-directories': ['/a', '/b'] });
  });

  it('merges into an existing harnessOptions bag rather than replacing it', () => {
    capabilityManifest = { options: [option({ id: 'sandbox', label: 'Sandbox' })] };
    const target = session({ harnessOptions: { other: 'kept' } });
    setSessionHarnessOption(target, harness(), 'sandbox', 'on');
    expect(target.harnessOptions).toEqual({ other: 'kept', sandbox: true });
  });

  it('resets nativeSessionId and nativeStartedAt when the option requires a new session', () => {
    capabilityManifest = { options: [option({ id: 'sandbox', label: 'Sandbox', requiresNewSession: true })] };
    const target = session({ nativeSessionId: 'native-1', nativeStartedAt: '2026-01-01T00:00:00.000Z' });
    setSessionHarnessOption(target, harness(), 'sandbox', 'on');
    expect(target.nativeSessionId).toBeUndefined();
    expect(target.nativeStartedAt).toBeUndefined();
  });

  it('leaves nativeSessionId alone when the option does not require a new session', () => {
    capabilityManifest = { options: [option({ id: 'sandbox', label: 'Sandbox' })] };
    const target = session({ nativeSessionId: 'native-1', nativeStartedAt: '2026-01-01T00:00:00.000Z' });
    setSessionHarnessOption(target, harness(), 'sandbox', 'on');
    expect(target.nativeSessionId).toBe('native-1');
    expect(target.nativeStartedAt).toBe('2026-01-01T00:00:00.000Z');
  });
});
