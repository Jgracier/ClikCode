import { describe, expect, it, vi } from 'vitest';
import * as catalog from '@clikcode/router/ai-local-harness';

// The catalog from source: the built runtime bundle is not there under test.
vi.mock('../../runtime/lazy-bridge.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../runtime/lazy-bridge.js')>(),
  localHarnessForCommand: catalog.localHarnessForCommand,
  modelDisplayId: catalog.modelDisplayId,
  modelIdFromDisplay: catalog.modelIdFromDisplay,
}));

const { harnessModelLabel, modelIdFromLabel, nativeModelLabel } = await import('./model-catalog.js');
const { modelRow } = await import('../../tui/pickers/model.js');
const localHarnessForCommand = catalog.localHarnessForCommand;

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

  it('never names the harness a model is shown under a second time', () => {
    expect(nativeModelLabel('opencode', 'opencode/big-pickle')).toBe('big-pickle');
    expect(nativeModelLabel('opencode', 'anthropic/claude-sonnet-4')).toBe('anthropic/claude-sonnet-4');
    expect(nativeModelLabel('kilo', 'kilo/openai/gpt-5.1-codex-max')).toBe('openai/gpt-5.1-codex-max');
    expect(nativeModelLabel('kimi', 'kimi-code/k3')).toBe('k3');
    expect(nativeModelLabel('hermes', 'nous:anthropic/claude-opus-5')).toBe('anthropic/claude-opus-5');
    expect(nativeModelLabel('hermes', 'copilot:gpt-5.4')).toBe('copilot/gpt-5.4');
    expect(nativeModelLabel('goose', 'openrouter/anthropic/claude-3-haiku')).toBe('openrouter/anthropic/claude-3-haiku');
    expect(nativeModelLabel('openclaw', 'claude-cli/claude-opus-5')).toBe('claude-cli/claude-opus-5');
    expect(nativeModelLabel(undefined, 'openai/gpt-5.5')).toBe('openai/gpt-5.5');
  });

  it('lists a model under its label and keeps the id as the value', () => {
    const opencode = localHarnessForCommand('opencode')!;
    const row = modelRow(opencode, { models: ['opencode/big-pickle'] }, 'opencode/big-pickle', 'opencode/big-pickle');
    expect(row).toMatchObject({ label: 'big-pickle', value: 'opencode/big-pickle' });
    expect(row.detail).toBe('· current');
  });

  it('says "free plan" on a model the account\'s free plan runs', () => {
    const opencode = localHarnessForCommand('opencode')!;
    const catalog = { models: ['opencode/big-pickle', 'opencode/gpt-6'], free: ['opencode/big-pickle'] };
    const free = new Set(catalog.free);
    expect(modelRow(opencode, catalog, 'opencode/big-pickle', 'opencode/gpt-6', false, free).detail).toBe('· free plan');
    expect(modelRow(opencode, catalog, 'opencode/gpt-6', 'opencode/gpt-6', false, free).detail).toBe('· current');
  });

  it('takes a model typed the way it is shown', () => {
    const opencode = localHarnessForCommand('opencode')!;
    const kilo = localHarnessForCommand('kilo')!;
    const models = ['opencode/big-pickle', 'opencode/claude-opus-4-5', 'anthropic/claude-sonnet-4'];
    expect(harnessModelLabel(opencode, 'opencode/big-pickle')).toBe('big-pickle');
    expect(modelIdFromLabel(opencode, models, 'big-pickle')).toBe('opencode/big-pickle');
    expect(modelIdFromLabel(opencode, models, 'opencode/big-pickle')).toBe('opencode/big-pickle');
    expect(modelIdFromLabel(opencode, models, 'anthropic:claude-sonnet-4')).toBe('anthropic/claude-sonnet-4');
    expect(modelIdFromLabel(opencode, models, 'anthropic/claude-sonnet-4')).toBe('anthropic/claude-sonnet-4');
    expect(modelIdFromLabel(opencode, models, 'nothing-like-it')).toBe('nothing-like-it');
    expect(modelIdFromLabel(kilo, ['kilo/openai/gpt-5.1'], 'openai/gpt-5.1')).toBe('kilo/openai/gpt-5.1');
    // Two models reading the same: neither is guessed.
    expect(modelIdFromLabel(opencode, ['opencode/x', 'opencode:x'], 'x')).toBe('x');
  });

  it('spells a display form the harness way with no catalog in hand', () => {
    const goose = localHarnessForCommand('goose')!;
    expect(modelIdFromLabel(goose, [], 'claude-code:sonnet')).toBe('claude-code/sonnet');
    expect(modelIdFromLabel(goose, [], 'ollama/qwen3:8b')).toBe('ollama/qwen3:8b');
    expect(modelIdFromLabel(goose, ['claude-code/sonnet'], ' claude-code:sonnet ')).toBe('claude-code/sonnet');
  });
});
