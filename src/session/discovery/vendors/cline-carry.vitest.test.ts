import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { carryNativeSession } from '../../carry.js';
import { localHarnessForCommand } from '@clikcode/router/ai-local-harness';

/**
 * Cline keeps a session as a directory, flat, keyed by its id:
 *   <HOME>/.cline/data/sessions/<id>/{<id>.json, <id>.messages.json}
 *
 * The record names its messages file by absolute path, and a resume reads
 * and appends to THAT file -- so a copy whose record still named the first
 * account's file would have the new account write into the old one's home.
 */
const cline = localHarnessForCommand('cline')!;
const sessionDir = (home: string, id: string): string => join(home, '.cline', 'data', 'sessions', id);

async function seed(home: string, id: string, extra: Record<string, unknown> = {}): Promise<void> {
  const dir = sessionDir(home, id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${id}.messages.json`), '{"messages":[{"role":"user"}]}\n', 'utf8');
  await writeFile(join(dir, `${id}.json`), JSON.stringify({ session_id: id, messages_path: join(dir, `${id}.messages.json`), ...extra }), 'utf8');
}

const record = async (home: string, id: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(join(sessionDir(home, id), `${id}.json`), 'utf8')) as Record<string, unknown>;

describe('carrying a Cline session between account profiles', () => {
  it('copies the session directory and points its record at the copy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cline-carry-'));
    const from = join(root, 'a');
    const to = join(root, 'b');
    const id = '1791160000000_abcde';
    await seed(from, id);
    await expect(carryNativeSession({ harness: cline, nativeId: id, workspace: '/w', from: { HOME: from }, to: { HOME: to } }))
      .resolves.toBe('carried');
    await expect(readFile(join(sessionDir(to, id), `${id}.messages.json`), 'utf8')).resolves.toContain('"user"');
    expect((await record(to, id)).messages_path).toBe(join(sessionDir(to, id), `${id}.messages.json`));
    // Copied, not moved -- and the account it left still names its own file.
    expect((await record(from, id)).messages_path).toBe(join(sessionDir(from, id), `${id}.messages.json`));
  });

  it('redirects only what was carried', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cline-carry-'));
    const from = join(root, 'a');
    const to = join(root, 'b');
    await seed(from, 'c1', { compaction_path: '/elsewhere/c1.compaction.json' });
    await expect(carryNativeSession({ harness: cline, nativeId: 'c1', workspace: '/w', from: { HOME: from }, to: { HOME: to } }))
      .resolves.toBe('carried');
    expect((await record(to, 'c1')).compaction_path).toBe('/elsewhere/c1.compaction.json');
  });

  it('is unreachable when the session is not there', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cline-carry-'));
    await expect(carryNativeSession({ harness: cline, nativeId: 'none', workspace: '/w', from: { HOME: join(root, 'a') }, to: { HOME: join(root, 'b') } }))
      .resolves.toBeUndefined();
  });
});
