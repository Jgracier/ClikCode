import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { carryNativeSession } from '../../carry.js';
import { localHarnessForCommand } from '@clikcode/router/ai-local-harness';
import { vibeSessionDirectoryName } from './vibe-store.js';

/**
 * Mistral Vibe keeps a session as a directory named for its start time and
 * the first eight characters of its id, flat under the profile (VIBE_HOME):
 *   <VIBE_HOME>/logs/session/session_<YYYYMMDD_HHMMSS>_<id[:8]>/{messages.jsonl, meta.json}
 */
const vibe = localHarnessForCommand('vibe')!;
const ID = 'c148cd9a-16f7-6ff0-3fb0-310cac9a4e77';
const NAME = vibeSessionDirectoryName(ID, new Date('2026-10-05T03:52:54.512Z'));
const sessions = (vibeHome: string): string => join(vibeHome, 'logs', 'session');

async function seed(vibeHome: string, name: string, id: string): Promise<void> {
  const dir = join(sessions(vibeHome), name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'messages.jsonl'), '{"role":"user","content":"hi"}\n', 'utf8');
  await writeFile(join(dir, 'meta.json'), JSON.stringify({ session_id: id, total_messages: 1 }), 'utf8');
}

const profiles = async (): Promise<{ from: string; to: string; env: (vibeHome: string) => Record<string, string> }> => {
  const root = await mkdtemp(join(tmpdir(), 'vibe-carry-'));
  return { from: join(root, 'a'), to: join(root, 'b'), env: (vibeHome) => ({ HOME: root, VIBE_HOME: vibeHome }) };
};

describe('carrying a Vibe session between account profiles', () => {
  it('copies the session directory into the taking-over profile', async () => {
    const { from, to, env } = await profiles();
    await seed(from, NAME, ID);
    await expect(carryNativeSession({ harness: vibe, nativeId: ID, workspace: '/w', from: env(from), to: env(to) }))
      .resolves.toBe('carried');
    await expect(readFile(join(sessions(to), NAME, 'messages.jsonl'), 'utf8')).resolves.toContain('"hi"');
    // Copied, not moved: the account it left keeps its history.
    await expect(readFile(join(sessions(from), NAME, 'meta.json'), 'utf8')).resolves.toContain(ID);
  });

  it('takes the directory whose meta.json names the whole id, not just its first eight characters', async () => {
    const { from, to, env } = await profiles();
    await seed(from, 'session_20261001_000000_c148cd9a', 'c148cd9a-0000-0000-0000-000000000000');
    await seed(from, NAME, ID);
    await expect(carryNativeSession({ harness: vibe, nativeId: ID, workspace: '/w', from: env(from), to: env(to) }))
      .resolves.toBe('carried');
    await expect(readFile(join(sessions(to), NAME, 'meta.json'), 'utf8')).resolves.toContain(ID);
  });

  it('does not count a copy the taking-over account would never look at', async () => {
    const { from, to, env } = await profiles();
    await seed(from, NAME, ID);
    await mkdir(to, { recursive: true });
    await writeFile(join(to, 'config.toml'), '[session_logging]\nsave_dir = "/elsewhere"\n');
    await expect(carryNativeSession({ harness: vibe, nativeId: ID, workspace: '/w', from: env(from), to: env(to) }))
      .resolves.toBeUndefined();
  });

  it('is unreachable when the session is not there', async () => {
    const { from, to, env } = await profiles();
    await expect(carryNativeSession({ harness: vibe, nativeId: ID, workspace: '/w', from: env(from), to: env(to) }))
      .resolves.toBeUndefined();
  });
});
