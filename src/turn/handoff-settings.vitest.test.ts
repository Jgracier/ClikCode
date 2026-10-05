/** What a conversation keeps when another harness takes it up: the effort
 * and permission mode the user chose for it, and its model where the target
 * offers the same one. */
import { describe, expect, it } from 'vitest';
import { localHarnessForCommand } from '../runtime/lazy-bridge.js';
import { carriedHandoffModel, carriedHandoffSettings, carriedPermissionMode, permissionLevel } from './handoff.js';
import type { HarnessDefaultSettings } from '../session/model.js';

const defaults: HarnessDefaultSettings = { effort: 'medium', permissionMode: 'ask', accountFailover: 'never' };
const codex = localHarnessForCommand('codex')!;
const opencode = localHarnessForCommand('opencode')!;
const cn = localHarnessForCommand('cn')!;
const source = { effort: 'xhigh', permissionMode: 'auto', accountFailover: 'on-quota-exhausted' } as const;

describe('carriedHandoffSettings', () => {
  it('carries effort and permission mode the target takes', () => {
    expect(carriedHandoffSettings(source, codex, defaults, ['low', 'medium', 'high', 'xhigh'])).toEqual({
      effort: 'xhigh', permissionMode: 'auto', accountFailover: 'on-quota-exhausted',
    });
    // Levels unknown: carried, and the vendor's own refusal decides.
    expect(carriedHandoffSettings(source, codex, defaults).effort).toBe('xhigh');
  });

  it("falls back to the target's defaults for what it does not take", () => {
    // OpenCode has no `xhigh` and no `auto` mode.
    expect(carriedHandoffSettings(source, opencode, defaults, ['minimal', 'low', 'medium', 'high', 'max'])).toMatchObject({ effort: 'medium', permissionMode: 'ask' });
    // Continue takes no effort at all, but does take bypass.
    expect(carriedHandoffSettings({ ...source, permissionMode: 'bypass' }, cn, defaults)).toMatchObject({ effort: 'medium', permissionMode: 'bypass' });
  });

  it('carries a permission mode by meaning, never escalating', () => {
    const kilo = localHarnessForCommand('kilo')!;
    const claude = localHarnessForCommand('claude')!;
    const copilot = localHarnessForCommand('copilot')!;
    const openhands = localHarnessForCommand('openhands')!;
    // OpenCode and Kilo both pass `--auto`: one calls it bypass, the other auto.
    expect(carriedHandoffSettings({ ...source, permissionMode: 'bypass', nativeHarness: 'opencode' }, kilo, defaults).permissionMode).toBe('auto');
    expect(carriedHandoffSettings({ ...source, permissionMode: 'auto', nativeHarness: 'kilo' }, opencode, defaults).permissionMode).toBe('bypass');
    expect(permissionLevel(kilo, 'auto')).toBe(permissionLevel(opencode, 'bypass'));
    // Kilo's auto is bypass-level, so Claude gets bypass; Claude's auto (asks
    // its classifier) is below Kilo's `--auto`, so Kilo gets ask.
    expect(carriedPermissionMode(kilo, 'auto', claude, 'ask')).toBe('bypass');
    expect(carriedPermissionMode(claude, 'auto', kilo, 'bypass')).toBe('ask');
    expect(carriedPermissionMode(claude, 'auto', opencode, 'bypass')).toBe('ask');
    // Same name, same level: carried as is.
    expect(carriedPermissionMode(claude, 'auto', codex, 'ask')).toBe('auto');
    expect(carriedPermissionMode(codex, 'bypass', copilot, 'ask')).toBe('bypass');
    // Copilot has no auto: the closest below it is ask, not bypass.
    expect(carriedPermissionMode(codex, 'auto', copilot, 'bypass')).toBe('ask');
    // OpenHands has nothing at ask: the default only if it does not allow
    // more, else its least permissive mode.
    expect(carriedPermissionMode(claude, 'ask', openhands, 'bypass')).toBe('auto');
  });
});

describe('carriedHandoffModel', () => {
  it('keeps the model when the target lists it, else takes the fallback', () => {
    expect(carriedHandoffModel({ model: 'gpt-5' }, ['gpt-5', 'gpt-5-mini'], 'gpt-5-mini')).toBe('gpt-5');
    expect(carriedHandoffModel({ model: 'opus' }, ['gpt-5'], 'gpt-5-mini')).toBe('gpt-5-mini');
    expect(carriedHandoffModel({ model: null, reported: { at: '', model: 'gpt-5' } }, ['gpt-5'], null)).toBe('gpt-5');
  });
});
