import { chmod, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { markProviderBoundaries, type CanonicalOrigin, type CanonicalRecord, type CanonicalToolCall, type CanonicalTurn } from '../../canonical';
import type { NativeThreadWriteContext } from '../stores';
import { nativeSessionStore } from '../registry';
import {
  kiloThreadWriter, openCodeCallsFor, openCodeExport, openCodeFamilyThreadWriter, openCodeId, openCodeThreadWriter,
} from './opencode-writer';

const CODEX: CanonicalOrigin = { sessionId: 's1', harness: 'codex', route: 'native', provider: 'openai', model: 'gpt-5.6-luna' };

function turn(index: number, user: string, parts: CanonicalTurn['parts'], extra: Partial<CanonicalTurn> = {}): CanonicalTurn {
  return { index, user, attachments: [], parts, assistant: '', tools: [], touchedFiles: [], interrupted: false, origin: CODEX, ...extra };
}

function call(overrides: Partial<CanonicalToolCall> & Pick<CanonicalToolCall, 'name'>): CanonicalToolCall {
  return { label: overrides.name, status: 'done', files: [], ...overrides };
}

/** The record the live check resumed: a codeword, then a Codex shell call
 *  and a Codex apply_patch edit. */
function liveRecord(workspace = '/ws'): CanonicalRecord {
  return {
    version: 1, conversationId: 'c1', sessionId: 's1', workspace, touchedFiles: [`${workspace}/notes.txt`],
    attachments: [], pendingAttachments: [], openTodos: [],
    turns: [
      turn(0, 'Remember this codeword for later: MARMALADE-COMET-31. Just acknowledge it.', [
        { type: 'text', text: 'Noted: the codeword is MARMALADE-COMET-31.' },
      ]),
      turn(1, 'List the files here, then change the color in notes.txt from blue to green.', [
        { type: 'text', text: 'Let me look at the folder first.' },
        { type: 'tool', call: call({ id: 'call_a', category: 'run', name: 'exec_command', input: { cmd: 'ls -1', workdir: workspace }, label: '$ ls -1', target: 'ls -1', output: ['notes.txt'], exitCode: 0 }) },
        { type: 'tool', call: call({ id: 'call_b', category: 'edit', name: 'apply_patch', input: { input: `*** Begin Patch\n*** Update File: ${workspace}/notes.txt\n@@\n-color = blue\n+color = green\n*** End Patch` }, label: 'Edit notes.txt', target: 'notes.txt', output: ['Success. Updated the following files:', `M ${workspace}/notes.txt`], files: [`${workspace}/notes.txt`] }) },
        { type: 'text', text: 'Done: notes.txt now says color = green (it was blue).' },
      ]),
    ],
  };
}

function counter(): () => string {
  let next = 0;
  return () => String(++next).padStart(14, '0');
}

const START = Date.UTC(2026, 9, 4, 12, 0, 0);
const options = { workspace: '/ws', model: 'opencode/big-pickle', version: '1.18.32', startMs: START };

describe('openCodeExport', () => {
  it('writes the export format opencode 1.18.32 imported and resumed (golden)', async () => {
    const exported = openCodeExport(markProviderBoundaries(liveRecord(), 'opencode'), { ...options, random: counter() });
    await expect(`${JSON.stringify(exported, null, 2)}\n`).toMatchFileSnapshot('./opencode-writer.golden.json');
  });

  it('names the producing provider/model on each assistant message, the receiving one on requests', () => {
    const kilo: CanonicalOrigin = { sessionId: 's2', harness: 'kilo', route: 'native', provider: 'kilo', model: 'kilo/cohere/north-mini-code:free' };
    const own: CanonicalOrigin = { sessionId: 's3', harness: 'opencode', route: 'native', provider: 'opencode', model: 'opencode/big-pickle' };
    const record = liveRecord();
    record.turns = [
      turn(0, 'Say hi.', [{ type: 'text', text: 'Hi.' }], { origin: own }),
      turn(1, 'Say hello.', [{ type: 'text', text: 'Hello.' }], { origin: kilo }),
      turn(2, 'Bye.', [{ type: 'text', text: 'Bye.' }], { origin: own }),
    ];
    const exported = openCodeExport(markProviderBoundaries(record, 'opencode'), options);
    const rows = exported.messages.map((message) => [
      message.info.role,
      message.info.role === 'user' ? (message.info.model as { providerID: string; modelID: string }).providerID : message.info.providerID,
      message.info.role === 'user' ? (message.info.model as { providerID: string; modelID: string }).modelID : message.info.modelID,
      String(message.parts.find((part) => part.type === 'text')?.text),
    ]);
    expect(rows).toEqual([
      ['user', 'opencode', 'big-pickle', 'Say hi.'],
      ['assistant', 'opencode', 'big-pickle', 'Hi.'],
      ['user', 'opencode', 'big-pickle', '[ClikCode: the following turns ran on kilo (kilo/cohere/north-mini-code:free)]\n\nSay hello.'],
      ['assistant', 'kilo', 'cohere/north-mini-code:free', 'Hello.'],
      ['user', 'opencode', 'big-pickle', '[ClikCode: the following turns ran on opencode (opencode/big-pickle)]\n\nBye.'],
      ['assistant', 'opencode', 'big-pickle', 'Bye.'],
    ]);
  });

  it('gives every message and part an id that sorts in conversation order', () => {
    const exported = openCodeExport(liveRecord(), options);
    const messages = exported.messages.map((message) => String(message.info.id));
    expect([...messages].sort()).toEqual(messages);
    const parts = exported.messages.flatMap((message) => message.parts.map((part) => String(part.id)));
    expect([...parts].sort()).toEqual(parts);
    expect(String(exported.info.id)).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    for (const message of exported.messages) {
      expect(message.info.sessionID).toBe(exported.info.id);
      for (const part of message.parts) expect(part.messageID).toBe(message.info.id);
    }
  });

  it('splits an answer into steps at text that follows a call', () => {
    const exported = openCodeExport(liveRecord(), options);
    const roles = exported.messages.map((message) => [message.info.role, message.info.finish ?? null]);
    expect(roles).toEqual([['user', null], ['assistant', 'stop'], ['user', null], ['assistant', 'tool-calls'], ['assistant', 'stop']]);
    const tools = exported.messages[3]!.parts.filter((part) => part.type === 'tool').map((part) => part.tool);
    expect(tools).toEqual(['bash', 'edit']);
    expect(JSON.stringify(exported)).not.toMatch(/reasoning"\s*:\s*"|"type":"reasoning"/);
  });

  it('writes an interrupted last turn as aborted, its open call as an aborted error', () => {
    const record = liveRecord();
    record.turns.push(turn(2, 'Now run the tests.', [
      { type: 'text', text: 'Running them.' },
      { type: 'tool', call: call({ category: 'run', name: 'Bash', input: { command: 'npm test' }, status: 'unfinished' }) },
    ], { interrupted: true }));
    const last = openCodeExport(record, options).messages.at(-1)!;
    expect(last.info).toMatchObject({ role: 'assistant', error: { name: 'MessageAbortedError' } });
    expect(last.info.finish).toBeUndefined();
    expect((last.info.time as { completed?: number }).completed).toBeUndefined();
    expect(last.parts.find((part) => part.type === 'tool')).toMatchObject({ tool: 'bash', state: { status: 'error', error: 'Tool execution aborted' } });
    expect(last.parts.some((part) => part.type === 'step-finish')).toBe(false);
  });

  it('tells a call with no OpenCode tool as text', () => {
    const record = liveRecord();
    record.turns[0]!.parts.push({ type: 'tool', call: call({ name: 'mcp__github__create_issue', input: { title: 't' }, output: ['#12'] }) });
    const first = openCodeExport(record, options).messages[1]!;
    const said = first.parts.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
    expect(said).toContain('[Called mcp__github__create_issue {"title":"t"}]\n#12');
    expect(first.parts.some((part) => part.type === 'tool')).toBe(false);
  });
});

describe('openCodeCallsFor', () => {
  it('maps shell calls from any vendor to bash', () => {
    expect(openCodeCallsFor(call({ name: 'Bash', input: { command: 'ls', description: 'List' } }), '/ws')).toEqual([{ tool: 'bash', input: { command: 'ls', description: 'List' }, title: 'ls' }]);
    expect(openCodeCallsFor(call({ name: 'shell', input: { command: ['bash', '-lc', 'npm test'] } }), '/ws')[0]).toMatchObject({ tool: 'bash', input: { command: 'npm test' } });
    expect(openCodeCallsFor(call({ name: 'shell', label: '$ make', target: 'make' }), '/ws')[0]).toMatchObject({ tool: 'bash', input: { command: 'make' } });
  });
  it('maps edits, writes and patches to edit/write', () => {
    expect(openCodeCallsFor(call({ name: 'Edit', category: 'edit', input: { file_path: 'a.txt', old_string: 'x', new_string: 'y' } }), '/ws'))
      .toEqual([{ tool: 'edit', input: { filePath: '/ws/a.txt', oldString: 'x', newString: 'y' }, title: '/ws/a.txt' }]);
    expect(openCodeCallsFor(call({ name: 'Write', input: { file_path: '/ws/b.txt', content: 'bee' } }), '/ws'))
      .toEqual([{ tool: 'write', input: { filePath: '/ws/b.txt', content: 'bee' }, title: '/ws/b.txt' }]);
    const patch = '*** Begin Patch\n*** Add File: n.txt\n+one\n*** Update File: c.ts\n@@\n keep\n-a\n+b\n*** Delete File: d.txt\n*** End Patch';
    expect(openCodeCallsFor(call({ name: 'apply_patch', input: { input: patch } }), '/ws').map((item) => [item.tool, item.input])).toEqual([
      ['write', { filePath: '/ws/n.txt', content: 'one\n' }],
      ['edit', { filePath: '/ws/c.ts', oldString: 'keep\na', newString: 'keep\nb' }],
      ['bash', { command: 'rm /ws/d.txt', description: 'Delete /ws/d.txt' }],
    ]);
  });
  it('rebuilds an edit recorded with only its diff', () => {
    const diff = [{ path: 'a.txt', change: 'update' as const, lines: [{ kind: 'same' as const, text: 'k' }, { kind: 'removed' as const, text: 'x' }, { kind: 'added' as const, text: 'y' }], additions: 1, removals: 1 }];
    expect(openCodeCallsFor(call({ name: 'Edit', category: 'edit', label: 'Edit a.txt', target: 'a.txt', diff }), '/ws'))
      .toEqual([{ tool: 'edit', input: { filePath: '/ws/a.txt', oldString: 'k\nx', newString: 'k\ny' }, title: '/ws/a.txt' }]);
  });
  it('maps reads, searches, fetches and sub-agents', () => {
    expect(openCodeCallsFor(call({ name: 'Read', input: { file_path: 'a.txt' } }), '/ws')[0]).toMatchObject({ tool: 'read', input: { filePath: '/ws/a.txt' } });
    expect(openCodeCallsFor(call({ name: 'Grep', input: { pattern: 'TODO', path: 'src', glob: '*.ts' } }), '/ws')[0]).toMatchObject({ tool: 'grep', input: { pattern: 'TODO', path: '/ws/src', include: '*.ts' } });
    expect(openCodeCallsFor(call({ name: 'Glob', input: { pattern: '*.ts' } }), '/ws')[0]).toMatchObject({ tool: 'glob', input: { pattern: '*.ts' } });
    expect(openCodeCallsFor(call({ name: 'WebFetch', category: 'fetch', input: { url: 'https://example.com' } }), '/ws')[0]).toMatchObject({ tool: 'webfetch', input: { url: 'https://example.com', format: 'markdown' } });
    expect(openCodeCallsFor(call({ name: 'Task', input: { description: 'Look', prompt: 'Find x' } }), '/ws')[0]).toMatchObject({ tool: 'task', input: { description: 'Look', prompt: 'Find x', subagent_type: 'general' } });
  });
  it('has no equivalent for MCP tools or a web search', () => {
    expect(openCodeCallsFor(call({ name: 'mcp__github__create_issue', input: { title: 't' } }), '/ws')).toEqual([]);
    expect(openCodeCallsFor(call({ name: 'Web search', category: 'search', target: 'vitest' }), '/ws')).toEqual([]);
  });
});

describe('openCodeId', () => {
  it('matches the ids opencode 1.18.32 made', () => {
    // A user message created at 1791166847558 was msg_109dd1a46001...
    expect(openCodeId('msg', 1791166847558, 1, false, 'x'.repeat(14))).toBe(`msg_109dd1a46001${'x'.repeat(14)}`);
    expect(openCodeId('ses', 1791166847558, 1, true, 'y'.repeat(14))).toMatch(/^ses_ef622e5b9ffe/);
  });
});

describe('OpenCode-family writers', () => {
  const harness = (binary: string, command = 'opencode') => ({ command, binary, displayName: command }) as unknown as NativeThreadWriteContext['harness'];
  const context = (overrides: Partial<NativeThreadWriteContext> = {}): NativeThreadWriteContext => ({
    harness: harness('opencode'), workspace: '/ws', environment: {}, model: 'opencode/big-pickle', version: '1.18.32', ...overrides,
  });

  it('are registered on the OpenCode and Kilo stores', () => {
    expect(nativeSessionStore({ command: 'opencode' } as NativeThreadWriteContext['harness'])?.writer).toBe(openCodeThreadWriter);
    expect(nativeSessionStore({ command: 'kilo' } as NativeThreadWriteContext['harness'])?.writer).toBe(kiloThreadWriter);
    const store = nativeSessionStore({ command: 'kilo' } as NativeThreadWriteContext['harness'])!;
    expect(store.root({ XDG_DATA_HOME: '/p/share' })).toBe('/p/share/kilo');
    expect(store.root({ HOME: '/p' })).toBe('/p/.local/share/kilo');
  });

  it('accept only the verified builds', () => {
    expect(openCodeThreadWriter.versionOk(context())).toBe(true);
    expect(openCodeThreadWriter.versionOk(context({ version: '1.18.33' }))).toBe(false);
    expect(openCodeThreadWriter.versionOk(context({ version: undefined }))).toBe(false);
    expect(kiloThreadWriter.versionOk(context({ version: '7.7.6' }))).toBe(true);
    expect(kiloThreadWriter.versionOk(context({ version: '1.18.32' }))).toBe(false);
  });

  it('decline without a provider/model to record', async () => {
    expect(await openCodeThreadWriter.write(liveRecord(), context({ model: null }))).toBeUndefined();
    expect(await openCodeThreadWriter.write(liveRecord(), context({ model: 'big-pickle' }))).toBeUndefined();
  });

  /** A stand-in binary that records how it was run and answers as import does. */
  async function fakeBinary(answer: 'ok' | 'fail'): Promise<{ binary: string; log: string; directory: string }> {
    const directory = await mkdtemp(join(tmpdir(), 'clikcode-oc-writer-'));
    const log = join(directory, 'calls.log');
    const binary = join(directory, 'fake-opencode');
    await writeFile(binary, [
      '#!/bin/sh',
      `echo "$PWD|$XDG_DATA_HOME|$*" >> ${log}`,
      'if [ "$1" = import ]; then',
      `  cp "$3" ${directory}/imported.json`,
      answer === 'ok' ? '  id=$(basename "$3" .json); echo "Imported session: $id"' : '  exit 1',
      'fi',
    ].join('\n'));
    await chmod(binary, 0o755);
    return { binary, log, directory };
  }

  it('imports the export in the workspace with the account environment, then cleans up', async () => {
    const fake = await fakeBinary('ok');
    const written = await openCodeThreadWriter.write(liveRecord(fake.directory), context({
      harness: harness(fake.binary), workspace: fake.directory, environment: { XDG_DATA_HOME: '/profile/share' },
    }));
    expect(written?.nativeId).toMatch(/^ses_/);
    expect(written?.transport).toBeUndefined();
    const [line] = (await readFile(fake.log, 'utf8')).trim().split('\n');
    const [cwd, data, args] = line!.split('|');
    expect(cwd).toBe(fake.directory);
    expect(data).toBe('/profile/share');
    expect(args).toMatch(/^import --pure \S+clikcode-thread-\S+\/ses_\S+\.json$/);
    const imported = JSON.parse(await readFile(join(fake.directory, 'imported.json'), 'utf8'));
    expect(imported.info.id).toBe(written!.nativeId);
    expect(imported.messages[0].info.model).toEqual({ providerID: 'opencode', modelID: 'big-pickle' });
    const temporary = args!.split(' ').at(-1)!;
    await expect(readdir(join(temporary, '..'))).rejects.toThrow();
  });

  it('deletes a half-imported session and declines when import fails', async () => {
    const fake = await fakeBinary('fail');
    const writer = openCodeFamilyThreadWriter(['9']);
    const written = await writer.write(liveRecord(fake.directory), context({ harness: harness(fake.binary), workspace: fake.directory, version: '9' }));
    expect(written).toBeUndefined();
    const lines = (await readFile(fake.log, 'utf8')).trim().split('\n');
    expect(lines[1]).toMatch(/\|session delete --pure ses_\S+$/);
  });
});
