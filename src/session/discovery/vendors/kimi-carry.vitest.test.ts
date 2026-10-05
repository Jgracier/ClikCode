import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { carryNativeSession } from '../../carry.js';
import { localHarnessForCommand } from '@clikcode/router/ai-local-harness';
import { kimiWorkDirKey } from './kimi-store.js';

/**
 * Kimi Code keeps a session as a directory under its workdir's bucket:
 *   <HOME>/.kimi-code/sessions/wd_<slug>_<hash12>/session_<uuid>/{state.json, agents/main/wire.jsonl}
 *
 * Each ClikCode account is its own HOME, so without locating the directory
 * every failover threw the thread away and retold the turn.
 */
const kimi = localHarnessForCommand('kimi')!;
const sessionDir = (home: string, workspace: string, id: string): string =>
  join(home, '.kimi-code', 'sessions', kimiWorkDirKey(workspace), id);

async function seed(home: string, workspace: string, id: string): Promise<void> {
  const dir = sessionDir(home, workspace, id);
  await mkdir(join(dir, 'agents', 'main'), { recursive: true });
  await writeFile(join(dir, 'state.json'), `{"id":"${id}","version":2}\n`, 'utf8');
  await writeFile(join(dir, 'agents', 'main', 'wire.jsonl'), '{"type":"context.append_message"}\n', 'utf8');
}

describe('carrying a Kimi session between account profiles', () => {
  it('copies the whole session directory into the taking-over profile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kimi-carry-'));
    const from = join(root, 'a');
    const to = join(root, 'b');
    const workspace = '/home/me/projects';
    const id = 'session_0199aaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    await seed(from, workspace, id);
    await expect(carryNativeSession({ harness: kimi, nativeId: id, workspace, from: { HOME: from }, to: { HOME: to } }))
      .resolves.toBe('carried');
    await expect(readFile(join(sessionDir(to, workspace, id), 'agents', 'main', 'wire.jsonl'), 'utf8')).resolves.toContain('append_message');
    // Copied, not moved: the account it left keeps its history.
    await expect(readFile(join(sessionDir(from, workspace, id), 'state.json'), 'utf8')).resolves.toContain(id);
  });

  it('finds a session filed under another workdir, and carries it to the same place', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kimi-carry-'));
    const from = join(root, 'a');
    const to = join(root, 'b');
    await seed(from, '/home/me/old-folder', 'session_moved');
    await expect(carryNativeSession({ harness: kimi, nativeId: 'session_moved', workspace: '/home/me/new-folder', from: { HOME: from }, to: { HOME: to } }))
      .resolves.toBe('carried');
    await expect(readFile(join(sessionDir(to, '/home/me/old-folder', 'session_moved'), 'state.json'), 'utf8')).resolves.toContain('session_moved');
  });

  it('is unreachable when the session is not there', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kimi-carry-'));
    await expect(carryNativeSession({ harness: kimi, nativeId: 'session_none', workspace: '/w', from: { HOME: join(root, 'a') }, to: { HOME: join(root, 'b') } }))
      .resolves.toBeUndefined();
  });
});
