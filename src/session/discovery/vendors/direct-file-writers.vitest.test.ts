/** Golden output of the direct-file thread writers (Pi, Command Code, Qwen,
 * Gemini CLI, Copilot CLI, Aider) for one conversation: a codeword, a
 * Codex shell call, a Claude Edit and a Claude Grep.
 *
 * The golden files under __golden__ are what each vendor was LIVE-verified
 * to resume (see each writer's comment). A change to a serializer that moves
 * its output must be re-verified against the vendor, then the golden file
 * regenerated with `UPDATE_GOLDEN=1`. */

import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { markProviderBoundaries, type CanonicalOrigin, type CanonicalPart, type CanonicalRecord, type CanonicalToolCall, type CanonicalTurn } from '../../canonical.js';
import { localHarnessForCommand } from '@clikcode/router/ai-local-harness';
import type { NativeThreadWriteContext } from '../stores.js';
import { piProjectDirectoryName, piSessionStore, piThreadLines } from './pi-store.js';
import { sequentialIds } from './thread-writer-files.js';
import { aiderHistoryMarkdown, aiderSessionStore } from './aider-store.js';
import { harnessStatePath } from '../../state/paths.js';
import { copilotSessionStore, copilotThreadFiles } from './copilot-store.js';
import { geminiProjectSlug, geminiSessionStore, geminiThreadLines } from './gemini-store.js';
import { qwenProjectDirectoryName, qwenSessionStore, qwenThreadLines } from './qwen-store.js';
import { commandProjectSlug, commandSessionStore, commandThreadLines } from './command-store.js';

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
  // As thread-start hands it to a writer: the switch to Claude is noted.
  return markProviderBoundaries({
    version: 1, conversationId: 'conv-1', sessionId: 's-claude', workspace, turns,
    touchedFiles: ['src/app.ts'], attachments: [], pendingAttachments: [], openTodos: [],
  }, 'codex', (command) => localHarnessForCommand(command)?.displayName);
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

describe('command code thread writer', () => {
  it('writes the golden thread', async () => {
    await golden('command.jsonl', commandThreadLines(fixtureRecord(), {
      sessionId: '11111111-2222-4333-8444-555555555555', workspace: WORKSPACE, model: 'm', now: NOW,
      entryId: sequentialIds('e'), messageId: sequentialIds('m'),
    }));
  });

  it('writes under the taking-over HOME, where locate finds it, and declines other builds', async () => {
    const home = await mkdtemp(join(tmpdir(), 'cmd-writer-'));
    const writer = commandSessionStore.writer!;
    const ctx = context('command', { HOME: home }, '1.74.1');
    expect(await writer.versionOk(ctx)).toBe(true);
    const written = await writer.write(fixtureRecord(), ctx);
    expect(await readdir(join(home, '.commandcode', 'projects', commandProjectSlug(WORKSPACE)))).toEqual([`${written!.nativeId}.jsonl`]);
    const root = commandSessionStore.root({ HOME: home })!;
    expect((await commandSessionStore.locate!(root, written!.nativeId, WORKSPACE, {}))?.path)
      .toBe(join(root, 'home-user-projects-app', `${written!.nativeId}.jsonl`));
    expect(await writer.versionOk(context('command', {}, '1.75.0'))).toBe(false);
  });
});

describe('qwen thread writer', () => {
  it('writes the golden thread', async () => {
    await golden('qwen.jsonl', qwenThreadLines(fixtureRecord(), {
      sessionId: '22222222-3333-4444-8555-666666666666', workspace: WORKSPACE, model: 'm', version: '0.24.3', now: NOW,
      uuid: sequentialIds('u-'),
    }));
  });

  it('writes under the taking-over QWEN_HOME, where locate finds it, and declines other builds', async () => {
    const home = await mkdtemp(join(tmpdir(), 'qwen-writer-'));
    const writer = qwenSessionStore.writer!;
    const ctx = context('qwen', { QWEN_HOME: home }, '0.24.3');
    expect(await writer.versionOk(ctx)).toBe(true);
    const written = await writer.write(fixtureRecord(), ctx);
    expect(written?.transport).toBeUndefined();
    const directory = join(home, 'projects', qwenProjectDirectoryName(WORKSPACE), 'chats');
    expect(await readdir(directory)).toEqual([`${written!.nativeId}.jsonl`]);
    expect((await qwenSessionStore.locate!(qwenSessionStore.root({ QWEN_HOME: home })!, written!.nativeId, WORKSPACE, {}))?.path)
      .toBe(join(directory, `${written!.nativeId}.jsonl`));
    const first = JSON.parse((await readFile(join(directory, `${written!.nativeId}.jsonl`), 'utf8')).split('\n')[0]!);
    expect(first).toMatchObject({ sessionId: written!.nativeId, parentUuid: null, type: 'user', cwd: WORKSPACE, version: '0.24.3' });
    expect(await writer.versionOk(context('qwen', {}, '0.25.0'))).toBe(false);
  });
});

describe('gemini thread writer', () => {
  it('writes the golden thread', async () => {
    await golden('gemini.jsonl', geminiThreadLines(fixtureRecord(), {
      sessionId: '33333333-4444-4555-8666-777777777777', workspace: WORKSPACE, model: 'm', now: NOW, messageId: sequentialIds('g-'),
    }));
  });

  it('slugs a project folder as Gemini does', () => {
    expect(geminiProjectSlug('/home/user/My Project.v2')).toBe('my-project-v2');
    expect(geminiProjectSlug('/')).toBe('project');
  });

  it('is enabled for the verified build only', async () => {
    const writer = geminiSessionStore.writer!;
    expect(writer.testedVersions).toEqual(['0.62.0']);
    expect(await writer.versionOk(context('gemini', {}, '0.62.0'))).toBe(true);
    expect(await writer.versionOk(context('gemini', {}, '0.63.0'))).toBe(false);
    expect(await writer.versionOk(context('gemini', {}, undefined))).toBe(false);
  });

  it('registers the project as Gemini would and writes where locate finds it', async () => {
    const home = await mkdtemp(join(tmpdir(), 'gemini-writer-'));
    const gemini = join(home, '.gemini');
    // Another folder already owns the plain slug: the next one is taken.
    await mkdir(join(gemini, 'tmp', 'app'), { recursive: true });
    await writeFile(join(gemini, 'projects.json'), JSON.stringify({ projects: { '/elsewhere/app': 'app' } }), 'utf8');
    const written = await geminiSessionStore.writer!.write(fixtureRecord(), context('gemini', { GEMINI_CLI_HOME: home }, '0.62.0'));
    // ACP session/load wipes a thread it did not start: the CLI resumes it.
    expect(written?.transport).toBe('structured-cli');
    expect(JSON.parse(await readFile(join(gemini, 'projects.json'), 'utf8')).projects)
      .toEqual({ '/elsewhere/app': 'app', [WORKSPACE]: 'app-1' });
    await expect(readFile(join(gemini, 'tmp', 'app-1', '.project_root'), 'utf8')).resolves.toBe(WORKSPACE);
    await expect(readFile(join(gemini, 'history', 'app-1', '.project_root'), 'utf8')).resolves.toBe(WORKSPACE);
    const located = await geminiSessionStore.locate!(join(gemini, 'tmp'), written!.nativeId, WORKSPACE, {});
    expect(located?.path).toMatch(new RegExp(`/tmp/app-1/chats/session-\\d{4}-\\d\\d-\\d\\dT\\d\\d-\\d\\d-${written!.nativeId.slice(0, 8)}\\.jsonl$`));
    await expect(readdir(join(gemini))).resolves.not.toContain('projects.json.lock');
  });

  it('declines while Gemini holds its registry lock', async () => {
    const home = await mkdtemp(join(tmpdir(), 'gemini-writer-'));
    await mkdir(join(home, '.gemini', 'projects.json.lock'), { recursive: true });
    await expect(geminiSessionStore.writer!.write(fixtureRecord(), context('gemini', { GEMINI_CLI_HOME: home }, '0.62.0'))).resolves.toBeUndefined();
  });
});

describe('copilot thread writer', () => {
  it('writes the golden session', async () => {
    const files = copilotThreadFiles(fixtureRecord(), {
      sessionId: '44444444-5555-4666-8777-888888888888', workspace: WORKSPACE, model: 'm', version: '1.0.91', now: NOW,
      uuid: sequentialIds('c-'),
    });
    await golden('copilot.events.jsonl', files.events);
    await golden('copilot.workspace.yaml', files.workspace);
  });

  it('writes the session directory under the taking-over COPILOT_HOME, and declines other builds', async () => {
    const home = await mkdtemp(join(tmpdir(), 'copilot-writer-'));
    const writer = copilotSessionStore.writer!;
    const ctx = context('copilot', { COPILOT_HOME: home }, 'GitHub Copilot CLI 1.0.91.');
    expect(await writer.versionOk(ctx)).toBe(true);
    const written = await writer.write(fixtureRecord(), ctx);
    expect(written?.transport).toBeUndefined();
    expect(await readdir(join(home, 'session-state'))).toEqual([written!.nativeId]);
    expect((await readdir(join(home, 'session-state', written!.nativeId))).sort()).toEqual(['events.jsonl', 'workspace.yaml']);
    expect((await copilotSessionStore.locate!(join(home, 'session-state'), written!.nativeId, WORKSPACE, {}))?.path)
      .toBe(join(home, 'session-state', written!.nativeId));
    expect(await readFile(join(home, 'session-state', written!.nativeId, 'workspace.yaml'), 'utf8'))
      .toContain(`id: ${written!.nativeId}\ncwd: "${WORKSPACE}"\n`);
    expect(await writer.versionOk(context('copilot', {}, 'GitHub Copilot CLI 1.0.92.'))).toBe(false);
  });
});

describe('aider thread writer', () => {
  it('writes the golden history', async () => {
    // Local time, as Aider's own heading is.
    await golden('aider.history.md', aiderHistoryMarkdown(fixtureRecord(), new Date(2026, 9, 4, 12, 0, 0)));
  });

  it('keeps every assistant line the assistant\'s', () => {
    const record = fixtureRecord();
    record.turns = [{ ...record.turns[0]!, parts: [{ type: 'text', text: '# Heading\n> quoted\n#### not a request' }] }];
    const text = aiderHistoryMarkdown(record, new Date(2026, 9, 4, 12, 0, 0));
    expect(text).toContain('\n # Heading\n > quoted\n #### not a request\n');
  });

  it('writes a new history file in ClikCode\'s own aider directory, never the workspace', async () => {
    const writer = aiderSessionStore.writer!;
    const ctx = context('aider', {}, 'aider 0.86.2');
    expect(await writer.versionOk(ctx)).toBe(true);
    const written = await writer.write(fixtureRecord(), ctx);
    const directory = join(dirname(harnessStatePath()), 'native', 'aider');
    expect(dirname(written!.nativeId)).toBe(directory);
    expect(written!.nativeId).toMatch(/\.history\.md$/);
    expect(await readFile(written!.nativeId, 'utf8')).toContain('#### Remember the codeword PELICAN-73.');
    expect(await writer.versionOk(context('aider', {}, 'aider 0.87.0'))).toBe(false);
  });
});
