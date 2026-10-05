import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readdir, readFile, realpath, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { carryNativeSession } from '../../carry.js';
import { kiroOneShotSessionDirectory } from './kiro-store.js';
import { localHarnessForCommand } from '@clikcode/router/ai-local-harness';

/**
 * Kiro's ACP agent keeps a session as two sibling files in one directory
 * shared by every session:
 *   <HOME>/.kiro/sessions/cli/<id>.jsonl   the conversation
 *   <HOME>/.kiro/sessions/cli/<id>.json    the metadata that makes it a session
 *
 * Not one path, so the store carries the pair itself. The one-shot CLI
 * (`chat --agent-engine v3`) keeps a directory per session instead:
 *   <HOME>/.kiro/sessions/<sha256(cwd)[:16]>/sess_<uuid>/
 */
const kiro = localHarnessForCommand('kiro')!;
const cli = (home: string): string => join(home, '.kiro', 'sessions', 'cli');

async function seed(home: string, id: string, conversation = '{"kind":"Prompt"}\n'): Promise<void> {
  await mkdir(cli(home), { recursive: true });
  await writeFile(join(cli(home), `${id}.jsonl`), conversation, 'utf8');
  await writeFile(join(cli(home), `${id}.json`), `{"session_id":"${id}"}\n`, 'utf8');
}

const homes = async (): Promise<{ from: string; to: string }> => {
  const root = await mkdtemp(join(tmpdir(), 'kiro-carry-'));
  return { from: join(root, 'a'), to: join(root, 'b') };
};

describe('carrying a Kiro session between account profiles', () => {
  it('copies both files into the taking-over profile, and only that session', async () => {
    const { from, to } = await homes();
    await seed(from, 'k1');
    await seed(from, 'other');
    await seed(to, 'theirs');
    await expect(carryNativeSession({ harness: kiro, nativeId: 'k1', workspace: '/w', from: { HOME: from }, to: { HOME: to } }))
      .resolves.toBe('carried');
    expect((await readdir(cli(to))).sort()).toEqual(['k1.json', 'k1.jsonl', 'theirs.json', 'theirs.jsonl']);
    await expect(readFile(join(cli(to), 'k1.jsonl'), 'utf8')).resolves.toContain('Prompt');
    // Copied, not moved: the account it left keeps its history.
    expect((await readdir(cli(from))).sort()).toEqual(['k1.json', 'k1.jsonl', 'other.json', 'other.jsonl']);
  });

  it('replaces an older copy with a newer, longer one, and keeps a current one', async () => {
    const { from, to } = await homes();
    await seed(to, 'k2', '{"kind":"Prompt"}\n');
    const old = new Date(Date.now() - 60_000);
    await utimes(join(cli(to), 'k2.jsonl'), old, old);
    await utimes(join(cli(to), 'k2.json'), old, old);
    await seed(from, 'k2', '{"kind":"Prompt"}\n{"kind":"AssistantMessage"}\n');
    await expect(carryNativeSession({ harness: kiro, nativeId: 'k2', workspace: '/w', from: { HOME: from }, to: { HOME: to } }))
      .resolves.toBe('carried');
    await expect(readFile(join(cli(to), 'k2.jsonl'), 'utf8')).resolves.toContain('AssistantMessage');

    // Back again, with the source now the shorter, older one: nothing changes.
    await writeFile(join(cli(to), 'k2.jsonl'), '{"kind":"Prompt"}\n{"kind":"AssistantMessage"}\n{"kind":"Prompt"}\n', 'utf8');
    await expect(carryNativeSession({ harness: kiro, nativeId: 'k2', workspace: '/w', from: { HOME: from }, to: { HOME: to } }))
      .resolves.toBe('carried');
    expect((await readFile(join(cli(to), 'k2.jsonl'), 'utf8')).trimEnd().split('\n')).toHaveLength(3);
  });

  it('carries a one-shot CLI session directory, under the hash of the cwd, and only that session', async () => {
    const { from, to } = await homes();
    const workspace = await mkdtemp(join(tmpdir(), 'kiro-ws-'));
    // Kiro's own layout, spelled out rather than taken from the store, so a
    // change to the store's path definition cannot pass unnoticed.
    const project = createHash('sha256').update(workspace).digest('hex').slice(0, 16);
    const session = (home: string, id: string): string => join(home, '.kiro', 'sessions', project, id);
    expect(kiroOneShotSessionDirectory({ HOME: from }, workspace, 'sess_1')).toBe(session(from, 'sess_1'));
    for (const id of ['sess_1', 'sess_other']) {
      await mkdir(session(from, id), { recursive: true });
      await writeFile(join(session(from, id), 'session.json'), `{"id":"${id}"}\n`, 'utf8');
      await writeFile(join(session(from, id), 'messages.jsonl'), '{"payload":{"type":"user"}}\n', 'utf8');
    }
    await expect(carryNativeSession({ harness: kiro, nativeId: 'sess_1', workspace, from: { HOME: from }, to: { HOME: to } }))
      .resolves.toBe('carried');
    expect(await readdir(join(to, '.kiro', 'sessions', project))).toEqual(['sess_1']);
    expect((await readdir(session(to, 'sess_1'))).sort()).toEqual(['messages.jsonl', 'session.json']);
    // Copied, not moved.
    expect((await readdir(join(from, '.kiro', 'sessions', project))).sort()).toEqual(['sess_1', 'sess_other']);

    // A workspace whose session is not there, or an id that is not a name: nothing.
    await expect(carryNativeSession({ harness: kiro, nativeId: 'sess_1', workspace: '/elsewhere', from: { HOME: from }, to: { HOME: to } }))
      .resolves.toBeUndefined();
    await expect(carryNativeSession({ harness: kiro, nativeId: '../sess_1', workspace, from: { HOME: from }, to: { HOME: to } }))
      .resolves.toBeUndefined();
  });

  it('finds a one-shot session Kiro filed under the real path of a symlinked workspace', async () => {
    const { from, to } = await homes();
    const real = await mkdtemp(join(tmpdir(), 'kiro-real-'));
    const linked = `${real}-link`;
    await symlink(real, linked);
    const directory = kiroOneShotSessionDirectory({ HOME: from }, await realpath(real), 'sess_2');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'session.json'), '{"id":"sess_2"}\n', 'utf8');
    await expect(carryNativeSession({ harness: kiro, nativeId: 'sess_2', workspace: linked, from: { HOME: from }, to: { HOME: to } }))
      .resolves.toBe('carried');
    await expect(readFile(join(kiroOneShotSessionDirectory({ HOME: to }, await realpath(real), 'sess_2'), 'session.json'), 'utf8'))
      .resolves.toContain('sess_2');
  });

  it('is unreachable, changing nothing, when either file is missing', async () => {
    const { from, to } = await homes();
    await mkdir(cli(from), { recursive: true });
    await writeFile(join(cli(from), 'half.jsonl'), '{"kind":"Prompt"}\n', 'utf8');
    await expect(carryNativeSession({ harness: kiro, nativeId: 'half', workspace: '/w', from: { HOME: from }, to: { HOME: to } }))
      .resolves.toBeUndefined();
    await expect(readdir(cli(to))).rejects.toThrow();
    await expect(carryNativeSession({ harness: kiro, nativeId: 'none', workspace: '/w', from: { HOME: from }, to: { HOME: to } }))
      .resolves.toBeUndefined();
  });
});
