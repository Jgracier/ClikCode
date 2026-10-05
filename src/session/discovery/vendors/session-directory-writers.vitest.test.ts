/** Golden output of the thread writers whose vendor resumes a session from a
 * directory or a pair of files (Grok, Kiro, Cline, Kimi, MiniMax Code, OpenClaw, Droid, Auggie, Vibe, Devin), for one
 * conversation: a codeword, a Codex shell call, a Claude Edit and a Claude
 * Grep.
 *
 * Each golden file is what that vendor was LIVE-verified to resume (see each
 * writer's comment). A serializer change that moves its output must be
 * re-verified against the vendor, then the golden regenerated with
 * `UPDATE_GOLDEN=1`. */

import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localHarnessForCommand } from '@clikcode/router/ai-local-harness';
import { markProviderBoundaries, type CanonicalOrigin, type CanonicalPart, type CanonicalRecord, type CanonicalToolCall, type CanonicalTurn } from '../../canonical.js';
import { NATIVE_SESSION_STORES } from '../registry.js';
import type { NativeThreadWriteContext } from '../stores.js';
import { sequentialIds } from './thread-writer-files.js';
import { grokThreadFiles, grokWorkspaceDirectoryName } from './grok-store.js';
import { clineThreadFiles } from './cline-store.js';
import { kimiThreadFiles, kimiWorkDirKey } from './kimi-store.js';
import { kiroThreadFiles } from './kiro-store.js';
import { mcodeSessionRelativeDir, mcodeThreadLines } from './mcode-store.js';
import { openClawCall } from './openclaw-store.js';
import { droidProjectDirectoryName, droidThreadLines } from './droid-store.js';
import { auggieSession } from './auggie-store.js';
import { vibeSessionDirectoryName, vibeThreadFiles } from './vibe-store.js';
import { devinMessages } from './devin-store.js';
import { piThreadLines } from './pi-store.js';
import { HERMES_IMPORT_SPEC, hermesThreadRows } from './hermes-store.js';

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
  // As thread-start hands it to a writer: the switch to Claude is noted.
  return markProviderBoundaries({
    version: 1, conversationId: 'conv-1', sessionId: 's-claude', workspace, turns,
    touchedFiles: ['src/app.ts'], attachments: [], pendingAttachments: [], openTodos: [],
  }, 'codex', (command) => localHarnessForCommand(command)?.displayName);
}

/** fixtureRecord plus a turn that reads one file and writes another, for
 * the writers that map read/write calls natively (Hermes, Kiro). */
function fixtureRecordAllTools(workspace = WORKSPACE): CanonicalRecord {
  const record = fixtureRecord(workspace);
  const read: CanonicalToolCall = {
    id: 'toolu_3', category: 'read', name: 'Read', input: { file_path: 'config.ini' },
    label: 'Read config.ini', target: 'config.ini', status: 'done', output: ['port=8417'], files: [],
  };
  const write: CanonicalToolCall = {
    id: 'toolu_4', category: 'edit', name: 'Write', input: { file_path: 'TODO.md', content: '- ship Thursday\n' },
    label: 'Write TODO.md', target: 'TODO.md', status: 'done', files: ['TODO.md'],
  };
  const from = record.turns[1]!.origin;
  record.turns.push(turn(2, 'Read config.ini and write a TODO.md', [
    { type: 'tool', call: read }, { type: 'tool', call: write },
    { type: 'text', text: 'config.ini sets port 8417. Wrote TODO.md.' },
  ], from));
  return record;
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

describe('cline thread writer', () => {
  it('writes the golden messages and session record', async () => {
    const files = clineThreadFiles(fixtureRecord(), {
      sessionId: '1791160000000_abcde', workspace: WORKSPACE, model: 'anthropic/claude-sonnet-5', now: NOW,
      messagesPath: '/home/user/.cline/data/sessions/1791160000000_abcde/1791160000000_abcde.messages.json',
      callId: sequentialIds('toolu_clikcode_'), messageId: sequentialIds('msg_clikcode_'),
    });
    await golden('cline.messages.json', files.messages);
    await golden('cline.session.json', files.session);
  });

  it('never records an empty model, which Cline cannot load', () => {
    const files = clineThreadFiles(fixtureRecord(), { sessionId: 'x', workspace: WORKSPACE, model: null, now: NOW, messagesPath: '/m' });
    expect(JSON.parse(files.session).model).toBe('claude-sonnet-4-6');
  });

  it('writes both files under the taking-over profile, pinned to ACP, and declines other builds', async () => {
    const home = await mkdtemp(join(tmpdir(), 'cline-writer-'));
    const writer = NATIVE_SESSION_STORES.cline!.writer!;
    const ctx = context('cline', { HOME: home }, '3.0.68');
    expect(await writer.versionOk(ctx)).toBe(true);
    const written = await writer.write(fixtureRecord(), ctx);
    expect(written?.transport).toBe('acp');
    expect(written!.nativeId).toMatch(/^\d{13}_[a-z0-9]{5}$/);
    const directory = join(home, '.cline', 'data', 'sessions', written!.nativeId);
    expect((await readdir(directory)).sort()).toEqual([`${written!.nativeId}.json`, `${written!.nativeId}.messages.json`]);
    const session = JSON.parse(await readFile(join(directory, `${written!.nativeId}.json`), 'utf8'));
    expect(session).toMatchObject({ session_id: written!.nativeId, cwd: WORKSPACE, messages_path: join(directory, `${written!.nativeId}.messages.json`) });

    const data = await mkdtemp(join(tmpdir(), 'cline-data-'));
    const again = await writer.write(fixtureRecord(), context('cline', { HOME: home, CLINE_DATA_DIR: data }, '3.0.68'));
    expect(await readdir(join(data, 'sessions'))).toEqual([again!.nativeId]);

    expect(await writer.versionOk(context('cline', {}, '3.0.69'))).toBe(false);
  });
});

describe('kimi thread writer', () => {
  it('writes the golden wire log and state', async () => {
    const files = kimiThreadFiles(fixtureRecord(), {
      sessionId: 'session_0199aaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', workspace: WORKSPACE, now: NOW,
      directory: '/home/user/.kimi-code/sessions/wd_app_x/session_0199aaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      uuid: sequentialIds('uuid-'), callId: sequentialIds('call_clikcode_'),
    });
    await golden('kimi-wire.jsonl', files.wire);
    expect(JSON.parse(files.state)).toMatchObject({
      id: 'session_0199aaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', version: 2, cwd: WORKSPACE,
      agents: { main: { homedir: '/home/user/.kimi-code/sessions/wd_app_x/session_0199aaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/agents/main', type: 'main' } },
    });
  });

  it('names the workdir bucket as Kimi does', () => {
    expect(kimiWorkDirKey('/var/tmp/wprobe/kmws')).toBe('wd_kmws_c5c6e3059ec1');
    expect(kimiWorkDirKey('/home/justin-gracier')).toBe('wd_justin-gracier_b44802654eba');
    expect(kimiWorkDirKey('/tmp/My Project!/')).toMatch(/^wd_my-project_[0-9a-f]{12}$/);
  });

  it('writes under the taking-over profile, pinned to ACP, and declines other builds', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kimi-writer-'));
    const writer = NATIVE_SESSION_STORES.kimi!.writer!;
    const ctx = context('kimi', { HOME: home }, '2.0.2');
    expect(await writer.versionOk(ctx)).toBe(true);
    const written = await writer.write(fixtureRecord(), ctx);
    expect(written?.transport).toBe('acp');
    expect(written!.nativeId).toMatch(/^session_[0-9a-f-]{36}$/);
    const directory = join(home, '.kimi-code', 'sessions', kimiWorkDirKey(WORKSPACE), written!.nativeId);
    expect((await readdir(directory)).sort()).toEqual(['agents', 'state.json']);
    expect(await readdir(join(directory, 'agents', 'main'))).toEqual(['wire.jsonl']);
    expect(await writer.versionOk(context('kimi', {}, '2.0.3'))).toBe(false);
  });
});

describe('kiro thread writer', () => {
  it('writes the golden conversation and session metadata', async () => {
    const files = kiroThreadFiles(fixtureRecord(), {
      sessionId: '0199aaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', workspace: WORKSPACE, now: NOW,
      messageId: sequentialIds('msg-'), callId: sequentialIds('tooluse_clikcode_'),
    });
    await golden('kiro.jsonl', files.messages);
    await golden('kiro.json', files.session);
  });

  it('writes under the taking-over HOME, pinned to ACP, and declines other builds', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kiro-writer-'));
    const writer = NATIVE_SESSION_STORES.kiro!.writer!;
    const ctx = context('kiro', { HOME: home }, 'kiro-cli 2.23.1');
    expect(await writer.versionOk(ctx)).toBe(true);
    const written = await writer.write(fixtureRecord(), ctx);
    expect(written?.transport).toBe('acp');
    expect((await readdir(join(home, '.kiro', 'sessions', 'cli'))).sort())
      .toEqual([`${written!.nativeId}.json`, `${written!.nativeId}.jsonl`]);
    expect(await writer.versionOk(context('kiro', {}, 'kiro-cli 2.24.0'))).toBe(false);
  });
});

describe('mcode thread writer', () => {
  it('writes the golden messages.jsonl', async () => {
    const text = mcodeThreadLines(fixtureRecord(), {
      sessionId: 'mvs_0f2184cbcb8c4aed97f39c7de65b3416', now: NOW,
      messageId: sequentialIds('id'), turnId: sequentialIds('turn_clikcode_'),
    });
    await golden('mcode.messages.jsonl', text);
  });

  it('names the session directory as mcode does (UTC, unpadded base64 id)', () => {
    expect(mcodeSessionRelativeDir('mvs_5d7e0850e9e7473880433ff242ee9bcb', new Date('2026-10-05T03:22:02.883Z')))
      .toBe('2026/10/05/03-22-02-883-session_bXZzXzVkN2UwODUwZTllNzQ3Mzg4MDQzM2ZmMjQyZWU5YmNi');
  });

  it('registers the thread in the database mcode made, and writes nothing without one', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mcode-writer-'));
    const writer = NATIVE_SESSION_STORES.mcode!.writer!;
    const ctx = context('mcode', { HOME: home }, '0.5.10');
    expect(await writer.versionOk(ctx)).toBe(true);
    expect(await writer.write(fixtureRecord(), ctx)).toBeUndefined();
    await expect(readdir(join(home, '.minimax', 'v2', 'sessions'))).rejects.toThrow();

    const sqliteDir = join(home, '.minimax', 'v2', 'sqlite');
    await mkdir(sqliteDir, { recursive: true });
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(join(sqliteDir, 'runtime-state.sqlite'));
    db.exec(`CREATE TABLE local_runtime_sessions (session_id TEXT PRIMARY KEY, record_json TEXT, updated_at_ms INTEGER,
      columnar_version INTEGER, agent_name TEXT, runtime TEXT, session_type TEXT, status TEXT, archived INTEGER, visibility TEXT,
      session_kind TEXT, workspace_dir TEXT, project_workspace_dir TEXT, is_default_workspace INTEGER, title TEXT,
      created_at_ms INTEGER, extra_data_json TEXT, history_relative_dir TEXT, project_id INTEGER)`);
    db.exec(`CREATE TABLE local_runtime_pi_history_file_migrations (session_id TEXT PRIMARY KEY, migrated_at_ms INTEGER,
      source TEXT, message_count INTEGER, target_revision TEXT)`);
    const written = await writer.write(fixtureRecord(), ctx);
    expect(written?.nativeId).toMatch(/^mvs_[0-9a-f]{32}$/);
    const row = db.prepare('SELECT workspace_dir, title, history_relative_dir FROM local_runtime_sessions WHERE session_id = ?').get(written!.nativeId) as Record<string, string>;
    expect(row).toMatchObject({ workspace_dir: WORKSPACE, title: 'Remember the codeword PELICAN-73. Then check what is in notes.txt.' });
    const text = await readFile(join(home, '.minimax', 'v2', 'sessions', row.history_relative_dir!, 'messages.jsonl'), 'utf8');
    expect(text).toContain('PELICAN-73');
    expect(db.prepare('SELECT source, message_count FROM local_runtime_pi_history_file_migrations').get()).toEqual({ source: 'empty', message_count: 0 });
    db.close();
    expect(await writer.versionOk(context('mcode', {}, '0.5.11'))).toBe(false);
  });
});

describe('openclaw thread writer', () => {
  it('writes the golden legacy transcript (Pi format 4, OpenClaw tool names)', async () => {
    const text = piThreadLines(fixtureRecord(), {
      sessionId: '189fc5d9-eb5f-4189-8d9c-16b27f9730b9', workspace: WORKSPACE, model: null, now: NOW,
      entryId: sequentialIds('e'), mapCall: openClawCall, version: 4,
    });
    await golden('openclaw.jsonl', text);
    expect(text).toContain('"name":"exec"');
  });

  it('writes nothing where OpenClaw never ran or legacy sources wait, and removes its files when the import fails', async () => {
    const home = await mkdtemp(join(tmpdir(), 'openclaw-writer-'));
    const writer = NATIVE_SESSION_STORES.openclaw!.writer!;
    const harness = { ...localHarnessForCommand('openclaw')!, binary: 'clikcode-no-such-openclaw' };
    const ctx = { ...context('openclaw', { HOME: home }, 'OpenClaw 2026.9.6 (eb377ac)'), harness };
    expect(await writer.versionOk(ctx)).toBe(true);
    expect(await writer.write(fixtureRecord(), ctx)).toBeUndefined();

    const agent = join(home, '.openclaw', 'agents', 'main');
    await mkdir(join(agent, 'agent'), { recursive: true });
    await writeFile(join(agent, 'agent', 'openclaw-agent.sqlite'), '');
    await mkdir(join(agent, 'sessions'), { recursive: true });
    await writeFile(join(agent, 'sessions', 'old.jsonl'), '{}\n');
    expect(await writer.write(fixtureRecord(), ctx)).toBeUndefined();
    expect(await readdir(join(agent, 'sessions'))).toEqual(['old.jsonl']);

    await rm(join(agent, 'sessions', 'old.jsonl'));
    expect(await writer.write(fixtureRecord(), ctx)).toBeUndefined();
    expect(await readdir(join(agent, 'sessions'))).toEqual([]);

    expect(await writer.write(fixtureRecord(), { ...ctx, environment: { HOME: home, OPENCLAW_PROFILE: 'work' } })).toBeUndefined();
    expect(await writer.versionOk(context('openclaw', {}, 'OpenClaw 2026.9.7 (abc)'))).toBe(false);
  });
});

describe('droid thread writer', () => {
  it('writes the golden session file', async () => {
    const text = droidThreadLines(fixtureRecord(), {
      sessionId: '0199aaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', workspace: WORKSPACE, now: NOW, messageId: sequentialIds('m-'),
    });
    await golden('droid.jsonl', text);
  });

  it('names the project directory as droid does', () => {
    expect(droidProjectDirectoryName('/var/tmp/probe3/W s_x.y+z')).toBe('-var-tmp-probe3-W s_x.y+z');
  });

  it('writes under the taking-over profile and declines other builds', async () => {
    const home = await mkdtemp(join(tmpdir(), 'droid-writer-'));
    const writer = NATIVE_SESSION_STORES.droid!.writer!;
    const ctx = context('droid', { HOME: home }, '0.223.0');
    expect(await writer.versionOk(ctx)).toBe(true);
    const written = await writer.write(fixtureRecord(), ctx);
    expect(await readdir(join(home, '.factory', 'sessions', '-home-user-projects-app'))).toEqual([`${written!.nativeId}.jsonl`]);
    const factory = await mkdtemp(join(tmpdir(), 'droid-factory-'));
    const again = await writer.write(fixtureRecord(), context('droid', { HOME: home, FACTORY_HOME_OVERRIDE: factory }, '0.223.0'));
    expect(await readdir(join(factory, 'sessions', '-home-user-projects-app'))).toEqual([`${again!.nativeId}.jsonl`]);
    expect(await writer.versionOk(context('droid', {}, '0.224.0'))).toBe(false);
  });
});

describe('auggie thread writer', () => {
  it('writes the golden session file', async () => {
    const text = auggieSession(fixtureRecord(), {
      sessionId: '0199aaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', workspace: WORKSPACE, now: NOW,
      requestId: sequentialIds('req-'), rootTaskUuid: 'root-1',
    });
    await golden('auggie.json', text);
  });

  it('writes under the taking-over HOME and declines other builds', async () => {
    const home = await mkdtemp(join(tmpdir(), 'auggie-writer-'));
    const writer = NATIVE_SESSION_STORES.auggie!.writer!;
    const ctx = context('auggie', { HOME: home }, '0.36.0 (commit 7c61e5bb)');
    expect(await writer.versionOk(ctx)).toBe(true);
    const written = await writer.write(fixtureRecord(), ctx);
    expect(await readdir(join(home, '.augment', 'sessions'))).toEqual([`${written!.nativeId}.json`]);
    expect(await writer.versionOk(context('auggie', {}, '0.37.0 (commit x)'))).toBe(false);
  });
});

describe('vibe thread writer', () => {
  it('writes the golden messages and session metadata', async () => {
    const files = vibeThreadFiles(fixtureRecord(), {
      sessionId: '182a60e3-add0-4988-989a-6aa74de5df7b', workspace: WORKSPACE, now: NOW, messageId: sequentialIds('m-'),
    });
    await golden('vibe.messages.jsonl', files.messages);
    expect(JSON.parse(files.meta)).toMatchObject({
      session_id: '182a60e3-add0-4988-989a-6aa74de5df7b', environment: { working_directory: WORKSPACE }, origin_directory: WORKSPACE,
      total_messages: files.messages.trimEnd().split('\n').length,
    });
  });

  it('names the session directory as vibe does', () => {
    expect(vibeSessionDirectoryName('c148cd9a-16f7-6ff0-3fb0-310cac9a4e77', new Date('2026-10-05T03:52:54.512Z')))
      .toBe('session_20261005_035254_c148cd9a');
  });

  it('writes under the taking-over VIBE_HOME, declines a moved store and other builds', async () => {
    const home = await mkdtemp(join(tmpdir(), 'vibe-writer-'));
    const writer = NATIVE_SESSION_STORES.vibe!.writer!;
    const ctx = context('vibe', { HOME: home }, 'vibe 2.25.7');
    expect(await writer.versionOk(ctx)).toBe(true);
    const written = await writer.write(fixtureRecord(), ctx);
    const [directory] = await readdir(join(home, '.vibe', 'logs', 'session'));
    expect(directory).toMatch(new RegExp(`^session_\\d{8}_\\d{6}_${written!.nativeId.slice(0, 8)}$`));
    const vibeHome = await mkdtemp(join(tmpdir(), 'vibe-home-'));
    await writeFile(join(vibeHome, 'config.toml'), '[session_logging]\nsave_dir = "/elsewhere"\n');
    expect(await writer.write(fixtureRecord(), context('vibe', { HOME: home, VIBE_HOME: vibeHome }, 'vibe 2.25.7'))).toBeUndefined();
    expect(await writer.versionOk(context('vibe', {}, 'vibe 2.26.0'))).toBe(false);
  });
});

describe('devin thread writer', () => {
  it('writes the golden message chain', async () => {
    const messages = devinMessages(fixtureRecord(), { now: NOW, messageId: sequentialIds('m-') });
    await golden('devin.messages.jsonl', `${messages.map((message) => JSON.stringify(message)).join('\n')}\n`);
  });

  it('adds a session and its chain to the database Devin made, and writes nothing without one', async () => {
    const home = await mkdtemp(join(tmpdir(), 'devin-writer-'));
    const writer = NATIVE_SESSION_STORES.devin!.writer!;
    const ctx = context('devin', { HOME: home }, 'devin 3000.11.3 (9c803229faa4)');
    expect(await writer.versionOk(ctx)).toBe(true);
    expect(await writer.write(fixtureRecord(), ctx)).toBeUndefined();

    const cli = join(home, '.local', 'share', 'devin', 'cli');
    await mkdir(cli, { recursive: true });
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(join(cli, 'sessions.db'));
    db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, working_directory TEXT NOT NULL, backend_type TEXT NOT NULL,
      model TEXT NOT NULL, agent_mode TEXT NOT NULL, created_at INTEGER NOT NULL, last_activity_at INTEGER NOT NULL, title TEXT,
      main_chain_id INTEGER, shell_last_seen_index INTEGER DEFAULT 0, cogs_json TEXT, workspace_dirs TEXT,
      hidden INTEGER NOT NULL DEFAULT 0, metadata TEXT)`);
    db.exec(`CREATE TABLE message_nodes (row_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, node_id INTEGER NOT NULL,
      parent_node_id INTEGER, chat_message TEXT NOT NULL, created_at INTEGER NOT NULL, metadata TEXT, UNIQUE(session_id, node_id))`);
    const written = await writer.write(fixtureRecord(), ctx);
    expect(written?.nativeId).toMatch(/^clikcode-[0-9a-f]{12}$/);
    const session = db.prepare('SELECT working_directory, main_chain_id FROM sessions WHERE id = ?').get(written!.nativeId) as Record<string, unknown>;
    const nodes = db.prepare('SELECT node_id, parent_node_id FROM message_nodes WHERE session_id = ? ORDER BY node_id').all(written!.nativeId) as Record<string, unknown>[];
    expect(session).toEqual({ working_directory: WORKSPACE, main_chain_id: nodes.length - 1 });
    expect(nodes[0]).toEqual({ node_id: 0, parent_node_id: null });
    expect(nodes.at(-1)).toEqual({ node_id: nodes.length - 1, parent_node_id: nodes.length - 2 });
    db.close();
    expect(await writer.versionOk(context('devin', {}, 'devin 3000.12.0 (x)'))).toBe(false);
  });
});

const sqlite = await import('node:sqlite').then((module) => module, () => undefined);

describe('hermes thread writer', () => {
  it('writes the golden session and message rows', async () => {
    const rows = hermesThreadRows(fixtureRecordAllTools(), {
      sessionId: '0199aaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', workspace: WORKSPACE, model: 'm', now: NOW, callId: sequentialIds('call_clikcode_'),
    });
    await golden('hermes.json', `${JSON.stringify(rows, null, 2)}\n`);
  });

  /** Hermes' tables trimmed to what a written thread fills, with the
   * required-column checks of the real schema. */
  async function hermesHome(extraSessionColumns = 'model TEXT, model_config TEXT, cwd TEXT, last_activity_at REAL, tool_call_count INTEGER DEFAULT 0,'): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), 'hermes-writer-'));
    const db = new (sqlite as any).DatabaseSync(join(home, 'state.db'));
    db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, ${extraSessionColumns} title TEXT,
      started_at REAL NOT NULL, message_count INTEGER DEFAULT 0)`);
    db.exec(`CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id),
      role TEXT NOT NULL, content TEXT, tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL NOT NULL,
      finish_reason TEXT, active INTEGER NOT NULL DEFAULT 1)`);
    db.exec(`INSERT INTO sessions (id, source, started_at) VALUES ('mine', 'cli', 1)`);
    db.exec(`INSERT INTO messages (session_id, role, content, timestamp) VALUES ('mine', 'user', 'keep me', 1)`);
    db.close();
    return home;
  }

  it.skipIf(!sqlite)('adds an ACP-source session to the account database, unpinned, beside its own sessions', async () => {
    const home = await hermesHome();
    const writer = NATIVE_SESSION_STORES.hermes!.writer!;
    const ctx = context('hermes', { HERMES_HOME: home }, 'Hermes Agent v0.20.5 (2026.8.19)');
    expect(await writer.versionOk(ctx)).toBe(true);
    const written = await writer.write(fixtureRecordAllTools(), ctx);
    expect(written).toEqual({ nativeId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    const db = new (sqlite as any).DatabaseSync(join(home, 'state.db'));
    try {
      expect(db.prepare('SELECT id, source, model, message_count, tool_call_count FROM sessions ORDER BY rowid').all().map((row: object) => ({ ...row })))
        .toEqual([
          { id: 'mine', source: 'cli', model: null, message_count: 0, tool_call_count: 0 },
          { id: written!.nativeId, source: 'acp', model: 'm', message_count: 14, tool_call_count: 5 },
        ]);
      const roles = db.prepare('SELECT role, tool_name FROM messages WHERE session_id = ? ORDER BY id').all(written!.nativeId)
        .map((row: { role: string; tool_name: string | null }) => row.tool_name ? `${row.role}:${row.tool_name}` : row.role);
      expect(roles).toEqual(['user', 'assistant', 'tool:terminal', 'assistant', 'user', 'assistant', 'tool:patch', 'tool:search_files', 'assistant',
        'user', 'assistant', 'tool:read_file', 'tool:write_file', 'assistant']);
      expect(db.prepare(`SELECT content FROM messages WHERE session_id = 'mine'`).all().map((row: { content: string }) => row.content)).toEqual(['keep me']);
    } finally { db.close(); }
    expect(await writer.versionOk(context('hermes', {}, 'Hermes Agent v0.20.6'))).toBe(false);
  });

  it.skipIf(!sqlite)('declines a database without the columns it was verified on', async () => {
    const home = await hermesHome('');
    expect(await NATIVE_SESSION_STORES.hermes!.writer!.write(fixtureRecordAllTools(), context('hermes', { HERMES_HOME: home }, '0.20.5'))).toBeUndefined();
  });

  it('falls back to the import, pinned to the CLI, with the import argv Hermes takes', () => {
    expect(HERMES_IMPORT_SPEC.argv('/t/x.jsonl')).toEqual(['sessions', 'import', '--from', 'claude', '/t/x.jsonl']);
    expect(HERMES_IMPORT_SPEC.parse('✓ Imported Claude Code session as 20261004_1_abc')).toBe('20261004_1_abc');
    expect(HERMES_IMPORT_SPEC.transport).toBe('text-cli');
  });
});
