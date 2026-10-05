/** Golden output of the thread writers whose vendor resumes a session from a
 * directory or a pair of files (Grok, Kiro, Cline, Kimi), for one
 * conversation: a codeword, a Codex shell call, a Claude Edit and a Claude
 * Grep.
 *
 * Each golden file is what that vendor was LIVE-verified to resume (see each
 * writer's comment). A serializer change that moves its output must be
 * re-verified against the vendor, then the golden regenerated with
 * `UPDATE_GOLDEN=1`. */

import { describe, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localHarnessForCommand } from '@clikcode/router/ai-local-harness';
import type { CanonicalOrigin, CanonicalPart, CanonicalRecord, CanonicalToolCall, CanonicalTurn } from '../../canonical.js';
import { NATIVE_SESSION_STORES } from '../registry.js';
import type { NativeThreadWriteContext } from '../stores.js';
import { sequentialIds } from './thread-writer-files.js';
import { grokThreadFiles, grokWorkspaceDirectoryName } from './grok-store.js';

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), '__golden__');
const WORKSPACE = '/home/user/projects/app';
const NOW = new Date('2026-10-04T12:00:00.000Z');

async function golden(name: string, actual: string): Promise<void> {
  const path = join(GOLDEN, name);
  if (process.env.UPDATE_GOLDEN) await writeFile(path, actual, 'utf8');
  expect(actual).toBe(await readFile(path, 'utf8'));
}

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

function fixtureRecord(workspace = WORKSPACE): CanonicalRecord {
  const shell: CanonicalToolCall = {
    id: 'call_codex_1', category: 'run', name: 'shell', input: { command: ['bash', '-lc', 'cat notes.txt'] },
    label: '$ cat notes.txt', target: 'cat notes.txt', status: 'done', output: ['launch window: Thursday'], exitCode: 0, files: [],
  };
  const edit: CanonicalToolCall = {
    id: 'toolu_1', category: 'edit', name: 'Edit',
    input: { file_path: 'src/app.ts', old_string: 'cosnt x = 1;', new_string: 'const x = 1;' },
    label: 'Edit src/app.ts', target: 'src/app.ts', status: 'done', files: ['src/app.ts'],
    diff: [{ path: 'src/app.ts', change: 'update', lines: [{ kind: 'removed', text: 'cosnt x = 1;' }, { kind: 'added', text: 'const x = 1;' }], additions: 1, removals: 1 }],
  };
  const grep: CanonicalToolCall = {
    id: 'toolu_2', category: 'search', name: 'Grep', input: { pattern: 'cosnt' },
    label: 'Grep cosnt', target: 'cosnt', status: 'done', output: ['(no matches)'], files: [],
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
      { type: 'text', text: 'Fixed the typo in src/app.ts; no other occurrences.' },
    ], origin('claude', 'anthropic', 'claude-sonnet-4-6')),
  ];
  return {
    version: 1, conversationId: 'conv-1', sessionId: 's-claude', workspace, turns,
    touchedFiles: ['src/app.ts'], attachments: [], pendingAttachments: [], openTodos: [],
  };
}

function context(command: string, environment: Record<string, string>, version: string | undefined): NativeThreadWriteContext {
  return { harness: localHarnessForCommand(command)!, workspace: WORKSPACE, environment, model: 'm', version };
}

describe('grok thread writer', () => {
  const NOON_LOCAL = new Date(2026, 9, 4, 12, 0, 0);

  it('writes the golden chat history and summary', async () => {
    const files = grokThreadFiles(fixtureRecord(), {
      sessionId: '0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee', workspace: WORKSPACE, model: 'grok-4.7', now: NOON_LOCAL,
      platform: 'linux', shell: '/bin/bash', callId: sequentialIds('call-clikcode-'),
    });
    await golden('grok-chat_history.jsonl', files.chatHistory);
    expect(JSON.parse(files.summary)).toMatchObject({
      info: { id: '0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee', cwd: WORKSPACE }, num_messages: 10, current_model_id: 'grok-4.7',
      session_summary: 'Remember the codeword PELICAN-73. Then check what is in note',
    });
  });

  it('names the workspace group as Grok does', () => {
    expect(grokWorkspaceDirectoryName('/var/tmp/wprobe/ws')).toBe('%2Fvar%2Ftmp%2Fwprobe%2Fws');
    expect(grokWorkspaceDirectoryName('/var/tmp/wprobe/w s+@~%é_.-x(1)')).toBe('%2Fvar%2Ftmp%2Fwprobe%2Fw%20s%2B%40~%25%C3%A9_.-x%281%29');
    expect(grokWorkspaceDirectoryName(`/${'a'.repeat(300)}`)).toBeUndefined();
  });

  it('writes under the taking-over HOME (or GROK_HOME) only, and declines other builds', async () => {
    const home = await mkdtemp(join(tmpdir(), 'grok-writer-'));
    const writer = NATIVE_SESSION_STORES.grok!.writer!;
    const ctx = context('grok', { HOME: home }, 'grok 1.0.46 (2765805b9442) [stable]');
    expect(await writer.versionOk(ctx)).toBe(true);
    const written = await writer.write(fixtureRecord(), ctx);
    expect(written?.transport).toBeUndefined();
    const group = join(home, '.grok', 'sessions', '%2Fhome%2Fuser%2Fprojects%2Fapp');
    expect(await readdir(group)).toEqual([written!.nativeId]);
    expect((await readdir(join(group, written!.nativeId))).sort()).toEqual(['chat_history.jsonl', 'summary.json']);

    const grokHome = await mkdtemp(join(tmpdir(), 'grok-home-'));
    const again = await writer.write(fixtureRecord(), context('grok', { HOME: home, GROK_HOME: grokHome }, '1.0.46'));
    expect(await readdir(join(grokHome, 'sessions', '%2Fhome%2Fuser%2Fprojects%2Fapp'))).toEqual([again!.nativeId]);

    expect(await writer.versionOk(context('grok', {}, 'grok 1.0.47 (abc) [stable]'))).toBe(false);
    expect(await writer.versionOk(context('grok', {}, undefined))).toBe(false);
  });
});
