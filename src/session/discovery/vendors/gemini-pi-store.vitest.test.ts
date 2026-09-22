import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { carryNativeSession } from '../../carry.js';
import { localHarnessForCommand } from '@clikcode/router/ai-local-harness';

const gemini = localHarnessForCommand('gemini')!;
const pi = localHarnessForCommand('pi')!;

/**
 * Gemini names a chat file after a timestamp and only the first EIGHT
 * characters of the session id, keeping the full id on the file's first line:
 *   session-2026-09-22T12-31-8ac6abf2.jsonl
 *   {"sessionId":"8ac6abf2-ff23-4cb1-ab85-170400a022f1", ...}
 * So the short id narrows candidates and the first line confirms one. Both
 * halves matter: a prefix alone would happily match another conversation that
 * starts with the same eight characters.
 */
describe('gemini conversation store', () => {
  const chat = (home: string, project: string, file: string): string =>
    join(home, '.gemini', 'tmp', project, 'chats', file);

  it('carries a chat, matching on the full id rather than the filename prefix', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gem-carry-'));
    const from = join(root, 'a');
    const to = join(root, 'b');
    const id = '8ac6abf2-ff23-4cb1-ab85-170400a022f1';
    await mkdir(join(from, '.gemini', 'tmp', 'clikcode', 'chats'), { recursive: true });
    // A decoy sharing the eight-character prefix, written FIRST so a
    // prefix-only match would find it.
    await writeFile(chat(from, 'clikcode', 'session-2026-09-01T00-00-8ac6abf2.jsonl'),
      `${JSON.stringify({ sessionId: '8ac6abf2-0000-0000-0000-000000000000' })}\n`, 'utf8');
    await writeFile(chat(from, 'clikcode', 'session-2026-09-22T12-31-8ac6abf2.jsonl'),
      `${JSON.stringify({ sessionId: id })}\n{"turn":1}\n`, 'utf8');

    await expect(carryNativeSession({
      harness: gemini, nativeId: id, workspace: '/w',
      from: { GEMINI_CLI_HOME: from }, to: { GEMINI_CLI_HOME: to },
    })).resolves.toBe('carried');

    const landed = await readFile(chat(to, 'clikcode', 'session-2026-09-22T12-31-8ac6abf2.jsonl'), 'utf8');
    expect(landed).toContain(id);
    expect(landed).toContain('"turn":1');
  });

  it('searches every project directory rather than guessing the cwd name', async () => {
    // The workspace passed here matches no project directory; the file is
    // still found, because how a cwd becomes a directory name is not assumed.
    const root = await mkdtemp(join(tmpdir(), 'gem-carry-'));
    const from = join(root, 'a');
    const id = 'aaaaaaaa-1111-2222-3333-444444444444';
    await mkdir(join(from, '.gemini', 'tmp', 'some-other-name', 'chats'), { recursive: true });
    await writeFile(chat(from, 'some-other-name', 'session-x-aaaaaaaa.jsonl'),
      `${JSON.stringify({ sessionId: id })}\n`, 'utf8');
    await expect(carryNativeSession({
      harness: gemini, nativeId: id, workspace: '/completely/unrelated',
      from: { GEMINI_CLI_HOME: from }, to: { GEMINI_CLI_HOME: join(root, 'b') },
    })).resolves.toBe('carried');
  });
});

/** Pi names the file after the id itself, nested under a project directory
 *  whose escaping scheme discoverPiFsSessions deliberately does not assume. */
describe('pi conversation store', () => {
  it('finds the session by filename, at any nesting depth', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-carry-'));
    const from = join(root, 'a');
    const id = '11111111-2222-3333-4444-555555555555';
    await mkdir(join(from, 'sessions', '--home-someone-projects--'), { recursive: true });
    await writeFile(join(from, 'sessions', '--home-someone-projects--', `${id}.jsonl`), '{"cwd":"/w"}\n', 'utf8');
    await expect(carryNativeSession({
      harness: pi, nativeId: id, workspace: '/w',
      from: { PI_CODING_AGENT_DIR: from }, to: { PI_CODING_AGENT_DIR: join(root, 'b') },
    })).resolves.toBe('carried');
    await expect(readFile(join(root, 'b', 'sessions', '--home-someone-projects--', `${id}.jsonl`), 'utf8'))
      .resolves.toBe('{"cwd":"/w"}\n');
  });
});
