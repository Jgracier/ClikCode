/** Vendor threads ClikCode made are never offered back as chats "not yet in
 * ClikCode": the ones a conversation used and let go of, and -- from before
 * any were kept -- the ones opening with ClikCode's own words, read from a
 * cut-off head line, a title, or the vendor's database. Every home here is
 * throwaway. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AiLocalHarnessDefinition } from '../../harness/definition.js';
import { FAILOVER_PREAMBLE, providerBoundaryNote } from '../../turn/failover-prompt.js';
import type { HarnessSession } from '../model.js';
import { forgetNativeThread } from '../native-thread.js';
import { withTitleRequest } from '../title.js';
import { resetNativeSessionDiscoveryCache } from './cache.js';
import { adoptableNativeSessions, type FoundNativeSession } from './owned.js';
import { discoverClaudeFsSessions } from './vendors/claude.js';
import { discoverCodexFsSessions } from './vendors/codex.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cc-owned-'));
  process.env.CLIKCODE_HOME = join(root, 'clikcode');
  resetNativeSessionDiscoveryCache();
});
afterEach(async () => {
  delete process.env.CLIKCODE_HOME;
  resetNativeSessionDiscoveryCache();
  await rm(root, { recursive: true, force: true });
});

const harness = (command: string): AiLocalHarnessDefinition => ({ command }) as AiLocalHarnessDefinition;
const found = (command: string, nativeId: string, title?: string): FoundNativeSession => ({ harness: harness(command), item: { nativeId, ...(title ? { title } : {}) } });
const ids = (list: readonly FoundNativeSession[]): string[] => list.map(({ item }) => item.nativeId);
/** A transfer prompt the size of a real conversation: longer than any head
 * discovery reads. */
const transfer = `${FAILOVER_PREAMBLE}\n\n<conversation>\n${'<message role="user">earlier</message>\n'.repeat(3000)}</conversation>\n\n<current_request>\ngo on\n</current_request>`;

describe('ClikCode-owned vendor threads', () => {
  it('remembers every thread a conversation let go of, and hides it', async () => {
    const session = { id: 's', nativeHarness: 'codex', nativeSessionId: 'old-thread' } as HarnessSession;
    forgetNativeThread(session);
    session.nativeHarness = 'claude';
    session.nativeSessionId = 'next-thread';
    forgetNativeThread(session);
    forgetNativeThread(session);
    expect(session.ownedThreads).toEqual(['codex:old-thread', 'claude:next-thread']);
    const listed = await adoptableNativeSessions({ sessions: [session] }, [found('codex', 'old-thread'), found('claude', 'next-thread'), found('codex', 'users-own')]);
    expect(ids(listed)).toEqual(['users-own']);
  });

  it('knows a Codex thread ClikCode wrote by its first message, even one cut off by the head read', async () => {
    const day = join(root, 'codex', 'sessions', '2026', '10', '05');
    await mkdir(day, { recursive: true });
    const rollout = async (id: string, first: string): Promise<void> => {
      const lines = [
        { type: 'session_meta', payload: { id, cwd: '/work' } },
        { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>x</environment_context>' }] } },
        { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: first }] } },
      ];
      await writeFile(join(day, `rollout-2026-10-05T00-00-00-${id}.jsonl`), `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
    };
    await rollout('00000000-0000-4000-8000-000000000001', transfer);
    await rollout('00000000-0000-4000-8000-000000000002', `${providerBoundaryNote('Claude Code (opus)')}\n\nkeep going`);
    await rollout('00000000-0000-4000-8000-000000000003', 'my own question');
    const sessions = await discoverCodexFsSessions('', { CODEX_HOME: join(root, 'codex') });
    const listed = await adoptableNativeSessions({ sessions: [] }, sessions.map((item) => ({ harness: harness('codex'), item })));
    expect(ids(listed)).toEqual(['00000000-0000-4000-8000-000000000003']);
  });

  it('knows a Claude thread ClikCode carried a conversation into by the prompt it queued first', async () => {
    const project = join(root, 'claude', 'projects', '-work');
    await mkdir(project, { recursive: true });
    const write = async (id: string, prompt: string): Promise<void> => {
      const lines = [
        { type: 'queue-operation', operation: 'enqueue', sessionId: id, content: prompt },
        { type: 'user', cwd: '/work', message: { role: 'user', content: prompt } },
      ];
      await writeFile(join(project, `${id}.jsonl`), `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
    };
    await write('c-transfer', transfer);
    await write('c-titled', withTitleRequest('test'));
    await write('c-own', 'what does this repo do?');
    const sessions = await discoverClaudeFsSessions('', { CLAUDE_CONFIG_DIR: join(root, 'claude') });
    const listed = await adoptableNativeSessions({ sessions: [] }, sessions.map((item) => ({ harness: harness('claude'), item })));
    expect(ids(listed)).toEqual(['c-own']);
  });

  it('knows one by the title a vendor made of its first message', async () => {
    const listed = await adoptableNativeSessions({ sessions: [] }, [
      found('hermes', 'h1', '[ClikCode: the following turns ran on Codex (gpt-…'), found('hermes', 'h2', 'cc-switch startup command'),
    ]);
    expect(ids(listed)).toEqual(['h2']);
  });

  it("reads the first message from a vendor's own database where its listing has none", async () => {
    const sqlite = await import('node:sqlite') as unknown as { DatabaseSync: new (path: string) => { exec(sql: string): void; prepare(sql: string): { run(...values: unknown[]): void }; close(): void } };
    const dir = join(root, 'data', 'goose', 'sessions');
    await mkdir(dir, { recursive: true });
    const db = new sqlite.DatabaseSync(join(dir, 'sessions.db'));
    db.exec('CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content_json TEXT)');
    const add = db.prepare('INSERT INTO messages (session_id, role, content_json) VALUES (?, ?, ?)');
    add.run('g-ours', 'user', JSON.stringify([{ type: 'text', text: `"${FAILOVER_PREAMBLE} ...` }]));
    add.run('g-own', 'user', JSON.stringify([{ type: 'text', text: 'hello goose' }]));
    db.close();
    const listed = await adoptableNativeSessions({ sessions: [] }, [found('goose', 'g-ours', 'b1523af2'), found('goose', 'g-own', 'x')], () => ({ XDG_DATA_HOME: join(root, 'data') }));
    expect(ids(listed)).toEqual(['g-own']);
  });
});
