/** The Claude Code transcript serializer and its tool mapping, as golden
 * records: the layout Claude Code 2.1.288 resumed (and Goose 1.51.0 and
 * Hermes 0.20.5 imported) in live checks. */
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AiLocalHarnessDefinition } from '../../../harness/definition.js';
import type { CanonicalRecord, CanonicalToolCall, CanonicalTurn } from '../../canonical.js';
import { claudeToolUses, claudeThreadJsonl, claudeThreadRecords } from './claude-thread.js';
import { claudeImportWriter, testedBuild, versionNumber } from './claude-import.js';
import { claudeSessionStore } from './claude-store.js';
import { gooseSessionStore } from './goose-store.js';
import { hermesSessionStore } from './hermes-store.js';

const cwd = '/w';
const call = (fields: Partial<CanonicalToolCall>): CanonicalToolCall => ({ name: 'tool', label: 'tool', status: 'done', files: [], ...fields });
const turn = (index: number, user: string, parts: CanonicalTurn['parts'], harness = 'codex'): CanonicalTurn => ({
  index, user, attachments: [], parts, assistant: '', tools: [], touchedFiles: [], interrupted: false,
  origin: { sessionId: 's', harness, route: 'local', provider: null, model: null },
});
const recordOf = (turns: CanonicalTurn[]): CanonicalRecord => ({
  version: 1, conversationId: 'c', sessionId: 's', workspace: cwd, turns, touchedFiles: [], attachments: [], pendingAttachments: [], openTodos: [],
});
const counter = () => { let next = 0; return () => `00000000-0000-4000-8000-${String(++next).padStart(12, '0')}`; };

describe('claudeToolUses', () => {
  it('maps foreign calls onto Claude Code tools by category', () => {
    const cases: [CanonicalToolCall, unknown][] = [
      [call({ name: 'shell', category: 'run', input: { command: ['bash', '-lc', 'npm test'] }, label: '$ npm test' }), [{ name: 'Bash', input: { command: 'npm test' } }]],
      [call({ name: 'exec_command', input: { cmd: 'ls -la' }, label: '$ ls -la' }), [{ name: 'Bash', input: { command: 'ls -la' } }]],
      [call({ name: 'shell', label: '$ git status', target: 'git status' }), [{ name: 'Bash', input: { command: 'git status' } }]],
      [call({ name: 'read_file', category: 'read', input: { path: 'src/a.ts' } }), [{ name: 'Read', input: { file_path: '/w/src/a.ts' } }]],
      [call({ name: 'Read', label: 'Read /x/b.ts', target: '/x/b.ts' }), [{ name: 'Read', input: { file_path: '/x/b.ts' } }]],
      [call({ name: 'List', label: 'List src', target: 'src', category: 'read' }), [{ name: 'Bash', input: { command: 'ls /w/src' } }]],
      [call({ name: 'replace', category: 'edit', input: { file_path: '/w/a.ts', old_string: 'a', new_string: 'b' } }),
        [{ name: 'Edit', input: { file_path: '/w/a.ts', old_string: 'a', new_string: 'b' } }]],
      [call({ name: 'write_file', category: 'edit', input: { path: 'n.txt', content: 'hi\n' } }), [{ name: 'Write', input: { file_path: '/w/n.txt', content: 'hi\n' } }]],
      [call({ name: 'grep', category: 'search', input: { pattern: 'TODO', path: 'src' } }), [{ name: 'Grep', input: { pattern: 'TODO', path: '/w/src' } }]],
      [call({ name: 'Glob', label: 'Glob **/*.ts', target: '**/*.ts', category: 'search' }), [{ name: 'Glob', input: { pattern: '**/*.ts' } }]],
      [call({ name: 'web_search', category: 'fetch', input: { query: 'vitest' } }), [{ name: 'WebSearch', input: { query: 'vitest' } }]],
      [call({ name: 'fetch', category: 'fetch', input: { url: 'https://x.dev' } }), [{ name: 'WebFetch', input: { url: 'https://x.dev', prompt: 'Read the page.' } }]],
      [call({ name: 'spawn_agent', agent: true, input: { message: 'audit the parser' } }),
        [{ name: 'Agent', input: { description: 'audit the parser', prompt: 'audit the parser', subagent_type: 'general-purpose' } }]],
      [call({ name: 'mcp__github__create_issue', input: { title: 't' } }), []],
      [call({ name: 'update_plan', input: { plan: [] } }), []],
    ];
    for (const [input, expected] of cases) expect(claudeToolUses(input, cwd), input.name).toEqual(expected);
  });

  it('turns an apply_patch into Write and one Edit per hunk', () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: notes.txt',
      '+alpha',
      '+beta',
      '*** Update File: src/a.ts',
      '@@',
      ' const a = 1;',
      '-const b = 2;',
      '+const b = 3;',
      '@@',
      '-old();',
      '+fresh();',
      '*** Delete File: gone.txt',
      '*** End Patch',
      '',
    ].join('\n');
    expect(claudeToolUses(call({ name: 'apply_patch', category: 'edit', input: { input: patch } }), cwd)).toEqual([
      { name: 'Write', input: { file_path: '/w/notes.txt', content: 'alpha\nbeta\n' } },
      { name: 'Edit', input: { file_path: '/w/src/a.ts', old_string: 'const a = 1;\nconst b = 2;', new_string: 'const a = 1;\nconst b = 3;' } },
      { name: 'Edit', input: { file_path: '/w/src/a.ts', old_string: 'old();', new_string: 'fresh();' } },
      { name: 'Bash', input: { command: 'rm /w/gone.txt' } },
    ]);
  });

  it('falls back to the recorded diff for an edit with no usable input', () => {
    expect(claudeToolUses(call({
      name: 'Edit', category: 'edit', label: 'Edit src/a.ts', target: 'src/a.ts',
      diff: [{ path: 'src/a.ts', lines: [{ kind: 'same', text: 'x' }, { kind: 'removed', text: 'y' }, { kind: 'added', text: 'z' }, { kind: 'gap', text: '' }, { kind: 'added', text: 'w' }], additions: 2, removals: 1 }],
    }), cwd)).toEqual([
      { name: 'Edit', input: { file_path: '/w/src/a.ts', old_string: 'x\ny', new_string: 'x\nz' } },
      { name: 'Edit', input: { file_path: '/w/src/a.ts', old_string: '', new_string: 'w' } },
    ]);
  });

  it("keeps Claude Code's own calls exactly", () => {
    const own = call({ name: 'Bash', input: { command: 'pwd', description: 'Where' } });
    expect(claudeToolUses(own, cwd, 'claude')).toEqual([{ name: 'Bash', input: { command: 'pwd', description: 'Where' } }]);
  });
});

describe('claudeThreadRecords', () => {
  it('writes the golden transcript: chained records, own tools, results, text lines', async () => {
    const record = recordOf([
      turn(0, 'Remember the codeword', [{ type: 'text', text: 'Noted: the codeword is PLUM.' }], 'claude'),
      turn(1, 'Make the file', [
        { type: 'text', text: 'Creating it.' },
        { type: 'tool', call: call({ id: 'c1', name: 'shell', category: 'run', input: { command: ['bash', '-lc', 'echo hi > a.txt'] }, label: '$ echo hi > a.txt', output: ['ok'], exitCode: 0 }) },
        { type: 'tool', call: call({ name: 'mcp__linear__save', label: 'linear › save', status: 'failed', output: ['denied'] }) },
        { type: 'text', text: 'Done.' },
      ]),
    ]);
    record.turns[1]!.attachments = ['/w/spec.md'];
    const records = claudeThreadRecords(record, {
      sessionId: 'sess', cwd, model: 'claude-haiku-4-5', version: '2.1.288', now: new Date('2026-10-04T12:00:00.000Z'), uuid: counter(),
    });
    // Golden: reviewed by hand against a transcript Claude Code 2.1.288 wrote.
    await expect(records.map((item) => JSON.stringify(item)).join('\n') + '\n')
      .toMatchFileSnapshot('./__golden__/claude-thread.jsonl');
    expect(records).toHaveLength(8);
  });

  it('marks failed and unfinished calls as errors and never puts two requests back to back', () => {
    const record = recordOf([
      turn(0, 'first', []),
      turn(1, 'second', [{ type: 'tool', call: call({ name: 'shell', category: 'run', input: { command: 'make' }, label: '$ make', status: 'unfinished' }) }]),
    ]);
    const records = claudeThreadRecords(record, { sessionId: 's', cwd, model: null, version: '2.1.288', uuid: counter() });
    expect(records.map((item) => (item.message as { content: unknown }).content)).toEqual([
      'first',
      [{ type: 'text', text: '(No answer was recorded.)' }],
      'second',
      [{ type: 'tool_use', id: expect.stringMatching(/^toolu_/), name: 'Bash', input: { command: 'make' } }],
      [{ type: 'tool_result', tool_use_id: expect.stringMatching(/^toolu_/), content: 'The call was interrupted before it finished.', is_error: true }],
    ]);
    // Strictly increasing timestamps, every record chained to the one before.
    records.forEach((item, index) => {
      expect(item.parentUuid).toBe(index ? records[index - 1]!.uuid : null);
      if (index) expect(Date.parse(String(item.timestamp))).toBeGreaterThan(Date.parse(String(records[index - 1]!.timestamp)));
    });
  });

  it('is one JSON object per line', () => {
    const text = claudeThreadJsonl(recordOf([turn(0, 'hi', [{ type: 'text', text: 'hello' }])]), { sessionId: 's', cwd, model: null, version: '2.1.288' });
    expect(text.endsWith('\n')).toBe(true);
    expect(text.trim().split('\n').map((line) => JSON.parse(line).type)).toEqual(['user', 'assistant']);
  });
});

describe('writers', () => {
  const dirs: string[] = [];
  afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
  const record = recordOf([turn(0, 'hi', [{ type: 'text', text: 'hello' }])]);
  const context = (harness: Partial<AiLocalHarnessDefinition>, environment: Record<string, string>, version: string, workspace = '/w/my.app') => ({
    harness: harness as AiLocalHarnessDefinition, workspace, environment, model: 'claude-haiku-4-5', version,
  });

  it('reads x.y.z out of each vendor version line and accepts only tested builds', () => {
    expect(versionNumber('2.1.288 (Claude Code)')).toBe('2.1.288');
    expect(versionNumber('Hermes Agent v0.20.5 (2026.8.19) · upstream eb8d21f4')).toBe('0.20.5');
    expect(testedBuild(['1.51.0'], { version: ' 1.51.0' })).toBe(true);
    expect(testedBuild(['1.51.0'], { version: '1.52.0' })).toBe(false);
    expect(testedBuild(['1.51.0'], { version: undefined })).toBe(false);
    expect(claudeSessionStore.writer!.testedVersions).toEqual(['2.1.288']);
    expect(gooseSessionStore.writer!.testedVersions).toEqual(['1.51.0']);
    expect(hermesSessionStore.writer!.testedVersions).toEqual(['0.20.5']);
  });

  it('Claude: a new session file in the account config dir, project-named from the cwd', async () => {
    const config = await mkdtemp(join(tmpdir(), 'cc-claude-writer-'));
    dirs.push(config);
    const written = await claudeSessionStore.writer!.write(record, context({ command: 'claude' }, { CLAUDE_CONFIG_DIR: config }, '2.1.288 (Claude Code)'));
    const project = join(config, 'projects', '-w-my-app');
    expect(await readdir(project)).toEqual([`${written!.nativeId}.jsonl`]);
    const lines = (await readFile(join(project, `${written!.nativeId}.jsonl`), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(lines.map((line) => [line.type, line.sessionId, line.cwd])).toEqual([
      ['user', written!.nativeId, '/w/my.app'], ['assistant', written!.nativeId, '/w/my.app'],
    ]);
    expect(lines[1].message.model).toBe('claude-haiku-4-5');
    expect(await claudeSessionStore.locate!(join(config, 'projects'), written!.nativeId, '/w/my.app', {})).toBeTruthy();
  });

  it('import writers: run the import with the account environment, parse the id, leave no temp file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cc-import-writer-'));
    dirs.push(dir);
    const fake = join(dir, 'fake-hermes');
    await writeFile(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/argv"\ncp "$5" "${dir}/seen.jsonl"\necho "home=$HERMES_HOME" > "${dir}/env"\necho "✓ Imported Claude Code session as 20261004_1_abc"\n`);
    await chmod(fake, 0o755);
    const written = await hermesSessionStore.writer!.write(record, context(
      { command: 'hermes', binary: fake, displayName: 'Hermes' }, { HERMES_HOME: '/profiles/h2' }, 'Hermes Agent v0.20.5', dir));
    expect(written).toEqual({ nativeId: '20261004_1_abc', transport: 'text-cli' });
    const argv = (await readFile(join(dir, 'argv'), 'utf8')).trim().split('\n');
    expect(argv.slice(0, 4)).toEqual(['sessions', 'import', '--from', 'claude']);
    expect(await readFile(join(dir, 'env'), 'utf8')).toBe('home=/profiles/h2\n');
    expect((await readFile(join(dir, 'seen.jsonl'), 'utf8')).split('\n')[0]).toContain(`"cwd":"${dir}"`);
    await expect(readFile(argv[4]!)).rejects.toThrow();
  });

  it('Goose: parses the id from its import output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cc-goose-writer-'));
    dirs.push(dir);
    const fake = join(dir, 'fake-goose');
    await writeFile(fake, '#!/bin/sh\necho "Detected format: Claude Code"\necho "Session imported:"\necho "20261005_3 - hi"\n');
    await chmod(fake, 0o755);
    expect(await gooseSessionStore.writer!.write(record, context({ command: 'goose', binary: fake, displayName: 'Goose' }, {}, '1.51.0', dir)))
      .toEqual({ nativeId: '20261005_3' });
    const failing = claudeImportWriter({ testedVersions: ['1'], argv: () => [], parse: () => undefined });
    expect(await failing.write(record, context({ command: 'goose', binary: fake, displayName: 'Goose' }, {}, '1', dir))).toBeUndefined();
  });
});

describe('toolCalls: text', () => {
  it('writes each call as a line naming the Claude tool, its input and its result', () => {
    const record = recordOf([turn(0, 'go', [
      { type: 'tool', call: call({ name: 'shell', category: 'run', input: { command: 'make' }, label: '$ make', output: ['built'] }) },
      { type: 'tool', call: call({ name: 'apply_patch', category: 'edit', input: { input: '*** Begin Patch\n*** Update File: a.py\n@@\n-x\n+y\n*** End Patch' }, label: 'Edit a.py', status: 'failed' }) },
    ])]);
    const records = claudeThreadRecords(record, { sessionId: 's', cwd, model: null, version: '2.1.288', toolCalls: 'text', uuid: counter() });
    expect(records.map((item) => (item.message as { content: unknown }).content)).toEqual([
      'go',
      [{ type: 'text', text: '[Bash {"command":"make"}]\nbuilt' }],
      [{ type: 'text', text: '[Edit {"file_path":"/w/a.py","old_string":"x","new_string":"y"} (failed)]\nThe call failed.' }],
    ]);
  });
});
