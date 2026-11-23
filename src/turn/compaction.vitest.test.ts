/** ClikCode's one compaction policy: the threshold, when it fires, how each harness compacts, the handoff cap, the words. */
import { describe, expect, it } from 'vitest';
import { localHarnessForCommand } from '../runtime/lazy-bridge.js';
import {
  COMPACTED, COMPACTING, DEFAULT_COMPACT_AT_TOKENS, compactAt, compactDescription, compactFailedLine, compactionMechanism, contextTokens,
  effectiveThreshold, handoffTokens, isCompactRequest, noteCompactAt, noteContextAfterCompaction, parseCompactAt, shouldCompact, turnsSinceCompaction,
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
    // A command it lists wins; Gemini's ACP lists none, so it compacts at its own threshold, set to ClikCode's.
    expect(compactionMechanism(harness('gemini'), ['compress', 'memory'])).toEqual({ kind: 'native-command', prompt: '/compress' });
    expect(compactionMechanism(harness('gemini'), ['memory'])).toEqual({ kind: 'vendor-threshold' });
    expect(compactionMechanism(harness('copilot'), ['/compact'])).toEqual({ kind: 'native-command', prompt: '/compact' });
    expect(compactionMechanism(harness('opencode'))).toEqual({ kind: 'native-command', prompt: '/compact' });
    expect(compactionMechanism(harness('kilo'))).toEqual({ kind: 'native-command', prompt: '/compact' });
    expect(compactionMechanism(harness('aider'), ['ask', 'tokens'])).toEqual({ kind: 'vendor-threshold' });
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

describe('a vendor that compacts at a threshold of its own', () => {
  it('is told ClikCode\'s: Aider in tokens, Gemini as a share of the window in its lowest-precedence settings', async () => {
    const { mkdtempSync, readFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const home = mkdtempSync(join(tmpdir(), 'compact-env-'));
    const previous = process.env.CLIKCODE_HOME;
    process.env.CLIKCODE_HOME = home;
    try {
      const { compactThresholdEnvironment } = await import('./compaction-run.js');
      const state = { globalSettings: { compactAt: 200_000 }, sessions: [
        { nativeHarness: 'gemini', model: 'gemini-3-pro', lastUsage: { contextWindow: 1_000_000, at: at(1) } },
      ] } as never;
      expect(await compactThresholdEnvironment(harness('aider'), state, null)).toEqual({ AIDER_MAX_CHAT_HISTORY_TOKENS: '200000' });
      const gemini = await compactThresholdEnvironment(harness('gemini'), state, 'gemini-3-pro');
      expect(JSON.parse(readFileSync(gemini.GEMINI_CLI_SYSTEM_DEFAULTS_PATH!, 'utf8'))).toEqual({ model: { compressionThreshold: 0.2 } });
      // No window known: Gemini keeps its own default.
      expect(await compactThresholdEnvironment(harness('gemini'), state, 'unknown-model')).toEqual({});
      expect(await compactThresholdEnvironment(harness('claude'), state, null)).toEqual({});
    } finally {
      if (previous === undefined) delete process.env.CLIKCODE_HOME; else process.env.CLIKCODE_HOME = previous;
    }
  });
});

describe('after a native compaction', () => {
  it('the next request names the file that keeps the whole conversation, once', async () => {
    const { mkdtempSync } = await import('node:fs');
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
      const sent = await withCompactionNote(session, 'next request');
      expect(sent).toMatch(/The complete conversation, every request and answer, is saved at .*records\/c1\.md/);
      expect(sent.endsWith('next request')).toBe(true);
      expect(session.compaction?.noteRecord).toBeUndefined();
      expect(await withCompactionNote(session, 'later')).toBe('later');
    } finally {
      if (previous === undefined) delete process.env.CLIKCODE_HOME; else process.env.CLIKCODE_HOME = previous;
    }
  });
});
