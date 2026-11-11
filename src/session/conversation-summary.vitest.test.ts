/** A summary one harness made of a conversation is the conversation's: the
 * next provider gets it the way it keeps its own, never a retelling of the
 * turns it covers, and a change to those turns retires it. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalRecord } from './canonical.js';
import {
  copilotThreadCompaction, grokThreadCompaction, kiroThreadCompaction,
  claudeSummaryText, turnsHash, validSummary, shownSummary, listedSummary, summaryHeadline,
} from './conversation-summary.js';
import { exportTranscript } from '../tui/slash/export-transcript.js';
import { conversationOption } from './options.js';
import { ConversationStore } from '../agent/conversation.js';
import { seedAgentConversation } from '../turn/agent-history.js';
import { startConversationThread } from '../turn/thread-start.js';
import type { HarnessSession, TranscriptMessage } from './model.js';
import type { AiLocalHarnessDefinition } from '../harness/definition.js';

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

describe("reading the summaries other vendors keep (shapes from their real session files)", () => {
  it("takes Claude Code's words without its own framing", () => {
    expect(claudeSummaryText('This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\nBuilt the parser.\n\nIf you need specific details from before compaction, read x')).toBe('Built the parser.');
    expect(claudeSummaryText('no framing at all')).toBe('no framing at all');
  });

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

describe('handing a summarized conversation to the next provider', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  const tmp = (): string => { const dir = mkdtempSync(join(tmpdir(), 'cc-summary-')); dirs.push(dir); return dir; };

  it('carries the turns themselves: a summary a provider made is not put in place of them', async () => {
    const full = canonicalRecord(session(turns(8)));
    const harness = { command: 'other', displayName: 'Other' } as AiLocalHarnessDefinition;
    const written: string[] = [];
    const writer = { testedVersions: ['1'], versionOk: () => true, write: async (record: typeof full) => { written.push(JSON.stringify(record.turns.map((turn) => [turn.providerNote ?? '', turn.user]))); return { nativeId: 'n' }; } };
    await startConversationThread({ record: full, request: 'go on', interrupted: false, harness, workspace: '/w', environment: {}, model: null, writer });
    expect(written[0]).toContain('request number 3');
    expect(written[0]).not.toContain('Opening summarized.');
    const retold = await startConversationThread({ record: full, request: 'go on', interrupted: false, harness, workspace: '/w', environment: {}, model: null });
    expect(retold.kind).toBe('transfer');
    expect(retold.prompt).not.toContain('<summary');
    expect(retold.prompt).toContain('request number 3');
    expect(retold.prompt).toContain('request number 7');
  });

  it("seeds ClikCode's agent with the turns, not with a vendor's summary of them", async () => {
    const stateDir = tmp();
    const moved = session(turns(8), { previousNativeThread: { harness: 'claude', id: 't1', accountId: 'a1', workspace: '/w' } });
    const held = await seedAgentConversation({ session: moved, stateDir });
    expect(held).toEqual({ total: 8, seeded: 8 });
    const memory = await new ConversationStore(stateDir, moved.id).load();
    expect(memory.some((item) => item.type === 'summary')).toBe(false);
    const texts = memory.flatMap((item) => (item.type === 'text' ? [item.text] : []));
    expect(texts.some((text) => text.includes('request number 2'))).toBe(true);
    expect(texts.some((text) => text.includes('request number 6'))).toBe(true);
  });
});

describe('a summary an older build stored', () => {
  it('is no longer in force once the turns it covers changed', () => {
    const record = canonicalRecord(session(turns(4)));
    const summary = { text: 's', through: 3, hash: turnsHash(record.turns, 3), source: 'claude', at: 'now' };
    expect(validSummary(summary, record)).toBe(summary);
    expect(validSummary(summary, canonicalRecord(session([...turns(2), ...exchange('a different request', 'x'), ...turns(4).slice(6)])))).toBeUndefined();
  });
});

describe('showing the carried summary', () => {
  const summarized = (messages: TranscriptMessage[], through: number, text = 'Built the parser.') => {
    const record = canonicalRecord(session(messages));
    return session(messages, { summary: { text, through, hash: turnsHash(record.turns, through), source: 'claude', at: '2026-01-01T00:00:00.000Z' } });
  };

  it('says how many turns it covers, and is not shown once the turns it covers changed', () => {
    expect(summaryHeadline({ through: 1 })).toBe('first 1 turn summarized');
    expect(summaryHeadline({ through: 6 })).toBe('first 6 turns summarized');
    const kept = summarized(turns(4), 3);
    expect(shownSummary(kept)?.through).toBe(3);
    // A redo that rewrote turn 2: the summary no longer stands for them.
    const edited = { ...kept, messages: [...exchange('request number 1', 'answer 1'), ...exchange('something else', 'answer 2'), ...turns(4).slice(4)] };
    expect(shownSummary(edited)).toBeUndefined();
    expect(shownSummary(session(turns(2)))).toBeUndefined();
  });

  it('opens the exported transcript, and hints on a list row while the conversation still reaches it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-sum-'));
    try {
      const chat = { ...summarized(turns(4), 3), workspace: dir };
      const file = await exportTranscript(chat, 'out.md', async () => true);
      const markdown = (await import('node:fs')).readFileSync(file, 'utf8');
      expect(markdown).toContain('## Summary (first 3 turns summarized)\n\nBuilt the parser.');
      expect(markdown.indexOf('## Summary')).toBeLessThan(markdown.indexOf('request number 1'));
    } finally { rmSync(dir, { recursive: true, force: true }); }
    // A row from the index has no transcript to hash: the message count stands in.
    const row = { ...summarized(turns(4), 3), messages: undefined, listMessageCount: 8 } as HarnessSession;
    expect(listedSummary(row)?.through).toBe(3);
    expect(listedSummary({ ...row, listMessageCount: 2 })).toBeUndefined();
    const option = conversationOption({ latest: row, chats: [row], section: 'recent' } as never);
    expect(option.detail).toContain('first 3 turns summarized');
  });
});
