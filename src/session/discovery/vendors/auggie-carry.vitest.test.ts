import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { carryNativeSession } from '../../carry.js';
import { localHarnessForCommand } from '@clikcode/router/ai-local-harness';

/**
 * Augment Auggie keeps a session as one file, flat, keyed by its id:
 *   <HOME>/.augment/sessions/<id>.json
 *
 * The file is everything the stateless backend is told, so carrying it is
 * carrying the thread.
 */
const auggie = localHarnessForCommand('auggie')!;
const session = (home: string, id: string): string => join(home, '.augment', 'sessions', `${id}.json`);

async function seed(home: string, id: string): Promise<void> {
  await mkdir(join(home, '.augment', 'sessions'), { recursive: true });
  await writeFile(session(home, id), '{"sessionId":"x","chatHistory":[]}\n', 'utf8');
}

describe('carrying an Auggie session between account profiles', () => {
  it('copies the session file into the taking-over profile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'auggie-carry-'));
    const from = join(root, 'a');
    const to = join(root, 'b');
    await seed(from, 'a1');
    await expect(carryNativeSession({ harness: auggie, nativeId: 'a1', workspace: '/w', from: { HOME: from }, to: { HOME: to } }))
      .resolves.toBe('carried');
    await expect(readFile(session(to, 'a1'), 'utf8')).resolves.toContain('chatHistory');
    // Copied, not moved: the account it left keeps its history.
    await expect(readFile(session(from, 'a1'), 'utf8')).resolves.toContain('chatHistory');
  });

  it('is flat: the workspace does not change the path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'auggie-carry-'));
    const from = join(root, 'a');
    await seed(from, 'flat');
    await expect(carryNativeSession({ harness: auggie, nativeId: 'flat', workspace: '/somewhere/else', from: { HOME: from }, to: { HOME: join(root, 'b') } }))
      .resolves.toBe('carried');
  });

  it('is unreachable when the session is not there', async () => {
    const root = await mkdtemp(join(tmpdir(), 'auggie-carry-'));
    await expect(carryNativeSession({ harness: auggie, nativeId: 'none', workspace: '/w', from: { HOME: join(root, 'a') }, to: { HOME: join(root, 'b') } }))
      .resolves.toBeUndefined();
  });
});
