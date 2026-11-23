/** ClikCode's one compaction policy: the threshold, when it fires, how each harness compacts, the handoff cap, the words. */
import { describe, expect, it } from 'vitest';
import { localHarnessForCommand } from '../runtime/lazy-bridge.js';
import {
  COMPACTED, COMPACTING, DEFAULT_COMPACT_AT_TOKENS, compactAt, compactDescription, compactFailedLine, compactionMechanism, contextTokens,
  claudeCompactWindow, effectiveThreshold, handoffTokens, isCompactRequest, noteCompactAt, noteContextAfterCompaction, parseCompactAt, shouldCompact,
  turnsSinceCompaction, vendorThresholdPlan,
} from './compaction.js';

const harness = (command: string) => localHarnessForCommand(command)!;
const at = (minutes: number) => new Date(Date.UTC(2026, 10, 22, 12, minutes)).toISOString();
const turns = (count: number) => Array.from({ length: count }, (_, index) => [
  { role: 'user', content: `ask ${index}` }, { role: 'assistant', content: 'done' },
]).flat();

describe('the threshold', () => {
  it('parses a size in tokens, k or m', () => {
    expect(parseCompactAt('150k')).toBe(150_000);
    expect(parseCompactAt('150000')).toBe(150_000);
    expect(parseCompactAt('1.5m')).toBe(1_500_000);
    expect(parseCompactAt(' 200K tokens ')).toBe(200_000);
    expect(parseCompactAt('soon')).toBeUndefined();
    expect(parseCompactAt('')).toBeUndefined();
  });

  it('is the user\'s, kept in the global settings, or 150k', () => {
    expect(DEFAULT_COMPACT_AT_TOKENS).toBe(150_000);
    expect(compactAt(undefined)).toBe(150_000);
    expect(compactAt({ compactAt: 300_000 })).toBe(300_000);
    expect(compactAt({ compactAt: 5 })).toBe(150_000);
    expect(compactAt({ compactAt: 'big' })).toBe(150_000);
  });

  it('is named in the /compact description', () => {
    noteCompactAt({ compactAt: 250_000 });
    expect(compactDescription()).toContain('(now 250k)');
    noteCompactAt({});
    expect(compactDescription()).toContain('(now 150k)');
  });
});

describe('the words a person sees', () => {
  it('are "Compacting…", "Compacted" and one plain failure line', () => {
    expect(COMPACTING).toBe('Compacting…');
    expect(COMPACTED).toBe('Compacted');
    expect(compactFailedLine('the account is out of usage')).toBe('Could not compact: the account is out of usage');
    expect(compactFailedLine('Could not compact: twice')).toBe('Could not compact: twice');
    expect(isCompactRequest(' /compact ')).toBe(true);
    expect(isCompactRequest('/compact 150k')).toBe(false);
  });
});

describe('the context size', () => {
  it('is the latest model call\'s, or the vendor\'s share of its window', () => {
    expect(contextTokens({ contextUsed: 120_000 })).toBe(120_000);
    expect(contextTokens({ contextPercent: 50, contextWindow: 200_000 })).toBe(100_000);
    expect(contextTokens({})).toBeUndefined();
    expect(contextTokens(undefined)).toBeUndefined();
  });
});

describe('a handoff', () => {
  it('carries at most min(threshold, half the receiving window)', () => {
    expect(handoffTokens(150_000, 1_000_000)).toBe(150_000);
    expect(handoffTokens(150_000, 200_000)).toBe(100_000);
    expect(handoffTokens(150_000)).toBe(150_000);
  });
});

describe('how each harness compacts', () => {
  it('uses the vendor\'s own compact operation or command, and ClikCode\'s rewrite only where it has neither', () => {
    expect(compactionMechanism(harness('codex'))).toEqual({ kind: 'native-api', prompt: '/compact' });
    expect(compactionMechanism(harness('claude'))).toEqual({ kind: 'native-command', prompt: '/compact' });
    // A command it lists wins; Gemini's ACP lists none, so `/compact` there is a rewrite (it compacts by itself at its own threshold).
    expect(compactionMechanism(harness('gemini'), ['compress', 'memory'])).toEqual({ kind: 'native-command', prompt: '/compress' });
    expect(compactionMechanism(harness('gemini'), ['memory'])).toEqual({ kind: 'rewrite' });
    expect(compactionMechanism(harness('copilot'), ['/compact'])).toEqual({ kind: 'native-command', prompt: '/compact' });
    expect(compactionMechanism(harness('opencode'))).toEqual({ kind: 'native-command', prompt: '/compact' });
    expect(compactionMechanism(harness('kilo'))).toEqual({ kind: 'native-command', prompt: '/compact' });
    expect(compactionMechanism(harness('aider'), ['ask', 'tokens'])).toEqual({ kind: 'rewrite' });
    expect(compactionMechanism(harness('auggie'))).toEqual({ kind: 'rewrite' });
    expect(compactionMechanism(harness('pi'))).toEqual({ kind: 'native-api', prompt: '/compact' });
    expect(compactionMechanism(harness('amp'))).toEqual({ kind: 'rewrite' });
  });
});

describe('when it compacts by itself', () => {
  const threshold = 150_000;
  const ended = Date.parse(at(10));

  it('after a turn whose own reading passed the threshold', () => {
    expect(shouldCompact({ messages: turns(3), lastUsage: { contextUsed: 151_000, at: at(11) } }, threshold, ended)).toBe(true);
    expect(shouldCompact({ messages: turns(3), lastUsage: { contextUsed: 149_000, at: at(11) } }, threshold, ended)).toBe(false);
    // A reading from before that turn (another provider's, or a harness that reported nothing this time) is not it.
    expect(shouldCompact({ messages: turns(3), lastUsage: { contextUsed: 400_000, at: at(9) } }, threshold, ended)).toBe(false);
    expect(shouldCompact({ messages: turns(3) }, threshold, ended)).toBe(false);
  });

  it('not again within two turns of the last compaction', () => {
    const compaction = { at: at(5), through: 6 };
    const usage = { contextUsed: 200_000, at: at(11) };
    expect(turnsSinceCompaction({ messages: turns(4), compaction })).toBe(1);
    expect(shouldCompact({ messages: turns(4), lastUsage: usage, compaction }, threshold, ended)).toBe(false);
    expect(shouldCompact({ messages: turns(5), lastUsage: usage, compaction }, threshold, ended)).toBe(true);
    // ClikCode's own compaction request is not a turn of the person's.
    const messages = [...turns(3), { role: 'user', content: '/compact', automatic: COMPACTED }, { role: 'assistant', content: '' }];
    expect(turnsSinceCompaction({ messages, compaction: { at: at(5), through: 6 } })).toBe(0);
  });

  it('raises the threshold where a compaction could not get under half of it, instead of compacting every few calls', () => {
    expect(effectiveThreshold(threshold, { at: at(5), through: 0, after: 40_000 })).toBe(150_000);
    expect(effectiveThreshold(threshold, { at: at(5), through: 0, after: 100_000 })).toBe(200_000);
    const session = { messages: turns(1), lastUsage: { contextUsed: 100_000, at: at(6) }, compaction: { at: at(5), through: 0 } };
    expect(noteContextAfterCompaction(session)).toBe(true);
    expect(session.compaction).toMatchObject({ after: 100_000 });
    expect(noteContextAfterCompaction(session)).toBe(false);
    expect(shouldCompact({ ...session, messages: turns(4), lastUsage: { contextUsed: 180_000, at: at(11) } }, threshold, ended)).toBe(false);
    expect(shouldCompact({ ...session, messages: turns(4), lastUsage: { contextUsed: 210_000, at: at(11) } }, threshold, ended)).toBe(true);
  });
});

describe('a vendor\'s own threshold, in its own terms', () => {
  const plan = (command: string, threshold: number, window?: number) => vendorThresholdPlan(harness(command).compactThreshold, threshold, window);

  it('Claude Code: the auto-compact window its threshold is 33k under, with a percent below its 100k floor', () => {
    expect(plan('claude', 150_000)).toEqual({ kind: 'env', env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '183000' } });
    expect(plan('claude', 500_000, 200_000)).toEqual({ kind: 'env', env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '533000' } });
    // 40k: the floor window (100k) leaves 80k after the output room; 50% of it is 40k.
    expect(claudeCompactWindow(40_000)).toEqual({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '100000', CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '50' });
    expect(claudeCompactWindow(67_000)).toEqual({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '100000' });
  });

  it('Codex: tokens in the thread\'s config', () => {
    expect(plan('codex', 150_000)).toEqual({ kind: 'config', config: { model_auto_compact_token_limit: 150_000 } });
    expect(plan('codex', 300_000)).toEqual({ kind: 'config', config: { model_auto_compact_token_limit: 300_000 } });
  });

  it('tokens in a variable: Aider', () => {
    expect(plan('aider', 150_000)).toEqual({ kind: 'env', env: { AIDER_MAX_CHAT_HISTORY_TOKENS: '150000' } });
    expect(plan('aider', 80_000)).toEqual({ kind: 'env', env: { AIDER_MAX_CHAT_HISTORY_TOKENS: '80000' } });
  });

  it('a share or percent of the window, only once the window is known, below the whole of it', () => {
    expect(plan('goose', 150_000, 200_000)).toEqual({ kind: 'env', env: { GOOSE_AUTO_COMPACT_THRESHOLD: '0.75' } });
    expect(plan('copilot', 150_000, 1_000_000)).toEqual({ kind: 'env', env: { COPILOT_BACKGROUND_COMPACTION_THRESHOLD: '0.15' } });
    // A threshold past the window: as near it as the vendor still compacts (Goose turns off at 1).
    expect(plan('goose', 500_000, 200_000)).toEqual({ kind: 'env', env: { GOOSE_AUTO_COMPACT_THRESHOLD: '0.95' } });
    const percent = { env: 'X_PERCENT', unit: 'percent' as const };
    expect(vendorThresholdPlan(percent, 150_000, 256_000)).toEqual({ kind: 'env', env: { X_PERCENT: '59' } });
    expect(vendorThresholdPlan(percent, 500_000, 200_000)).toEqual({ kind: 'env', env: { X_PERCENT: '95' } });
    expect(plan('goose', 150_000)).toBeUndefined();
    expect(vendorThresholdPlan(percent, 150_000, 0)).toBeUndefined();
  });

  it('settings at a key: a file for Gemini, Qwen and Droid', () => {
    expect(plan('gemini', 200_000, 1_000_000)).toEqual({ kind: 'settings', env: 'GEMINI_CLI_SYSTEM_DEFAULTS_PATH', settings: { model: { compressionThreshold: 0.2 } } });
    expect(plan('qwen', 150_000, 1_000_000)).toEqual({ kind: 'settings', env: 'QWEN_CODE_SYSTEM_DEFAULTS_PATH', settings: { context: { autoCompactThreshold: 0.15 } } });
    expect(plan('droid', 150_000)).toEqual({ kind: 'settings', env: 'FACTORY_RUNTIME_SETTINGS_PATH', settings: { compactionTokenLimit: 150_000 } });
    expect(vendorThresholdPlan({ env: 'X_CONFIG', settingsKey: 'a.b', unit: 'percent' }, 150_000, 400_000)).toEqual({ kind: 'settings', env: 'X_CONFIG', settings: { a: { b: 38 } } });
    expect(plan('gemini', 200_000)).toBeUndefined();
  });

  it('nothing for a harness with no threshold of its own', () => {
    for (const command of ['opencode', 'kilo', 'grok', 'vibe', 'pi', 'amp', 'cline', 'cursor', 'kiro', 'hermes', 'devin', 'auggie', 'junie']) expect(plan(command, 150_000, 200_000)).toBeUndefined();
  });
});

describe('a launch', () => {
  const withHome = async <T>(run: (readFile: (path: string) => string) => Promise<T>): Promise<T> => {
    const { mkdtempSync, readFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const previous = process.env.CLIKCODE_HOME;
    process.env.CLIKCODE_HOME = mkdtempSync(join(tmpdir(), 'compact-env-'));
    try { return await run((path) => readFileSync(path, 'utf8')); } finally {
      if (previous === undefined) delete process.env.CLIKCODE_HOME; else process.env.CLIKCODE_HOME = previous;
    }
  };
  const state = (compactAt: number) => ({ globalSettings: { compactAt }, sessions: [
    { nativeHarness: 'gemini', model: 'gemini-3-pro', lastUsage: { contextWindow: 1_000_000, at: at(1) } },
    { nativeHarness: 'goose', model: 'gpt-x', lastUsage: { contextWindow: 400_000, at: at(1) } },
  ] }) as never;

  it('carries the threshold the user set, and a changed one is a changed launch', async () => {
    await withHome(async (read) => {
      const { compactThresholdLaunch } = await import('./compaction-run.js');
      expect(await compactThresholdLaunch(harness('aider'), state(200_000), null)).toEqual({ environment: { AIDER_MAX_CHAT_HISTORY_TOKENS: '200000' }, config: {}, set: true });
      expect(await compactThresholdLaunch(harness('codex'), state(200_000), 'gpt-5')).toEqual({ environment: {}, config: { model_auto_compact_token_limit: 200_000 }, set: true });
      expect((await compactThresholdLaunch(harness('claude'), state(100_000), null)).environment).toEqual({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '133000' });
      expect((await compactThresholdLaunch(harness('goose'), state(100_000), 'gpt-x')).environment).toEqual({ GOOSE_AUTO_COMPACT_THRESHOLD: '0.25' });
      const before = (await compactThresholdLaunch(harness('gemini'), state(200_000), 'gemini-3-pro')).environment.GEMINI_CLI_SYSTEM_DEFAULTS_PATH!;
      const after = (await compactThresholdLaunch(harness('gemini'), state(300_000), 'gemini-3-pro')).environment.GEMINI_CLI_SYSTEM_DEFAULTS_PATH!;
      expect(JSON.parse(read(before))).toEqual({ model: { compressionThreshold: 0.2 } });
      expect(JSON.parse(read(after))).toEqual({ model: { compressionThreshold: 0.3 } });
      // The file is named by what it holds: a running Gemini (keyed by its environment) restarts for the new one.
      expect(after).not.toBe(before);
    });
  });

  it('is not set where the window is not known, nor for a harness with no threshold: ClikCode compacts after the turn there', async () => {
    await withHome(async () => {
      const { compactThresholdLaunch } = await import('./compaction-run.js');
      expect(await compactThresholdLaunch(harness('gemini'), state(200_000), 'unknown-model')).toEqual({ environment: {}, config: {}, set: false });
      expect(await compactThresholdLaunch(harness('opencode'), state(200_000), 'x')).toEqual({ environment: {}, config: {}, set: false });
    });
  });

});

describe('after a native compaction', () => {
  it('the next request names the file that keeps the whole conversation, once', async () => {
    const { existsSync, mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const previous = process.env.CLIKCODE_HOME;
    process.env.CLIKCODE_HOME = mkdtempSync(join(tmpdir(), 'compact-note-'));
    try {
      const { withCompactionNote } = await import('./compaction-run.js');
      const session = {
        id: 'c1', route: 'local', accountId: null, provider: null, model: null, createdAt: at(0), updatedAt: at(0), status: 'active',
        messages: turns(2), compaction: { at: at(1), through: 4, noteRecord: true as const },
      } as never as import('../session/model.js').HarnessSession;
      const sent = await withCompactionNote(session, 'next request', false);
      expect(sent).toMatch(/The complete conversation, every request and answer, is saved at .*records\/c1\.md/);
      expect(sent.endsWith('next request')).toBe(true);
      expect(session.compaction?.noteRecord).toBeUndefined();
      expect(await withCompactionNote(session, 'later', false)).toBe('later');
      // A harness given ClikCode's MCP server is pointed at its hindsight tool; the file is still written.
      session.compaction!.noteRecord = true;
      const viaTool = await withCompactionNote(session, 'next request', true);
      expect(viaTool).toContain('is in the hindsight tool');
      expect(viaTool).not.toContain('records/c1.md');
      expect(existsSync(join(process.env.CLIKCODE_HOME!, 'records', 'c1.md'))).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.CLIKCODE_HOME; else process.env.CLIKCODE_HOME = previous;
    }
  });
});

describe('a vendor that compacts by itself, mid-turn', () => {
  it('is kept as a compaction: the next turn is told where the whole conversation is, and recall starts there', async () => {
    const { createVendorObserver } = await import('./vendor-observer.js');
    const { recallBoundary } = await import('./compaction.js');
    const session = { id: 'v1', messages: turns(3), workspace: '/w' } as never as import('../session/model.js').HarnessSession;
    let touched = 0;
    const ctx = {
      session, harness: { command: 'claude' }, prompter: undefined, run: {}, state: {}, account: { id: 'a' }, model: null, startedAt: 0,
      checkpoint: { touch: () => { touched += 1; }, persistNow: async () => undefined, response: () => undefined, activity: () => undefined },
    } as never;
    createVendorObserver(ctx).sharedObserver.onNotice('Compacted');
    expect(session.compaction).toMatchObject({ through: 6, noteRecord: true });
    expect(recallBoundary(session)).toBe(6);
    expect(touched).toBe(1);
    // ClikCode's own compaction turn records itself (compaction-run.ts recordCompaction).
    const own = { id: 'v2', messages: turns(1) } as never as import('../session/model.js').HarnessSession;
    createVendorObserver({ ...(ctx as object), session: own, run: { compaction: true } } as never).sharedObserver.onNotice('Compacted');
    expect(own.compaction).toBeUndefined();
  });
});
