import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { localHarnessForCommand } from '@clikcode/router/ai-local-harness';
import { nativeThreadCoverage } from './native-thread-continuity.js';
import { StoreBehindError, checkStoreAgainstIndex, threadCoverage } from '../session/store-evidence.js';
import { wrapResourceNote } from './resource-note-text.js';
import type { AiHarnessAccount } from '../harness/definition.js';
import type { HarnessSession, TranscriptMessage } from '../session/model.js';

const asked = (n: number) => `request number ${n}: please change the thing in module ${n}`;
/** A conversation of `turns` exchanges. */
const conversation = (turns: number): TranscriptMessage[] => Array.from({ length: turns }, (_, index) => [
  { role: 'user' as const, content: asked(index + 1) },
  { role: 'assistant' as const, content: `done ${index + 1}` },
]).flat();

describe('a record that holds fewer messages than its index row counted', () => {
  it('stops the turn', () => {
    expect(() => checkStoreAgainstIndex({ id: 'c', messages: conversation(139), listMessageCount: 757 * 2 })).toThrow(StoreBehindError);
    expect(() => checkStoreAgainstIndex({ id: 'c', messages: conversation(5), listMessageCount: 10 })).not.toThrow();
    // Never opened, or never counted: nothing to compare.
    expect(() => checkStoreAgainstIndex({ id: 'c', messages: undefined, listMessageCount: 10 })).not.toThrow();
    expect(() => checkStoreAgainstIndex({ id: 'c', messages: conversation(5) })).not.toThrow();
  });
});

describe('where a vendor thread stands in the conversation', () => {
  const store = conversation(20);
  it('is current when its newest request is the conversation\'s newest, however the request was dressed', () => {
    expect(threadCoverage({ text: asked(20) }, store, undefined)).toEqual({ kind: 'current' });
    expect(threadCoverage({ text: `${wrapResourceNote('The account changed.')}\n\n${asked(20)}\n\n[attached: a.png]` }, store, undefined)).toEqual({ kind: 'current' });
    // A catch-up after a return ends in the request: the missed turns ahead of it are not mistaken for it.
    expect(threadCoverage({ text: `Earlier turns:\n1. ${asked(18)}\n2. ${asked(19)}\n\n${asked(20)}` }, store, undefined)).toEqual({ kind: 'current' });
  });

  it('is behind by the turns the conversation went on, a consistent older prefix', () => {
    expect(threadCoverage({ text: asked(15) }, store, undefined)).toEqual({ kind: 'behind', missed: 5 });
  });

  it('is ahead only when it was asked something the record lacks, later than the record was written', () => {
    const newest = { text: 'a request the stored conversation never saw: deploy the thing', at: '2026-10-12T18:29:00.000Z' };
    expect(threadCoverage(newest, store, '2026-10-10T07:20:00.000Z')).toMatchObject({ kind: 'ahead' });
    // Not aligned but not newer than the record either: a request stored differently, no proof.
    expect(threadCoverage(newest, store, '2026-10-12T18:30:00.000Z')).toEqual({ kind: 'unknown' });
    expect(threadCoverage({ text: 'yes' }, store, undefined)).toEqual({ kind: 'unknown' });
    expect(threadCoverage(undefined, store, undefined)).toEqual({ kind: 'unknown' });
  });
});

describe('a Claude thread resumed for a conversation', () => {
  async function thread(requests: Array<{ text: string; at: string }>, midTurn: Array<{ text: string; at: string }> = []): Promise<{ root: string; session: HarnessSession; account: AiHarnessAccount }> {
    const root = await mkdtemp(join(tmpdir(), 'clikcode-coverage-'));
    const workspace = '/tmp/clikcode-coverage-workspace';
    const profile = join(root, 'profile');
    const project = join(profile, 'projects', workspace.replace(/[^a-zA-Z0-9]/g, '-'));
    await mkdir(project, { recursive: true });
    const lines: string[] = [];
    let parent: string | null = null;
    requests.forEach((request, index) => {
      lines.push(JSON.stringify({ type: 'user', uuid: `u${index}`, parentUuid: parent, timestamp: request.at, message: { role: 'user', content: request.text } }));
      lines.push(JSON.stringify({ type: 'assistant', uuid: `a${index}`, parentUuid: `u${index}`, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }));
      // The tool traffic at the end of a turn is not a request.
      lines.push(JSON.stringify({ type: 'user', uuid: `t${index}`, parentUuid: `a${index}`, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'out' }] } }));
      parent = `t${index}`;
    });
    // Messages sent while the last turn ran, exactly as Claude Code writes them: queued, taken into the turn, never a `user` entry.
    midTurn.forEach((request, index) => {
      lines.push(JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: request.at, sessionId: 'thread', content: request.text }));
      lines.push(JSON.stringify({ type: 'attachment', uuid: `q${index}`, parentUuid: parent, isSidechain: false, timestamp: request.at, attachment: { type: 'queued_command', prompt: request.text, commandMode: 'prompt', timestamp: request.at, hostsOwnTurn: true } }));
      lines.push(JSON.stringify({ type: 'queue-operation', operation: 'remove', timestamp: request.at, sessionId: 'thread', content: request.text, reason: 'absorbed_mid_turn' }));
      lines.push(JSON.stringify({ type: 'assistant', uuid: `qa${index}`, parentUuid: `q${index}`, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }));
      parent = `qa${index}`;
    });
    await writeFile(join(project, 'thread.jsonl'), lines.join('\n'));
    const account = { id: 'a', provider: 'anthropic', authKind: 'vendor-cli', credentialRef: 'native:a', nativeProfile: { env: 'CLAUDE_CONFIG_DIR', path: profile } } as AiHarnessAccount;
    return { root, account, session: { id: 's', nativeSessionId: 'thread', workspace, updatedAt: '2026-10-10T07:20:00.000Z', messages: conversation(20) } as HarnessSession };
  }

  it('parked at turn 15 of a conversation that has 20: behind, so it is not resumed as current', async () => {
    const { root, session, account } = await thread([{ text: asked(14), at: '2026-10-09T00:00:00.000Z' }, { text: asked(15), at: '2026-10-09T01:00:00.000Z' }]);
    try {
      expect(await nativeThreadCoverage(session, localHarnessForCommand('claude')!, account)).toEqual({ kind: 'behind', missed: 5 });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('asked after the stored conversation was last written, something it lacks: the record is behind the thread', async () => {
    const { root, session, account } = await thread([{ text: asked(20), at: '2026-10-09T00:00:00.000Z' }, { text: 'and then we shipped the new billing flow to production', at: '2026-10-12T18:29:00.000Z' }]);
    try {
      expect(await nativeThreadCoverage(session, localHarnessForCommand('claude')!, account)).toMatchObject({ kind: 'ahead' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('messages sent into a running turn are the thread\'s requests too: a steered turn leaves it current, not behind', async () => {
    // The conversation's last two user messages were typed while turn 18 ran. Claude took them into that turn.
    const { root, session, account } = await thread(
      [{ text: asked(17), at: '2026-10-09T00:00:00.000Z' }, { text: asked(18), at: '2026-10-09T01:00:00.000Z' }],
      [{ text: asked(19), at: '2026-10-09T01:01:00.000Z' }, { text: asked(20), at: '2026-10-09T01:02:00.000Z' }],
    );
    try {
      expect(await nativeThreadCoverage(session, localHarnessForCommand('claude')!, account)).toEqual({ kind: 'current' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('current: its newest request is the conversation\'s newest', async () => {
    const { root, session, account } = await thread([{ text: asked(19), at: '2026-10-09T00:00:00.000Z' }, { text: asked(20), at: '2026-10-09T01:00:00.000Z' }]);
    try {
      expect(await nativeThreadCoverage(session, localHarnessForCommand('claude')!, account)).toEqual({ kind: 'current' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
