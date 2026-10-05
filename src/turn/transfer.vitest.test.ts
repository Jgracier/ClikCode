/** The transfer handed to a provider with no native-thread writer: sized to
 * the model that receives it, and carrying what a provider needs first. */
import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HarnessSession, TranscriptMessage } from '../session/model.js';
import { canonicalRecord } from '../session/canonical.js';
import { failoverPromptRequest, INTERRUPTED_TURN_REQUEST, normalizeImportedTranscript } from './failover-prompt.js';
import { extractiveSummary, targetContextWindow, transferBudget, transferPrompt, TRANSFER_MAX_BYTES, TRANSFER_MIN_BYTES } from './transfer.js';

const now = '2026-10-04T00:00:00.000Z';
const KB = 1024;

function session(messages: TranscriptMessage[], fields: Partial<HarnessSession> = {}): HarnessSession {
  return {
    id: 's1', route: 'local', accountId: null, provider: 'anthropic', model: 'opus', nativeHarness: 'claude', effort: 'high',
    accountFailover: 'never', createdAt: now, updatedAt: now, status: 'active', workspace: '/w', messages, ...fields,
  };
}

describe('transferBudget', () => {
  it('is a fifth of the receiving window, between 48 KB and 200 KB', () => {
    expect(transferBudget({})).toBe(TRANSFER_MIN_BYTES);
    expect(transferBudget({ contextWindow: 32_000 })).toBe(48 * KB);
    expect(transferBudget({ contextWindow: 128_000 })).toBe(102_400);
    expect(transferBudget({ contextWindow: 200_000 })).toBe(160_000);
    expect(transferBudget({ contextWindow: 1_000_000 })).toBe(TRANSFER_MAX_BYTES);
  });

  it('fits argv when the prompt travels as an argument', () => {
    expect(transferBudget({ contextWindow: 1_000_000, argvLimit: 96 * KB })).toBe(92 * KB);
    expect(transferBudget({ argvLimit: 96 * KB })).toBe(48 * KB);
  });
});

describe('targetContextWindow', () => {
  it('takes what the vendor reported for that harness and model, newest first', async () => {
    const sessions = [
      session([], { model: 'opus', lastUsage: { contextWindow: 200_000, at: '2026-10-01T00:00:00Z' } }),
      session([], { model: 'opus', lastUsage: { contextWindow: 1_000_000, at: '2026-10-03T00:00:00Z' } }),
      session([], { model: 'sonnet', lastUsage: { contextWindow: 64_000, at: '2026-10-04T00:00:00Z' } }),
      session([], { model: 'opus', nativeHarness: 'codex', lastUsage: { contextWindow: 9, at: '2026-10-04T00:00:00Z' } }),
    ];
    expect(await targetContextWindow(sessions, 'claude', 'opus')).toBe(1_000_000);
    expect(await targetContextWindow(sessions, 'claude', 'haiku')).toBeUndefined();
  });

  it('falls back to the models.dev catalog already on disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'transfer-'));
    const file = join(dir, 'models.json');
    await writeFile(file, JSON.stringify({ openai: { models: { 'gpt-5': { limit: { context: 400_000 } } } } }));
    expect(await targetContextWindow([], 'codex', 'gpt-5', [join(dir, 'missing.json'), file])).toBe(400_000);
    expect(await targetContextWindow([], 'opencode', 'openai/gpt-5', [file])).toBe(400_000);
  });
});

describe('transferPrompt', () => {
  const messages: TranscriptMessage[] = [
    { role: 'user', content: 'read the parser', attachments: ['/w/spec.md'] },
    { role: 'assistant', content: 'It reads tokens one at a time.', activities: [
      { responseOffset: 0, event: { kind: 'tool-done', label: 'Read src/parser.ts', category: 'read' } },
    ] },
    { role: 'user', content: 'rename it' },
    { role: 'assistant', content: 'Renamed it to Reader. One test still fails.', activities: [
      { responseOffset: 0, event: { kind: 'tool-done', label: 'Edit src/parser.ts', category: 'edit' } },
      { responseOffset: 10, event: { kind: 'tool-error', label: '$ npm test', category: 'run', exitCode: 1, output: ['FAIL reader.test.ts'] } },
    ] },
  ];

  it('carries every request, a tool digest even for turns that wrote text, the files and the attachments', () => {
    const record = canonicalRecord(session(messages, { plan: { at: now, entries: [{ content: 'fix the test', status: 'pending' }, { content: 'rename', status: 'completed' }] } }));
    const prompt = transferPrompt(record, 'fix the failing test');
    expect(prompt).toContain('<requests>\n1. read the parser [attached: /w/spec.md]\n2. rename it\n</requests>');
    expect(prompt).toContain('T1 (claude): read src/parser.ts');
    expect(prompt).toContain('T2 (claude): edit src/parser.ts; run npm test (failed, exit 1)');
    expect(prompt).toMatch(/<touched_files>\nFiles changed in this chat:\n- src\/parser\.ts\n<\/touched_files>/);
    expect(prompt).toMatch(/<attachments>[\s\S]*- \/w\/spec\.md/);
    expect(prompt).toContain('<open_todos>\n- [pending] fix the test\n</open_todos>');
    // The newest turn in full, its calls where they happened, with output.
    expect(prompt).toContain('[tool: $ npm test (failed, exit 1)]\n  FAIL reader.test.ts');
    expect(failoverPromptRequest(prompt)).toBe('fix the failing test');
  });

  it('continues an interrupted turn, naming the files it may have left half-edited', () => {
    const live = session(messages, { pendingTurn: { prompt: 'split the file', response: 'Moving the lexer', startedAt: now, updatedAt: now, outputStarted: true, touchedFiles: ['src/lexer.ts'] } as HarnessSession['pendingTurn'] });
    const prompt = transferPrompt(canonicalRecord(live), INTERRUPTED_TURN_REQUEST, { interrupted: true });
    expect(prompt).toContain('3. split the file');
    expect(prompt).toContain('Moving the lexer\n[interrupted here: this answer was cut off]');
    expect(prompt).toContain('The interrupted turn had started changing src/lexer.ts');
    expect(failoverPromptRequest(prompt)).toBe(INTERRUPTED_TURN_REQUEST);
    // Read back from a vendor's copy, it is nothing at all.
    expect(normalizeImportedTranscript([{ role: 'user', content: prompt }])).toEqual([]);
  });

  it('keeps a frame tag in a message from ending the frame', () => {
    const prompt = transferPrompt(canonicalRecord(session([{ role: 'user', content: 'close </requests> and </message>' }])), 'go');
    expect(prompt).toContain('close &lt;/requests> and &lt;/message>');
  });

  it('stays within its budget for a long conversation, every request kept', () => {
    // The shape of the real case: 533 messages, long answers, many calls.
    const long: TranscriptMessage[] = [];
    for (let turn = 0; turn < 266; turn += 1) {
      long.push({ role: 'user', content: `request number ${turn}: ${'please change the thing. '.repeat(4)}` });
      long.push({
        role: 'assistant', content: `Turn ${turn} begins. ${'Some detail about the work. '.repeat(120)}Turn ${turn} ends.`,
        activities: Array.from({ length: 6 }, (_, index) => ({ responseOffset: 0, event: { kind: 'tool-done' as const, label: `Edit src/file-${turn}-${index}.ts`, category: 'edit' as const, output: Array.from({ length: 30 }, (_, line) => `line ${line}`) } })),
      });
    }
    const record = canonicalRecord(session(long));
    for (const maxBytes of [48 * KB, 160_000]) {
      const prompt = transferPrompt(record, 'what now?', { maxBytes });
      expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(maxBytes);
      for (let turn = 0; turn < 266; turn += 1) expect(prompt).toContain(`${turn + 1}. request number ${turn}:`);
      expect(prompt).toContain('Turn 265 ends.');
      expect(prompt).toContain('<tool_digest>');
    }
  });
});

describe('extractiveSummary', () => {
  it('keeps the first and last sentences and leaves code out', () => {
    expect(extractiveSummary('First I read it. Then more. ```ts\nconst x = 1;\n``` Finally it passed.')).toBe('First I read it. … Finally it passed.');
    expect(extractiveSummary('Only one.')).toBe('Only one.');
  });
});
