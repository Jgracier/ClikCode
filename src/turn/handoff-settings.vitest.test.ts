/** What a conversation keeps when another harness takes it up: the effort
 * and permission mode the user chose for it, and its model where the target
 * offers the same one. */
import { describe, expect, it } from 'vitest';
import { localHarnessForCommand } from '../runtime/lazy-bridge.js';
import { carriedHandoffModel, carriedHandoffSettings, createHandoffBranch } from './handoff.js';
import type { HarnessDefaultSettings, HarnessSession } from '../session/model.js';

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

  it('is what the handoff branch gets', () => {
    const now = new Date().toISOString();
    const from = {
      id: 'a', route: 'local', accountId: null, provider: 'anthropic', model: 'opus', nativeHarness: 'claude', ...source,
      createdAt: now, updatedAt: now, status: 'active',
    } as HarnessSession;
    const branch = createHandoffBranch({ source: from, target: codex, accountId: null, model: null, defaults: carriedHandoffSettings(from, codex, defaults), now });
    expect(branch).toMatchObject({ effort: 'xhigh', permissionMode: 'auto', accountFailover: 'on-quota-exhausted' });
  });
});

describe('carriedHandoffModel', () => {
  it('keeps the model when the target lists it, else takes the fallback', () => {
    expect(carriedHandoffModel({ model: 'gpt-5' }, ['gpt-5', 'gpt-5-mini'], 'gpt-5-mini')).toBe('gpt-5');
    expect(carriedHandoffModel({ model: 'opus' }, ['gpt-5'], 'gpt-5-mini')).toBe('gpt-5-mini');
    expect(carriedHandoffModel({ model: null, reported: { at: '', model: 'gpt-5' } }, ['gpt-5'], null)).toBe('gpt-5');
  });
});
