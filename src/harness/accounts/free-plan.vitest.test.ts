import { describe, expect, it } from 'vitest';
import { localHarnessForCommand } from '@clikcode/router/ai-local-harness';
import { freeModelAfterPlanRefusal, freePlanModels, planIsFree } from './free-plan';
import { opencodeVerboseModels } from './opencode-discovery';
import { antigravityQuotaReading } from './cli-usage-probes';

const harness = (command: string) => localHarnessForCommand(command)!;

describe('which models a free plan runs', () => {
  it('knows a free plan by the name its vendor gives it', () => {
    for (const name of ['Free', 'KIRO FREE', 'free_limited_copilot', 'free-tier', 'Free Plan', 'TEAMS_TIER_DEVIN_FREE', 'free']) expect(planIsFree({ name })).toBe(true);
    for (const name of ['Pro', 'plus', 'SuperGrok', 'max', 'Copilot Business']) expect(planIsFree({ name })).toBe(false);
    expect(planIsFree(undefined)).toBe(false);
  });

  it('takes `:free` ids and what the vendor list marks free, on any plan', () => {
    const free = freePlanModels(harness('kilo'), undefined, { models: ['kilo/a:free', 'kilo/kilo-auto/free', 'kilo/paid'], free: ['kilo/kilo-auto/free'] });
    expect([...free].sort()).toEqual(['kilo/a:free', 'kilo/kilo-auto/free']);
  });

  // Command Code, 2026-10-06: its `:free` ids answered "Insufficient credits"
  // at zero credits like any other, so the suffix is not free there.
  it('takes the suffix only where the harness says it means free', () => {
    expect(freePlanModels(harness('command'), undefined, { models: ['inclusionai/ling-3.1-flash:free'] }).size).toBe(0);
  });

  // Cursor, 2026-10-06: a Free account ran only Auto (`default`, the one
  // model AvailableModels does not file as named); the ACP id carries settings.
  it('on Cursor Free, the models the plan names, matched without their settings', () => {
    const models = ['default[]', 'composer-2.5[fast=true]', 'gpt-5.5[context=272k]'];
    expect([...freePlanModels(harness('cursor'), { plan: { name: 'Free', models: ['default'] } }, { models })]).toEqual(['default[]']);
    expect(freePlanModels(harness('cursor'), { plan: { name: 'Pro' } }, { models }).size).toBe(0);
  });

  // Grok, Kiro, Devin, Codex, Copilot list only what the account's plan runs.
  it('on a vendor that lists only the plan\'s models, every listed one when the plan is free', () => {
    expect([...freePlanModels(harness('grok'), { plan: { name: 'Free' } }, { models: ['grok-4.7'] })]).toEqual(['grok-4.7']);
    expect(freePlanModels(harness('grok'), { plan: { name: 'SuperGrok' } }, { models: ['grok-4.7', 'grok-4.6'] }).size).toBe(0);
    // Cursor's list is not the plan's: a free plan alone marks nothing there.
    expect(freePlanModels(harness('cursor'), { plan: { name: 'Free' } }, { models: ['gpt-5.5[]'] }).size).toBe(0);
  });
});

describe('a model the plan does not run, refused', () => {
  // cline 2.x, 2026-10-06: on all 12 accounts with a negative balance.
  const clineRefusal = new Error('Internal error: Insufficient balance. Your Cline Credits balance is $-0.20');
  const clineFree = new Set(['apodex/apodex-1.1-mini:free', 'qwen/qwen3.8-27b:free']);
  it('goes on, on the same account, with a free model', () => {
    expect(freeModelAfterPlanRefusal(harness('cline'), '~anthropic/claude-opus-latest', clineRefusal, clineFree)).toBe('apodex/apodex-1.1-mini:free');
  });
  it('is not a free model\'s own refusal, nor another failure, nor a harness that names no refusal', () => {
    expect(freeModelAfterPlanRefusal(harness('cline'), 'qwen/qwen3.8-27b:free', clineRefusal, clineFree)).toBeUndefined();
    expect(freeModelAfterPlanRefusal(harness('cline'), 'x', new Error('Rate limited'), clineFree)).toBeUndefined();
    expect(freeModelAfterPlanRefusal(harness('cline'), 'x', clineRefusal, new Set())).toBeUndefined();
    expect(freeModelAfterPlanRefusal(harness('claude'), 'x', clineRefusal, clineFree)).toBeUndefined();
  });
  // kilo, 2026-10-06: the first `:free` model (apodex) was overloaded; Kilo's
  // own free router answered.
  it('prefers the vendor\'s own free router', () => {
    // Cline bills its `openrouter/free` ("Insufficient balance", 2026-10-06).
    expect(freePlanModels(harness('cline'), undefined, { models: ['openrouter/free'] }).size).toBe(0);
    const refusal = new Error('Payment Required: Add credits to continue, or switch to a free model');
    expect(freeModelAfterPlanRefusal(harness('kilo'), 'kilo/aion-labs/aion-2.0', refusal, new Set(['kilo/apodex/apodex-1.1-mini:free', 'kilo/kilo-auto/free']))).toBe('kilo/kilo-auto/free');
  });
  // The vendors' own words, each from a real refusal on 2026-10-06.
  it.each([
    ['cursor', 'gpt-5.5[]', 'ActionRequiredError: Named models unavailable Free plans can only use Auto.', 'default[]'],
    ['cursor', 'composer-2.5[fast=true]', 'Cursor Agent: \n\nUpgrade your plan to continue', 'default[]'],
    ['opencode', 'opencode/gpt-6', 'Upstream request failed: Insufficient account funds', 'opencode/big-pickle'],
    ['kiro', 'claude-opus-4.5', "The model 'claude-opus-4.5' is not available. Please use '/model' to select a different model and try again.", 'auto'],
    ['devin', 'swe-2-medium', 'Upgrade to Pro to access this model (https://devin.ai/pricing)', 'swe-1-6-slow'],
    ['grok', 'grok-4.6', 'Invalid params: "unknown model id"', 'grok-4.7'],
    ['devin', 'swe-2-medium', 'devin ACP does not list model swe-2-medium', 'swe-1-6-slow'],
  ])('%s: %s', (command, model, message, free) => {
    expect(freeModelAfterPlanRefusal(harness(command), model, new Error(message), new Set([free]))).toBe(free);
  });
  it('on Cursor, Auto refused is spent quota, not a model to leave', () => {
    expect(freeModelAfterPlanRefusal(harness('cursor'), 'default[]', new Error('Upgrade your plan to continue'), new Set(['default[]']))).toBeUndefined();
  });
});

describe('`models --verbose` (OpenCode, Kilo)', () => {
  const block = (id: string, meta: object) => `${id}\n${JSON.stringify(meta, null, 2)}`;
  it('reads every model, and which are free by the vendor\'s flag, else a zero price', () => {
    const printed = [
      block('kilo/kilo-auto/free', { isFree: true, cost: { input: 0, output: 0 } }),
      block('kilo/kilo-auto/balanced', { isFree: false, cost: { input: 0, output: 0 } }),
      block('opencode/big-pickle', { cost: { input: 0, output: 0 } }),
      block('opencode/gpt-6', { cost: { input: 1.25, output: 10 } }),
      block('anthropic/claude-x', {}),
    ].join('\n');
    expect(opencodeVerboseModels(printed)).toEqual({
      models: ['kilo/kilo-auto/free', 'kilo/kilo-auto/balanced', 'opencode/big-pickle', 'opencode/gpt-6', 'anthropic/claude-x'],
      free: ['kilo/kilo-auto/free', 'opencode/big-pickle'],
    });
  });
});

// Antigravity's fetchAvailableModels, abridged from a free-tier account on
// 2026-10-06: two pools, each named by its families; tool models (no
// display name, no reset) are not a pool.
describe('Antigravity quota pools', () => {
  it('reads one advisory window per reset, the spent one with no fraction', () => {
    const reading = antigravityQuotaReading({
      'gemini-3.6-flash-low': { displayName: 'Gemini 3.6 Flash (Low)', quotaInfo: { remainingFraction: 0.8598712, resetTime: '2026-10-09T13:12:35Z' } },
      'gemini-3.1-pro-high': { displayName: 'Gemini 3.1 Pro (High)', quotaInfo: { remainingFraction: 0.8598712, resetTime: '2026-10-09T13:12:35Z' } },
      'claude-sonnet-4-6': { displayName: 'Claude Sonnet 4.6 (Thinking)', quotaInfo: { remainingFraction: 1, resetTime: '2026-10-13T15:58:46Z' } },
      'gpt-oss-120b-medium': { displayName: 'GPT-OSS 120B (Medium)', quotaInfo: { resetTime: '2026-10-13T15:58:46Z' } },
      chat_23310: { quotaInfo: { remainingFraction: 1 } },
    });
    expect(reading?.label).toBe('Gemini 86% left · Claude/GPT-OSS 0% left');
    expect(reading?.windows.every((window) => window.advisory)).toBe(true);
  });
});
