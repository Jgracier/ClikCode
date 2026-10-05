/** Golden output of the Antigravity thread writer for one conversation: a
 * codeword, a Codex shell call, a Claude Edit and a Claude Grep.
 *
 * The golden rows are what agy 1.2.16 was LIVE-verified to resume (see
 * antigravity-writer.ts). A serializer change that moves them must be
 * re-verified against agy, then the golden regenerated with
 * `UPDATE_GOLDEN=1`. */

import { describe, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localHarnessForCommand } from '@clikcode/router/ai-local-harness';
import { markProviderBoundaries, type CanonicalOrigin, type CanonicalPart, type CanonicalRecord, type CanonicalToolCall, type CanonicalTurn } from '../../canonical.js';
import { NATIVE_SESSION_STORES } from '../registry.js';
import type { NativeThreadWriteContext } from '../stores.js';
import { sequentialIds } from './thread-writer-files.js';
import { antigravityThreadRows, encodeProto } from './antigravity-writer.js';

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), '__golden__', 'antigravity.rows.json');
const WORKSPACE = '/home/user/projects/app';

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
  return markProviderBoundaries({
    version: 1, conversationId: 'conv-1', sessionId: 's-claude', workspace: WORKSPACE, turns,
    touchedFiles: ['src/app.ts'], attachments: [], pendingAttachments: [], openTodos: [],
  }, 'codex', (command) => localHarnessForCommand(command)?.displayName);
}

/** Every string a protobuf message holds, depth first -- enough to read
 *  back what the model will be shown without a schema. */
function strings(bytes: Uint8Array): string[] {
  const out: string[] = [];
  let index = 0;
  const varint = (): number => {
    let value = 0;
    let scale = 1;
    for (;;) {
      const byte = bytes[index++];
      if (byte === undefined) throw new Error('truncated varint');
      value += (byte & 0x7f) * scale;
      scale *= 128;
      if (byte < 0x80) return value;
    }
  };
  while (index < bytes.length) {
    const key = varint();
    if ((key & 7) === 0) { varint(); continue; }
    if ((key & 7) !== 2 || key < 8) throw new Error('not a message');
    const length = varint();
    if (index + length > bytes.length) throw new Error('truncated field');
    const body = bytes.subarray(index, index + length);
    index += length;
    let nested: string[] | undefined;
    try { nested = strings(body); } catch { nested = undefined; }
    const text = Buffer.from(body).toString('utf8');
    out.push(...(nested?.length && !/^[\x20-\x7e]*$/.test(text) ? nested : [text]));
  }
  return out;
}

const rows = () => antigravityThreadRows(fixtureRecord(), {
  cascadeId: 'c0ffee00-0000-4000-8000-000000000001', trajectoryId: 'c0ffee00-0000-4000-8000-000000000002',
  workspace: WORKSPACE, startMs: Date.UTC(2026, 9, 4, 12), executionId: sequentialIds('exec-'), callId: sequentialIds('call_clikcode_'),
});

describe('antigravity thread writer', () => {
  it('encodes protobuf as agy does: defaults omitted, lengths as varints', () => {
    expect(encodeProto([[1, 14], [4, 0], [5, ''], [6, false], [2, 'hi']]).toString('hex')).toBe('080e12026869');
    expect(encodeProto([[1, 300], [3, [[1, 'a']]]]).toString('hex')).toBe('08ac021a030a0161');
  });

  it('writes the golden rows', async () => {
    const actual = rows();
    const json = `${JSON.stringify({
      trajectoryMeta: actual.trajectoryMeta,
      trajectoryMetadata: actual.trajectoryMetadata.toString('hex'),
      steps: actual.steps.map((step) => ({ idx: step.idx, stepType: step.stepType, metadata: step.metadata.toString('hex'), payload: step.payload.toString('hex') })),
    }, null, 2)}\n`;
    if (process.env.UPDATE_GOLDEN) await writeFile(GOLDEN, json, 'utf8');
    expect(json).toBe(await readFile(GOLDEN, 'utf8'));
  });

  it('turns requests, answers and mapped calls into user, planner and generic steps', () => {
    const steps = rows().steps;
    expect(steps.map((step) => step.stepType)).toEqual([14, 15, 132, 15, 14, 15, 132, 15]);
    const text = steps.map((step) => strings(step.payload).join('\n'));
    expect(text[0]).toContain('Remember the codeword PELICAN-73.');
    expect(text[1]).toContain('{"CommandLine":"cat notes.txt","Cwd":"/home/user/projects/app"');
    expect(text[2]).toContain('The command exited with code 0.\nOutput:\nlaunch window: Thursday');
    expect(text[4]).toMatch(/^\[ClikCode: the following turns ran on .*\]\n\nFix the typo in src\/app.ts/m);
    expect(text[5]).toContain('replace_file_content');
    expect(text[5]).toContain('"TargetFile":"/home/user/projects/app/src/app.ts"');
    // agy has no tool for a Grep: it is told in the answer.
    expect(text[7]).toContain('[Grep cosnt]');
    expect(text[7]).toContain('Fixed the typo in src/app.ts; no other occurrences.');
  });

  it('writes one database under the taking-over HOME only, and declines other builds', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agy-writer-'));
    const writer = NATIVE_SESSION_STORES.antigravity!.writer!;
    const ctx: NativeThreadWriteContext = {
      harness: localHarnessForCommand('antigravity')!, workspace: WORKSPACE, environment: { HOME: home }, model: null, version: '1.2.16',
    };
    expect(await writer.versionOk(ctx)).toBe(true);
    const written = await writer.write(fixtureRecord(), ctx);
    const root = join(home, '.gemini', 'antigravity-cli', 'conversations');
    expect(await readdir(root)).toEqual([`${written!.nativeId}.db`]);
    const location = await NATIVE_SESSION_STORES.antigravity!.locate!(root, written!.nativeId, WORKSPACE, { HOME: home });
    expect(location?.path).toBe(join(root, `${written!.nativeId}.db`));

    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(location!.path);
    try {
      expect(db.prepare('SELECT cascade_id, trajectory_type, source FROM trajectory_meta').all())
        .toEqual([{ cascade_id: written!.nativeId, trajectory_type: 4, source: 17 }]);
      expect(db.prepare('SELECT idx, step_type, status FROM steps ORDER BY idx').all().map((row) => row.step_type))
        .toEqual([14, 15, 132, 15, 14, 15, 132, 15]);
    } finally {
      db.close();
    }

    expect(await writer.versionOk({ ...ctx, version: '1.2.17' })).toBe(false);
    expect(await writer.versionOk({ ...ctx, version: undefined })).toBe(false);
  });
});
