import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readState } from './read.js';
import { writeState } from './write.js';
import { resetHarnessStateCaches } from './index-file.js';
import { sweepState } from './sweep.js';
import type { HarnessSession } from '../model.js';

const previousHome = process.env.CLIKCODE_HOME;
let root = '';
afterEach(async () => {
  if (previousHome === undefined) delete process.env.CLIKCODE_HOME;
  else process.env.CLIKCODE_HOME = previousHome;
  resetHarnessStateCaches();
  if (root) await rm(root, { recursive: true, force: true });
});

const DAY = 86_400_000;
const chat = (id: string, extra: Partial<HarnessSession> = {}): HarnessSession => ({
  id, route: 'gateway', accountId: null, provider: 'gateway', model: null, effort: 'platform-managed', permissionMode: 'bypass',
createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: 'active',
  messages: [{ role: 'user', content: `hello ${id}` }], ...extra,
} as HarnessSession);

async function artifacts(id: string, ageMs = 0): Promise<string[]> {
  const paths = [join(root, 'sessions', id, 'harness.jsonl'), join(root, 'checkpoints', id, 't1', 'manifest.json'), join(root, 'turn-changes', `${id}.json`)];
  for (const path of paths) {
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, '{}');
  }
  const old = new Date(Date.now() - ageMs);
  for (const path of [join(root, 'sessions', id), join(root, 'checkpoints', id), join(root, 'turn-changes', `${id}.json`)]) await utimes(path, old, old);
  return [join(root, 'sessions', id), join(root, 'checkpoints', id), join(root, 'turn-changes', `${id}.json`)];
}

describe('deleting a conversation', () => {
  it('removes its agent history, checkpoints, and change log with it', async () => {
    root = await mkdtemp(join(tmpdir(), 'clikcode-forget-'));
    process.env.CLIKCODE_HOME = root;
    const state = await readState();
    state.sessions.push(chat('gone'), chat('kept'));
    await writeState(state);
    const gone = await artifacts('gone');
    const kept = await artifacts('kept');
    state.sessions = state.sessions.filter((session) => session.id !== 'gone');
    await writeState(state);
    for (const path of [...gone, join(root, 'sessions', 'gone.json')]) expect(existsSync(path)).toBe(false);
    for (const path of kept) expect(existsSync(path)).toBe(true);
  });
});

describe('the housekeeping sweep', () => {
  it('removes old orphans and strays, settles a dead turn, and keeps everything live', async () => {
    root = await mkdtemp(join(tmpdir(), 'clikcode-sweep-'));
    process.env.CLIKCODE_HOME = root;
    const state = await readState();
    const old = new Date(Date.now() - 3 * DAY).toISOString();
    state.sessions.push(
      chat('live'),
      chat('crashed', { pendingTurn: { prompt: 'do it', startedAt: old, updatedAt: old, outputStarted: true, response: 'half done' } }),
      chat('recent-turn', { pendingTurn: { prompt: 'now', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), outputStarted: false } }),
      chat('adopted', { messages: undefined, nativeSessionId: 'vendor-thread', name: 'Adopted' }),
    );
    await writeState(state);
    const live = await artifacts('live', 2 * DAY);
    const orphan = await artifacts('orphan', 2 * DAY);
    const fresh = await artifacts('just-created', 0);
    await writeFile(join(root, 'index.json.123.abc.tmp'), 'x');
    await utimes(join(root, 'index.json.123.abc.tmp'), new Date(Date.now() - DAY), new Date(Date.now() - DAY));

    const report = await sweepState();
    expect(report).toMatchObject({ orphans: 1, stranded: 1, settled: 1 });
    for (const path of orphan) expect(existsSync(path)).toBe(false);
    for (const path of [...live, ...fresh]) expect(existsSync(path)).toBe(true);

    resetHarnessStateCaches();
    const after = await readState();
    expect(after.sessions.map((session) => session.id).sort()).toEqual(['adopted', 'crashed', 'live', 'recent-turn']);
    const crashed = after.sessions.find((session) => session.id === 'crashed')!;
    expect(crashed.pendingTurn).toBeUndefined();
    expect(crashed.messages?.slice(-2)).toEqual([{ role: 'user', content: 'do it' }, { role: 'assistant', content: 'half done', origin: expect.objectContaining({ route: crashed.route }) }]);
    expect(after.sessions.find((session) => session.id === 'recent-turn')?.pendingTurn?.prompt).toBe('now');
  });
});
