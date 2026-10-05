import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { carryNativeSession } from '../../carry.js';
import { localHarnessForCommand } from '@clikcode/router/ai-local-harness';
import { droidProjectDirectoryName } from './droid-store.js';

/**
 * Factory Droid keeps a session as one transcript under the cwd it ran in:
 *   <HOME>/.factory/sessions/<cwd, every / a dash>/<id>.jsonl
 *
 * Each ClikCode account is its own HOME, so without locating the file every
 * failover threw the thread away and retold the turn.
 */
const droid = localHarnessForCommand('droid')!;
const transcript = (home: string, workspace: string, id: string): string =>
  join(home, '.factory', 'sessions', droidProjectDirectoryName(workspace), `${id}.jsonl`);

async function seed(home: string, workspace: string, id: string): Promise<void> {
  await mkdir(join(transcript(home, workspace, id), '..'), { recursive: true });
  await writeFile(transcript(home, workspace, id), '{"type":"session_start"}\n{"type":"message","message":{"role":"user"}}\n', 'utf8');
}

describe('carrying a Droid session between account profiles', () => {
  it('copies the transcript into the taking-over profile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'droid-carry-'));
    const from = join(root, 'a');
    const to = join(root, 'b');
    const workspace = '/home/me/projects';
    await seed(from, workspace, 'd1');
    await expect(carryNativeSession({ harness: droid, nativeId: 'd1', workspace, from: { HOME: from }, to: { HOME: to } }))
      .resolves.toBe('carried');
    await expect(readFile(transcript(to, workspace, 'd1'), 'utf8')).resolves.toContain('session_start');
    // Copied, not moved: the account it left keeps its history.
    await expect(readFile(transcript(from, workspace, 'd1'), 'utf8')).resolves.toContain('session_start');
  });

  it('finds a session filed under another cwd, and carries it to the same place', async () => {
    const root = await mkdtemp(join(tmpdir(), 'droid-carry-'));
    const from = join(root, 'a');
    const to = join(root, 'b');
    await seed(from, '/home/me/old-folder', 'moved');
    await expect(carryNativeSession({ harness: droid, nativeId: 'moved', workspace: '/home/me/new-folder', from: { HOME: from }, to: { HOME: to } }))
      .resolves.toBe('carried');
    await expect(readFile(transcript(to, '/home/me/old-folder', 'moved'), 'utf8')).resolves.toContain('session_start');
  });

  it('is unreachable when the session is not there', async () => {
    const root = await mkdtemp(join(tmpdir(), 'droid-carry-'));
    await expect(carryNativeSession({ harness: droid, nativeId: 'none', workspace: '/w', from: { HOME: join(root, 'a') }, to: { HOME: join(root, 'b') } }))
      .resolves.toBeUndefined();
  });
});
