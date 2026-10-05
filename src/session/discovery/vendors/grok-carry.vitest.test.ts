import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { carryNativeSession } from '../../carry.js';
import { localHarnessForCommand } from '@clikcode/router/ai-local-harness';
import { grokWorkspaceDirectoryName } from './grok-store.js';

/**
 * Grok Build keeps a session as a directory under the cwd it ran in:
 *   <HOME>/.grok/sessions/<encoded cwd>/<id>/{summary.json, chat_history.jsonl, ...}
 *
 * Each ClikCode account is its own HOME. With nothing to locate a session by,
 * every failover threw the thread away and retold the turn from ClikCode's
 * record: a Grok turn walked four accounts in an hour that way, each attempt
 * re-announcing the task, until the model only repeated the retelling.
 */
const grok = localHarnessForCommand('grok')!;
const sessionDir = (home: string, workspace: string, id: string): string =>
  join(home, '.grok', 'sessions', grokWorkspaceDirectoryName(workspace)!, id);

async function seed(home: string, workspace: string, id: string): Promise<void> {
  const dir = sessionDir(home, workspace, id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'summary.json'), '{"info":{"id":"x"}}\n', 'utf8');
  await writeFile(join(dir, 'chat_history.jsonl'), '{"type":"user","content":"hi"}\n', 'utf8');
}

describe('carrying a Grok session between account profiles', () => {
  it('copies the whole session directory into the taking-over profile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'grok-carry-'));
    const from = join(root, 'a');
    const to = join(root, 'b');
    const workspace = '/home/me/projects';
    await seed(from, workspace, 'ed51eb8d');
    await expect(carryNativeSession({ harness: grok, nativeId: 'ed51eb8d', workspace, from: { HOME: from }, to: { HOME: to } }))
      .resolves.toBe('carried');
    await expect(readFile(join(sessionDir(to, workspace, 'ed51eb8d'), 'chat_history.jsonl'), 'utf8')).resolves.toContain('"hi"');
    // Copied, not moved: the account it left keeps its history.
    await expect(readFile(join(sessionDir(from, workspace, 'ed51eb8d'), 'summary.json'), 'utf8')).resolves.toContain('info');
  });

  it('finds a session filed under another cwd, and carries it to the same place', async () => {
    const root = await mkdtemp(join(tmpdir(), 'grok-carry-'));
    const from = join(root, 'a');
    const to = join(root, 'b');
    await seed(from, '/home/me/old-folder', 'moved');
    await expect(carryNativeSession({ harness: grok, nativeId: 'moved', workspace: '/home/me/new-folder', from: { HOME: from }, to: { HOME: to } }))
      .resolves.toBe('carried');
    await expect(readFile(join(sessionDir(to, '/home/me/old-folder', 'moved'), 'summary.json'), 'utf8')).resolves.toContain('info');
  });

  it('is unreachable when the session is not there', async () => {
    const root = await mkdtemp(join(tmpdir(), 'grok-carry-'));
    await expect(carryNativeSession({ harness: grok, nativeId: 'none', workspace: '/w', from: { HOME: join(root, 'a') }, to: { HOME: join(root, 'b') } }))
      .resolves.toBeUndefined();
  });
});
