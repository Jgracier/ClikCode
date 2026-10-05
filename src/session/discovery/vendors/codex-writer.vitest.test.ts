import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { markProviderBoundaries, type CanonicalOrigin, type CanonicalRecord, type CanonicalToolCall, type CanonicalTurn } from '../../canonical';
import type { NativeThreadWriteContext } from '../stores';
import { nativeSessionStore } from '../registry';
import { codexCallFor, codexRolloutRecords, codexRolloutRelativePath, codexThreadWriter, uuidv7 } from './codex-writer';

const sqlite = await import('node:sqlite').then((m) => m, () => undefined);

const ORIGIN: CanonicalOrigin = { sessionId: 's1', harness: 'claude', route: 'native', provider: 'anthropic', model: 'claude-opus-5-5' };

function turn(index: number, user: string, parts: CanonicalTurn['parts'], extra: Partial<CanonicalTurn> = {}): CanonicalTurn {
  return { index, user, attachments: [], parts, assistant: '', tools: [], touchedFiles: [], interrupted: false, origin: ORIGIN, ...extra };
}

function call(overrides: Partial<CanonicalToolCall> & Pick<CanonicalToolCall, 'name'>): CanonicalToolCall {
  return { label: overrides.name, status: 'done', files: [], ...overrides };
}

/** The record the live check resumed (codex-cli 0.155.1, gpt-5.6-luna): a
 *  codeword, then a Claude Bash and Edit. */
function liveRecord(workspace = '/ws'): CanonicalRecord {
  return {
    version: 1, conversationId: 'c1', sessionId: 's1', workspace, touchedFiles: [`${workspace}/notes.txt`],
    attachments: [], pendingAttachments: [], openTodos: [],
    turns: [
      turn(0, 'Remember this codeword for later: TANGERINE-LIGHTHOUSE-58. Just acknowledge it.', [
        { type: 'text', text: 'Noted: the codeword is TANGERINE-LIGHTHOUSE-58.' },
      ]),
      turn(1, 'List the files here, then change the color in notes.txt from blue to green.', [
        { type: 'text', text: 'Let me look at the folder first.' },
        { type: 'tool', call: call({ id: 'toolu_01', category: 'run', name: 'Bash', input: { command: 'ls -1', description: 'List files' }, label: '$ ls -1', target: 'ls -1', output: ['notes.txt'], exitCode: 0 }) },
        { type: 'tool', call: call({ id: 'toolu_02', category: 'edit', name: 'Edit', input: { file_path: `${workspace}/notes.txt`, old_string: 'color = blue', new_string: 'color = green' }, label: 'Edit notes.txt', target: 'notes.txt', output: ['The file has been updated.'], files: [`${workspace}/notes.txt`] }) },
        { type: 'text', text: 'Done: notes.txt now says color = green (it was blue).' },
      ]),
    ],
  };
}

/** Deterministic, UUID-shaped ids for golden output. */
function counter(): (ms: number) => string {
  let next = 0;
  return () => `00000000-0000-7000-8000-${String(++next).padStart(12, '0')}`;
}

const THREAD = '01a109dc-3331-7132-bf6a-c88f712aa641';
const START = Date.UTC(2026, 9, 4, 12, 0, 0);

describe('codexRolloutRecords', () => {
  it('writes the layout codex-cli 0.155.1 resumed (golden)', async () => {
    const records = codexRolloutRecords(markProviderBoundaries(liveRecord(), 'codex'), { threadId: THREAD, workspace: '/ws', cliVersion: '0.155.1', startMs: START, id: counter() });
    await expect(`${records.map((record) => JSON.stringify(record)).join('\n')}\n`).toMatchFileSnapshot('./codex-writer.golden.jsonl');
  });

  it('numbers every record and opens with session_meta', () => {
    const records = codexRolloutRecords(liveRecord(), { threadId: THREAD, workspace: '/ws', cliVersion: '0.155.1', startMs: START, id: counter() });
    expect(records.map((record) => record.ordinal)).toEqual(records.map((_, index) => index));
    expect(records[0]).toMatchObject({ type: 'session_meta', payload: { id: THREAD, session_id: THREAD, cwd: '/ws', history_mode: 'paginated' } });
    expect(JSON.stringify(records)).not.toMatch(/reasoning|encrypted_content/);
  });

  it('writes an interrupted last turn as aborted, its open call unfinished', () => {
    const record = liveRecord();
    record.turns.push(turn(2, 'Now run the tests.', [
      { type: 'text', text: 'Running them.' },
      { type: 'tool', call: call({ category: 'run', name: 'Bash', input: { command: 'npm test' }, status: 'unfinished' }) },
    ], { interrupted: true }));
    const records = codexRolloutRecords(record, { threadId: THREAD, workspace: '/ws', cliVersion: '0.155.1', startMs: START, id: counter() });
    const last = records.at(-1)!;
    expect(last).toMatchObject({ type: 'event_msg', payload: { type: 'turn_aborted', reason: 'interrupted' } });
    const tail = records.slice(records.findLastIndex((item) => (item.payload as { type?: string }).type === 'task_started'));
    expect(JSON.stringify(tail)).not.toContain('final_answer');
    const output = tail.find((item) => (item.payload as { type?: string }).type === 'custom_tool_call_output')!;
    expect(JSON.stringify(output)).toContain('aborted');
  });

  it('names the file as Codex does, in local time', () => {
    const at = new Date(2026, 9, 4, 8, 5, 9).getTime();
    expect(codexRolloutRelativePath(THREAD, at)).toBe(join('sessions', '2026', '10', '04', `rollout-2026-10-04T08-05-09-${THREAD}.jsonl`));
  });
});

describe('codexCallFor', () => {
  it('maps a Claude Bash to exec_command', () => {
    expect(codexCallFor(call({ name: 'Bash', input: { command: 'ls' } }), '/ws')).toEqual({ kind: 'command', cmd: 'ls' });
  });
  it('maps a Claude Edit to an apply_patch update', () => {
    const mapped = codexCallFor(call({ name: 'Edit', category: 'edit', input: { file_path: 'a.txt', old_string: 'x\ny', new_string: 'z' } }), '/ws');
    expect(mapped).toMatchObject({ kind: 'patch', patch: '*** Begin Patch\n*** Update File: /ws/a.txt\n@@\n-x\n-y\n+z\n*** End Patch' });
  });
  it('maps a Write to an apply_patch add', () => {
    const mapped = codexCallFor(call({ name: 'Write', input: { file_path: '/ws/b.txt', content: 'one\ntwo\n' } }), '/ws');
    expect(mapped).toMatchObject({ kind: 'patch', patch: '*** Begin Patch\n*** Add File: /ws/b.txt\n+one\n+two\n*** End Patch' });
  });
  it('keeps a recorded apply_patch as it was', () => {
    const patch = '*** Begin Patch\n*** Update File: c.ts\n@@\n-a\n+b\n*** End Patch';
    expect(codexCallFor(call({ name: 'apply_patch', input: { input: patch } }), '/ws')).toEqual({ kind: 'patch', patch, changes: { '/ws/c.ts': { type: 'update', unified_diff: '' } } });
  });
  it('maps reads and searches to the shell command Codex runs for them', () => {
    expect(codexCallFor(call({ name: 'Read', input: { file_path: '/ws/my file.ts' } }), '/ws')).toEqual({ kind: 'command', cmd: "cat '/ws/my file.ts'" });
    expect(codexCallFor(call({ name: 'Grep', input: { pattern: 'TODO', path: 'src' } }), '/ws')).toEqual({ kind: 'command', cmd: 'rg -n TODO src' });
    expect(codexCallFor(call({ name: 'Glob', input: { pattern: '*.ts' } }), '/ws')).toEqual({ kind: 'command', cmd: "rg --files -g '*.ts'" });
  });
  it('maps an old call with only its row', () => {
    expect(codexCallFor(call({ name: 'shell', label: '$ npm test', target: 'npm test' }), '/ws')).toEqual({ kind: 'command', cmd: 'npm test' });
  });
  it('keeps anything else as a function call under its own name', () => {
    expect(codexCallFor(call({ name: 'mcp__github__create_issue', input: { title: 't' } }), '/ws'))
      .toEqual({ kind: 'function', name: 'mcp__github__create_issue', arguments: '{"title":"t"}' });
  });
});

describe('codexThreadWriter', () => {
  const context = (environment: Record<string, string>, version = 'codex-cli 0.155.1', workspace = '/ws'): NativeThreadWriteContext => ({
    harness: { command: 'codex' } as NativeThreadWriteContext['harness'], workspace, environment, model: 'gpt-5.6-luna', version,
  });

  it('is registered on the Codex store', () => {
    expect(nativeSessionStore({ command: 'codex' } as NativeThreadWriteContext['harness'])?.writer).toBe(codexThreadWriter);
  });

  it('accepts only the verified build', () => {
    expect(codexThreadWriter.versionOk(context({}, 'codex-cli 0.155.1'))).toBe(true);
    expect(codexThreadWriter.versionOk(context({}, 'codex-cli 0.156.0'))).toBe(false);
    expect(codexThreadWriter.versionOk({ ...context({}), version: undefined })).toBe(false);
  });

  it('declines without a profile CODEX_HOME, or with the real ~/.codex', async () => {
    expect(await codexThreadWriter.write(liveRecord(), context({}))).toBeUndefined();
    expect(await codexThreadWriter.write(liveRecord(), context({ CODEX_HOME: join(homedir(), '.codex') }))).toBeUndefined();
  });

  it('writes a new rollout under CODEX_HOME that a locate finds', async () => {
    const home = await mkdtemp(join(tmpdir(), 'clikcode-codex-writer-'));
    if (sqlite) {
      const db = new (sqlite as any).DatabaseSync(join(home, 'state_5.sqlite'));
      db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)');
      db.close();
    }
    const written = await codexThreadWriter.write(liveRecord('/ws'), context({ CODEX_HOME: home }));
    expect(written?.nativeId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const store = nativeSessionStore({ command: 'codex' } as NativeThreadWriteContext['harness'])!;
    const found = await store.locate!(store.root({ CODEX_HOME: home })!, written!.nativeId, '/ws', { CODEX_HOME: home });
    expect(found?.path).toContain(join(home, 'sessions'));
    const lines = (await readFile(found!.path, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(lines[0].payload.id).toBe(written!.nativeId);
    expect(lines[0].payload.cli_version).toBe('0.155.1');
    expect((await readdir(join(found!.path, '..'))).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});

describe('uuidv7', () => {
  it('carries the time and the version', () => {
    const id = uuidv7(0x0190_0000_0000);
    expect(id.startsWith('01900000-0000-7')).toBe(true);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
