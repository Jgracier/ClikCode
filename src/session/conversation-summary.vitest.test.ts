/** A summary one harness made of a conversation is the conversation's: the
 * next provider gets it the way it keeps its own, never a retelling of the
 * turns it covers, and a change to those turns retires it. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalRecord } from './canonical';
import {
  copilotThreadCompaction, grokThreadCompaction, kiroThreadCompaction,
  agentMemoryCompaction, alignPrompts, claudeSummaryText, claudeThreadCompaction, conversationSummary,
  placeCompaction, summarizedRecord, turnsHash, validSummary,
} from './conversation-summary';
import { claudeThreadRecords } from './discovery/vendors/claude-thread';
import { ConversationStore } from '../agent/conversation';
import { seedAgentConversation } from '../turn/agent-history';
import { startConversationThread } from '../turn/thread-start';
import type { HarnessSession, TranscriptMessage } from './model';
import type { AiLocalHarnessDefinition } from '../harness/definition';

const claude = { harness: 'claude', route: 'local' as const, provider: 'anthropic', model: 'opus' };
const exchange = (request: string, answer: string): TranscriptMessage[] => [
  { role: 'user', content: request, origin: claude }, { role: 'assistant', content: answer, origin: claude },
];
const turns = (count: number): TranscriptMessage[] => Array.from({ length: count }, (_, i) => exchange(`request number ${i + 1}`, `answer ${i + 1}`)).flat();
const session = (messages: TranscriptMessage[], extra: Partial<HarnessSession> = {}): HarnessSession => ({
  id: 'conv-1', conversationId: 'conv-1', route: 'gateway', accountId: null, provider: 'gateway', model: 'opus', effort: 'auto',
  permissionMode: 'auto', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  status: 'active', workspace: '/w', messages, ...extra,
} as HarnessSession);

/** A Claude Code transcript that compacted after `before` requests and then took `after` more. */
function claudeTranscript(before: number, after: number, summary = 'Turns 1-6: built the parser and fixed the tests.'): string {
  const line = (entry: Record<string, unknown>): string => JSON.stringify(entry);
  const prompt = (n: number): string => line({ type: 'user', message: { role: 'user', content: `request number ${n}` } });
  return [
    ...Array.from({ length: before }, (_, i) => prompt(i + 1)),
    line({ type: 'system', subtype: 'compact_boundary', parentUuid: null }),
    line({ type: 'user', isMeta: true, message: { role: 'user', content: '<command-name>/compact</command-name>' } }),
    line({ type: 'user', isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: 'user', content: `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n${summary}\n\nIf you need specific details from before compaction (like exact code snippets), read the full transcript at: /x.jsonl\n\nContinue the conversation from where it left off without asking the user any further questions.` } }),
    line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } }),
    ...Array.from({ length: after }, (_, i) => prompt(before + i + 1)),
  ].join('\n');
}

describe('reading a summary a harness made', () => {
  it("takes Claude Code's summary without its own framing, and the requests after it", () => {
    const found = claudeThreadCompaction(claudeTranscript(6, 2));
    expect(found).toEqual({ text: 'Turns 1-6: built the parser and fixed the tests.', prompts: ['request number 7', 'request number 8'] });
    expect(claudeSummaryText('no framing at all')).toBe('no framing at all');
  });

  it("takes ClikCode's own agent compaction and the requests it kept, not its notes", () => {
    const memory = [
      JSON.stringify({ kind: 'item', item: { type: 'text', role: 'user', text: 'request number 1' } }),
      JSON.stringify({ kind: 'compaction', summary: 'Built the parser.', keep: [{ type: 'text', role: 'user', text: '<environment>\nDate: x' }, { type: 'text', role: 'user', text: 'request number 5' }] }),
      JSON.stringify({ kind: 'item', item: { type: 'text', role: 'user', text: '[ClikCode] a shell finished' } }),
      JSON.stringify({ kind: 'item', item: { type: 'text', role: 'user', text: 'request number 6' } }),
    ].join('\n');
    expect(agentMemoryCompaction(memory)).toEqual({ text: 'Built the parser.', prompts: ['request number 5', 'request number 6'] });
  });
});

describe("reading the summaries other vendors keep (shapes from their real session files)", () => {
  const lines = (...rows: unknown[]): string => rows.map((row) => JSON.stringify(row)).join('\n');

  it("Grok: the compaction_meta row in Claude Code's words, and every unmarked request left in the rewritten history", () => {
    const history = lines(
      { type: 'system', content: 'You are Grok' },
      { type: 'user', synthetic_reason: 'compaction_meta', content: [{ type: 'text', text: '<user_info>OS Version: linux</user_info>' }] },
      { type: 'user', content: [{ type: 'text', text: '<user_query>\nrequest number 6\n</user_query>' }] },
      { type: 'user', synthetic_reason: 'compaction_meta', content: [{ type: 'text', text: 'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\nBuilt the parser.' }] },
      { type: 'user', synthetic_reason: 'system_reminder', content: [{ type: 'text', text: '<system-reminder>skills</system-reminder>' }] },
      { type: 'assistant', content: 'ok' },
      { type: 'user', content: [{ type: 'text', text: '<user_query>request number 7</user_query>' }] },
    );
    expect(grokThreadCompaction(history)).toEqual({ text: 'Built the parser.', prompts: ['request number 6', 'request number 7'] });
    expect(grokThreadCompaction(lines({ type: 'user', content: 'request number 1' }))).toBeUndefined();
  });

  it('Kiro: the newest Compaction entry and the Prompt entries after it', () => {
    const conversation = lines(
      { version: 'v1', kind: 'Prompt', data: { content: [{ kind: 'text', data: 'request number 5' }] } },
      { version: 'v1', kind: 'Compaction', data: { summary: '## OBJECTIVE\nFix the stalled state.', strategy: {}, messages_snapshot: [] } },
      { version: 'v1', kind: 'AssistantMessage', data: { content: [{ kind: 'text', data: 'ok' }] } },
      { version: 'v1', kind: 'Prompt', data: { content: [{ kind: 'text', data: '[ClikCode: the following turns ran on Codex]\n\nrequest number 7' }] } },
    );
    expect(kiroThreadCompaction(conversation)).toEqual({ text: '## OBJECTIVE\nFix the stalled state.', prompts: ['[ClikCode: the following turns ran on Codex]\n\nrequest number 7'] });
  });

  it('Copilot: the newest successful compaction_complete and the user.message events after it', () => {
    const events = lines(
      { type: 'user.message', data: { content: 'request number 1' } },
      { type: 'session.compaction_complete', data: { success: true, summaryContent: '<overview>Older.</overview>' } },
      { type: 'session.compaction_complete', data: { success: false, summaryContent: 'failed attempt' } },
      { type: 'session.compaction_complete', data: { success: true, summaryContent: '<overview>Streamline ClikDeploy.</overview>' } },
      { type: 'user.message', data: { content: 'request number 7', transformedContent: '<current_datetime>x</current_datetime>\n\nrequest number 7' } },
    );
    expect(copilotThreadCompaction(events)).toEqual({ text: '<overview>Streamline ClikDeploy.</overview>', prompts: ['request number 7'] });
  });
});

describe('placing a summary among the turns', () => {
  const record = canonicalRecord(session(turns(8)));

  it('finds where the kept requests begin, and keeps the turn before it for a vendor', () => {
    expect(alignPrompts(record.turns, ['request number 7', 'request number 8'])).toBe(6);
    // A vendor that compacted mid-turn: the turn before the first kept request stays as it is.
    expect(placeCompaction({ text: 's', prompts: ['request number 7', 'request number 8'] }, record, 'claude')?.through).toBe(5);
    expect(placeCompaction({ text: 's', prompts: ['request number 7', 'request number 8'] }, record, 'clikcode')?.through).toBe(6);
  });

  it('is not used when its end cannot be placed', () => {
    expect(placeCompaction({ text: 's', prompts: ['something never asked'] }, record, 'claude')).toBeUndefined();
    // Requests too short to tell apart ("yes", "ok") recur: no placement on them alone.
    const terse = canonicalRecord(session([...turns(3), ...exchange('yes', 'a'), ...exchange('ok', 'b'), ...exchange('yes', 'c')]));
    expect(alignPrompts(terse.turns, ['yes', 'ok'])).toBeUndefined();
  });

  it('stands for the turns it covers, keeps the newest, and retires when those turns change', () => {
    const summary = { text: 'Opening summarized.', through: 6, hash: turnsHash(record.turns, 6), source: 'claude', at: 'now' };
    const handed = summarizedRecord(record, summary);
    expect(handed.summary).toEqual({ text: 'Opening summarized.', through: 6, source: 'claude' });
    expect(handed.turns.map((turn) => turn.user)).toEqual(['request number 7', 'request number 8']);
    // A redo that rewrote turn 3: the summary no longer describes the conversation.
    const changed = canonicalRecord(session([...turns(2), ...exchange('a different request', 'x'), ...turns(8).slice(6)]));
    expect(validSummary(summary, changed)).toBeUndefined();
    expect(summarizedRecord(changed, summary)).toBe(changed);
  });
});

describe('handing a summarized conversation to the next provider', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  const tmp = (): string => { const dir = mkdtempSync(join(tmpdir(), 'cc-summary-')); dirs.push(dir); return dir; };

  it("writes Claude Code's own compaction into a Claude thread, which reads back as the same summary", () => {
    const record = summarizedRecord(canonicalRecord(session(turns(8))), { text: 'Opening summarized.', through: 6, hash: turnsHash(canonicalRecord(session(turns(8))).turns, 6), source: 'clikcode', at: 'now' });
    const records = claudeThreadRecords(record, { sessionId: 's', cwd: '/w', version: '2.1.289' });
    expect(records[0]).toMatchObject({ type: 'system', subtype: 'compact_boundary', parentUuid: null });
    expect(records[1]).toMatchObject({ type: 'user', isCompactSummary: true, parentUuid: records[0]!.uuid });
    const back = claudeThreadCompaction(records.map((entry) => JSON.stringify(entry)).join('\n'));
    expect(back?.text).toBe('Opening summarized.');
    expect(back?.prompts).toEqual(['request number 7', 'request number 8']);
  });

  it('opens the first kept request with the summary for a vendor with no compaction of its own, and in a retelling', async () => {
    const full = canonicalRecord(session(turns(8)));
    const summary = { text: 'Opening summarized.', through: 6, hash: turnsHash(full.turns, 6), source: 'claude', at: 'now' };
    const harness = { command: 'other', displayName: 'Other' } as AiLocalHarnessDefinition;
    const written: string[] = [];
    const writer = { testedVersions: ['1'], versionOk: () => true, write: async (record: typeof full) => { written.push(JSON.stringify(record.turns.map((turn) => [turn.providerNote ?? '', turn.user]))); return { nativeId: 'n' }; } };
    await startConversationThread({ record: full, request: 'go on', interrupted: false, harness, workspace: '/w', environment: {}, model: null, writer, summary });
    expect(written[0]).toContain('Opening summarized.');
    expect(written[0]).not.toContain('request number 3');
    const retold = await startConversationThread({ record: full, request: 'go on', interrupted: false, harness, workspace: '/w', environment: {}, model: null, summary });
    expect(retold.kind).toBe('transfer');
    expect(retold.prompt).toContain('<summary turns="1-6">');
    expect(retold.prompt).not.toContain('request number 3');
    expect(retold.prompt).toContain('request number 7');
  });

  it("gives ClikCode's agent a vendor's summary as its own compaction", async () => {
    const stateDir = tmp();
    const file = join(tmp(), 'thread.jsonl');
    writeFileSync(file, claudeTranscript(6, 2));
    const moved = session(turns(8), { previousNativeThread: { harness: 'claude', id: 't1', accountId: 'a1', workspace: '/w' } });
    const held = await seedAgentConversation({ session: moved, stateDir, summaries: { stateDir, threadFile: async () => file } });
    expect(held).toMatchObject({ total: 8, seeded: 8, summarized: 5, summaryFrom: 'claude' });
    const memory = await new ConversationStore(stateDir, moved.id).load();
    expect(memory[0]).toEqual({ type: 'summary', text: 'Turns 1-6: built the parser and fixed the tests.' });
    const texts = memory.flatMap((item) => (item.type === 'text' ? [item.text] : []));
    expect(texts.some((text) => text.includes('request number 6'))).toBe(true);
    expect(texts.some((text) => text.includes('request number 2'))).toBe(false);
    // Kept on the conversation for the next hand-over, without reading the thread again.
    expect(moved.summary?.source).toBe('claude');
    expect(await conversationSummary({ ...moved, previousNativeThread: undefined }, canonicalRecord(moved), { stateDir: tmp() })).toEqual(moved.summary);
  });
});
