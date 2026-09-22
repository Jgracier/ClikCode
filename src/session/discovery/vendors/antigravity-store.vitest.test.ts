import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { carryNativeSession } from '../../carry.js';
import { localHarnessForCommand } from '@clikcode/router/ai-local-harness';

/**
 * Antigravity stores one SQLite file per conversation, flat, keyed by the
 * conversation_id ClikCode already tracks:
 *   <HOME>/.gemini/antigravity-cli/conversations/<id>.db
 *
 * Twelve accounts on the machine this was written for, every one with its own
 * HOME, so this is the harness where carrying the thread matters most -- a
 * failover without it re-sends the whole conversation as a ~20KB prompt.
 */
const antigravity = localHarnessForCommand('antigravity')!;
const conv = (home: string, id: string): string =>
  join(home, '.gemini', 'antigravity-cli', 'conversations', `${id}.db`);

describe('carrying an antigravity conversation between account profiles', () => {
  it('copies the conversation into the taking-over profile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ag-carry-'));
    const from = join(root, 'account-a');
    const to = join(root, 'account-b');
    const id = '0d4b32b7-edaf-405f-adca-4a9ad577b6a3';
    await mkdir(join(from, '.gemini', 'antigravity-cli', 'conversations'), { recursive: true });
    await writeFile(conv(from, id), 'SQLite format 3\u0000fake', 'utf8');

    await expect(carryNativeSession({
      harness: antigravity, nativeId: id, workspace: '/w',
      from: { HOME: from }, to: { HOME: to },
    })).resolves.toBe('carried');

    await expect(readFile(conv(to, id), 'utf8')).resolves.toBe('SQLite format 3\u0000fake');
    // Copied, never moved: the account that ran out keeps its own history.
    await expect(readFile(conv(from, id), 'utf8')).resolves.toBe('SQLite format 3\u0000fake');
  });

  it('is flat, not project-scoped: the workspace does not change the path', async () => {
    // Unlike Claude Code, whose file lives under a directory named after the
    // cwd. Passing a different workspace must still find the same file.
    const root = await mkdtemp(join(tmpdir(), 'ag-carry-'));
    const from = join(root, 'a');
    const to = join(root, 'b');
    const id = 'flat-id';
    await mkdir(join(from, '.gemini', 'antigravity-cli', 'conversations'), { recursive: true });
    await writeFile(conv(from, id), 'x', 'utf8');
    await expect(carryNativeSession({
      harness: antigravity, nativeId: id, workspace: '/somewhere/else',
      from: { HOME: from }, to: { HOME: to },
    })).resolves.toBe('carried');
  });

  it('reports unreachable when the conversation is not on disk', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ag-carry-'));
    await expect(carryNativeSession({
      harness: antigravity, nativeId: 'never-existed', workspace: '/w',
      from: { HOME: join(root, 'a') }, to: { HOME: join(root, 'b') },
    })).resolves.toBeUndefined();
  });
});
