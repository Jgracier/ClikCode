/** Golden output of the direct-file thread writers (Pi, Command Code, Qwen,
 * Gemini CLI, Copilot CLI, Aider) for one conversation: a codeword, a
 * Codex shell call, a Claude Edit and a Claude Grep.
 *
 * The golden files under __golden__ are what each vendor was LIVE-verified
 * to resume (see each writer's comment). A change to a serializer that moves
 * its output must be re-verified against the vendor, then the golden file
 * regenerated with `UPDATE_GOLDEN=1`. */

import { describe, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CanonicalOrigin, CanonicalPart, CanonicalRecord, CanonicalToolCall, CanonicalTurn } from '../../canonical.js';
import { localHarnessForCommand } from '@clikcode/router/ai-local-harness';
import type { NativeThreadWriteContext } from '../stores.js';
import { piProjectDirectoryName, piSessionStore, piThreadLines } from './pi-store.js';
import { sequentialIds } from './thread-writer-files.js';

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

export function fixtureRecord(workspace = WORKSPACE): CanonicalRecord {
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

describe('pi thread writer', () => {
  it('writes the golden thread', async () => {
    await golden('pi.jsonl', piThreadLines(fixtureRecord(), {
      sessionId: '0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee', workspace: WORKSPACE, model: 'm', now: NOW, entryId: sequentialIds('e'),
    }));
  });

  it('names the project directory as Pi does', () => {
    expect(piProjectDirectoryName('/var/tmp/wfprobe/ws')).toBe('--var-tmp-wfprobe-ws--');
    expect(piProjectDirectoryName('/a/b.c_d')).toBe('--a-b.c_d--');
  });

  it('writes only under the taking-over profile, where locate finds it', async () => {
    const agent = await mkdtemp(join(tmpdir(), 'pi-writer-'));
    const writer = piSessionStore.writer!;
    const ctx = context('pi', { PI_CODING_AGENT_DIR: agent }, '0.87.0');
    expect(await writer.versionOk(ctx)).toBe(true);
    const written = await writer.write(fixtureRecord(), ctx);
    expect(written?.transport).toBeUndefined();
    const directory = join(agent, 'sessions', '--home-user-projects-app--');
    const files = await readdir(directory);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(new RegExp(`^\\d{4}-\\d\\d-\\d\\dT[\\d-]+Z_${written!.nativeId}\\.jsonl$`));
    const located = await piSessionStore.locate!(join(agent, 'sessions'), written!.nativeId, WORKSPACE, {});
    expect(located?.path).toBe(join(directory, files[0]!));
    expect(JSON.parse((await readFile(located!.path, 'utf8')).split('\n')[0]!)).toMatchObject({ type: 'session', version: 3, id: written!.nativeId, cwd: WORKSPACE });
  });

  it('declines builds it was not verified against', async () => {
    const writer = piSessionStore.writer!;
    expect(await writer.versionOk(context('pi', {}, '0.88.0'))).toBe(false);
    expect(await writer.versionOk(context('pi', {}, undefined))).toBe(false);
  });
});
