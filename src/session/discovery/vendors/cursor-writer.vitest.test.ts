/** The Cursor thread writer: the store it makes for one conversation (a
 * codeword, a Codex shell call, a Claude Edit, a Claude Grep), and the live
 * check that `cursor-agent acp` session/load replays it.
 *
 * __golden__/cursor.store.json is the store that cursor-agent
 * 2026.09.26-dd393fe REPLAYED in full (scripts/verify-thread-writer.mjs
 * cursor --replay-only). A change that moves it must be re-checked against
 * the agent, then regenerated with `UPDATE_GOLDEN=1`. */

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir, tmpdir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localHarnessForCommand } from '@clikcode/router/ai-local-harness';
import { markProviderBoundaries, type CanonicalOrigin, type CanonicalPart, type CanonicalRecord, type CanonicalToolCall, type CanonicalTurn } from '../../canonical.js';
import { nativeSessionStore } from '../registry.js';
import type { NativeThreadWriteContext } from '../stores.js';
import { sequentialIds } from './thread-writer-files.js';
import {
  CURSOR_WRITER_TESTED_VERSIONS, cursorAcpSessionsRoot, cursorCallFor, cursorStore, cursorThreadWriter, pb,
} from './cursor-writer.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKSPACE = '/home/user/projects/app';
const VERSION = '2026.09.26-dd393fe';

function origin(harness: string, provider: string, model: string): CanonicalOrigin {
  return { sessionId: `s-${harness}`, harness, route: 'native' as CanonicalOrigin['route'], provider, model };
}

function turn(index: number, user: string, parts: CanonicalPart[], from: CanonicalOrigin): CanonicalTurn {
  const tools = parts.flatMap((part) => (part.type === 'tool' ? [part.call] : []));
  return {
    index, user, attachments: [], parts, interrupted: false, origin: from, tools,
    assistant: parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join(''),
    touchedFiles: tools.flatMap((call) => call.files),
  };
}

function fixtureRecord(): CanonicalRecord {
  const shell: CanonicalToolCall = {
    id: 'call_codex_1', category: 'run', name: 'shell', input: { command: ['bash', '-lc', 'cat notes.txt'] },
    label: '$ cat notes.txt', target: 'cat notes.txt', status: 'done', output: ['launch window: Thursday'], exitCode: 0, files: [],
  };
  const edit: CanonicalToolCall = {
    id: 'toolu_1', category: 'edit', name: 'Edit',
    input: { file_path: 'src/app.ts', old_string: 'cosnt x = 1;', new_string: 'const x = 1;' },
    label: 'Edit src/app.ts', target: 'src/app.ts', status: 'done', files: ['src/app.ts'],
  };
  const grep: CanonicalToolCall = {
    id: 'toolu_2', category: 'search', name: 'Grep', input: { pattern: 'cosnt' },
    label: 'Grep cosnt', target: 'cosnt', status: 'done', output: ['(no matches)'], files: [],
  };
  const fetch: CanonicalToolCall = {
    id: 'toolu_3', category: 'fetch', name: 'WebFetch', input: { url: 'https://example.com' },
    label: 'Fetch https://example.com', target: 'https://example.com', status: 'done', output: ['Example Domain'], files: [],
  };
  const turns = [
    turn(0, 'Remember the codeword PELICAN-73. Then check what is in notes.txt.', [
      { type: 'text', text: "I'll read the notes." },
      { type: 'tool', call: shell },
      { type: 'text', text: 'notes.txt says the launch window is Thursday. Codeword PELICAN-73 noted.' },
    ], origin('codex', 'openai', 'gpt-5.5')),
    turn(1, 'Fix the typo in src/app.ts', [
      { type: 'tool', call: edit },
      { type: 'tool', call: grep },
      { type: 'tool', call: fetch },
      { type: 'text', text: 'Fixed the typo in src/app.ts; no other occurrences.' },
    ], origin('claude', 'anthropic', 'claude-sonnet-4-6')),
  ];
  return markProviderBoundaries({
    version: 1, conversationId: 'conv-1', sessionId: 's-claude', workspace: WORKSPACE, turns,
    touchedFiles: ['src/app.ts'], attachments: [], pendingAttachments: [], openTodos: [],
  }, 'cursor', (command) => localHarnessForCommand(command)?.displayName);
}

function fixedStore() {
  return cursorStore(fixtureRecord(), {
    agentId: '00000000-0000-4000-8000-000000000001', workspace: WORKSPACE, startMs: Date.parse('2026-10-04T12:00:00.000Z'),
    id: sequentialIds('id-'), encryptionKey: '00'.repeat(32), timeZone: 'UTC',
  });
}

/** The store as reviewable JSON: message blobs parsed, protobuf blobs hex. */
function readable(store: ReturnType<typeof fixedStore>): string {
  const blobs = store.blobs.map(({ id, data }) => {
    const text = data.toString('utf8');
    return text.startsWith('{') ? { id, json: JSON.parse(text) } : { id, pb: data.toString('hex') };
  });
  return `${JSON.stringify({ metaFile: store.metaFile, meta: store.meta, rootId: store.rootId, blobs }, null, 2)}\n`;
}

function context(environment: Record<string, string>, version: string | undefined = VERSION): NativeThreadWriteContext {
  return { harness: localHarnessForCommand('cursor')!, workspace: WORKSPACE, environment, model: null, version };
}

describe('cursor thread writer', () => {
  it('writes the golden store', async () => {
    const path = join(HERE, '__golden__', 'cursor.store.json');
    const actual = readable(fixedStore());
    if (process.env.UPDATE_GOLDEN) await writeFile(path, actual, 'utf8');
    expect(actual).toBe(await readFile(path, 'utf8'));
  });

  it('addresses every blob by the sha256 of its bytes, and the root references them', () => {
    const store = fixedStore();
    for (const { id, data } of store.blobs) expect(createHash('sha256').update(data).digest('hex')).toBe(id);
    const root = store.blobs.find((blob) => blob.id === store.rootId)!.data;
    const messages = store.blobs.filter((blob) => blob.data.toString('utf8').startsWith('{"role"'));
    for (const message of messages) expect(root.includes(Buffer.from(message.id, 'hex'))).toBe(true);
  });

  it('gives the model Cursor\'s own tools, and tells a call Cursor has no tool for as text', () => {
    const messages = fixedStore().blobs.flatMap(({ data }) => {
      const text = data.toString('utf8');
      return text.startsWith('{"role"') ? [JSON.parse(text) as { role: string; content: unknown }] : [];
    });
    const calls = messages.flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .filter((part: { type: string }) => part.type === 'tool-call');
    expect(calls.map((part: { toolName: string }) => part.toolName)).toEqual(['Shell', 'StrReplace', 'Grep']);
    expect(calls[0].args).toEqual({ command: 'cat notes.txt' });
    expect(calls[1].args).toEqual({ path: `${WORKSPACE}/src/app.ts`, old_string: 'cosnt x = 1;', new_string: 'const x = 1;' });
    expect(messages[0]).toMatchObject({ role: 'user', content: [{ type: 'text', text: expect.stringContaining('PELICAN-73') }] });
    // The provider switch to Claude is noted on its turn; the fetch is text.
    expect(JSON.stringify(messages)).toContain('the following turns ran on Claude Code');
    expect(JSON.stringify(messages)).toContain('[Fetch https://example.com]');
  });

  it('writes a failed command as Cursor reports one', () => {
    const call: CanonicalToolCall = {
      category: 'run', name: 'Bash', input: { command: 'npm test' }, label: '$ npm test', status: 'failed',
      output: ['1 failing'], exitCode: 1, files: [],
    };
    const mapped = cursorCallFor(call, WORKSPACE, 'call-1')!;
    expect(mapped.result).toBe('Exit code: 1\n\nCommand output:\n\n```\n1 failing\n```');
    // The UI step's failure variant (field 2), with the exit code at 3.
    expect(mapped.step.field).toBe(1);
    expect(mapped.step.body.includes(pb([[1, 'npm test'], [3, 1]]))).toBe(true);
  });

  it('is disabled: no version is tested until a model turn proves a written store', () => {
    expect(CURSOR_WRITER_TESTED_VERSIONS).toEqual([]);
    expect(cursorThreadWriter.versionOk(context({ XDG_CONFIG_HOME: '/p/.config' }))).toBe(false);
    expect(cursorThreadWriter.versionOk(context({ XDG_CONFIG_HOME: '/p/.config' }, undefined))).toBe(false);
    expect(nativeSessionStore({ command: 'cursor' } as NativeThreadWriteContext['harness'])?.writer).toBe(cursorThreadWriter);
  });

  it('places ACP sessions where cursor-agent acp keeps them', () => {
    expect(cursorAcpSessionsRoot({ XDG_CONFIG_HOME: '/p/.config', HOME: '/p' })).toBe('/p/.config/cursor/acp-sessions');
    expect(cursorAcpSessionsRoot({ HOME: '/p' })).toBe('/p/.cursor/acp-sessions');
  });

  it('writes the session directory under the taking-over profile, pinned to ACP', async () => {
    const profile = await mkdtemp(join(tmpdir(), 'cursor-writer-'));
    const environment = { HOME: profile, XDG_CONFIG_HOME: join(profile, '.config') };
    const written = await cursorThreadWriter.write(fixtureRecord(), context(environment));
    expect(written?.transport).toBe('acp');
    const root = join(profile, '.config', 'cursor', 'acp-sessions');
    expect(await readdir(root)).toEqual([written!.nativeId]);
    expect(JSON.parse(await readFile(join(root, written!.nativeId, 'meta.json'), 'utf8'))).toEqual({
      schemaVersion: 1, cwd: WORKSPACE, title: 'Remember the codeword PELICAN-73. Then check what is in n...',
    });
    const sqlite = await import('node:sqlite');
    const db = new sqlite.DatabaseSync(join(root, written!.nativeId, 'store.db'), { readOnly: true });
    try {
      const row = db.prepare("SELECT value FROM meta WHERE key = '0'").get() as { value: string };
      const meta = JSON.parse(Buffer.from(row.value, 'hex').toString('utf8'));
      expect(meta).toMatchObject({ agentId: written!.nativeId, mode: 'default', isRunEverything: false });
      expect(db.prepare('SELECT 1 FROM blobs WHERE id = ?').get(meta.latestRootBlobId)).toBeTruthy();
    } finally {
      db.close();
    }
  });

  it('never writes into the user\'s own Cursor history', async () => {
    await expect(cursorThreadWriter.write(fixtureRecord(), context({}))).resolves.toBeUndefined();
    await expect(cursorThreadWriter.write(fixtureRecord(), context({ HOME: homedir() }))).resolves.toBeUndefined();
    await expect(cursorThreadWriter.write(fixtureRecord(), context({ XDG_CONFIG_HOME: join(homedir(), '.config') }))).resolves.toBeUndefined();
  });

  // Live: the real agent, in scripts/vendor-sandbox.mjs, replays a written
  // store over ACP session/load. No model turn (no quota). Needs a build, a
  // signed-in cursor-agent, and CLIKCODE_LIVE_CURSOR=1.
  const repo = resolve(HERE, '../../../..');
  it.skipIf(!process.env.CLIKCODE_LIVE_CURSOR || !existsSync(join(repo, 'dist', 'harness-catalog.cjs')))(
    'is replayed by cursor-agent acp session/load', () => {
      const result = spawnSync(process.execPath, [
        join(repo, 'scripts', 'verify-thread-writer.mjs'), 'cursor', '--replay-only', '--link', '.config/cursor/auth.json',
        // vitest.setup.ts points HOME at a scratch directory; the sandbox
        // links the sign-in from the real one (and writes nothing there).
      ], { cwd: repo, encoding: 'utf8', timeout: 180_000, env: { ...process.env, HOME: userInfo().homedir } });
      expect(result.stdout).toContain('codeword in replay: yes');
      expect(result.stdout).toMatch(/tool calls: `cat notes\.txt` \[completed\]; Edit `[^`]+src\/app\.ts` \[completed\]/);
      expect(result.status).toBe(0);
    }, 200_000,
  );
});
