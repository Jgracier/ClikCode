import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readState } from './read.js';
import { writeState } from './write.js';

const previous = process.env.CLIKCODE_HOME;
let home: string | undefined;
afterEach(async () => {
  if (previous === undefined) delete process.env.CLIKCODE_HOME; else process.env.CLIKCODE_HOME = previous;
  if (home) await rm(home, { recursive: true, force: true });
  home = undefined;
});

const account = { id: 'a1', provider: 'anthropic', label: 'one', status: 'ready', models: [] };

describe('usage readings live beside the index', () => {
  it('a new reading leaves index.json as it was, and reads back on the account', async () => {
    home = await mkdtemp(join(tmpdir(), 'clikcode-readings-'));
    process.env.CLIKCODE_HOME = home;
    const state = await readState({ transcripts: [] });
    state.accounts.push({ ...account } as never);
    await writeState(state);
    const index = await readFile(join(home, 'index.json'), 'utf8');
    state.accounts[0]!.usage = { at: '2026-10-18T03:00:00.000Z', label: '5h 12%' } as never;
    state.accounts[0]!.usageCheckedAt = '2026-10-18T03:00:01.000Z';
    await writeState(state);
    expect(await readFile(join(home, 'index.json'), 'utf8')).toBe(index);
    expect(index).not.toContain('usage');
    const again = await readState({ transcripts: [] });
    expect(again.accounts[0]).toMatchObject({ usage: { label: '5h 12%' }, usageCheckedAt: '2026-10-18T03:00:01.000Z' });
  });

  it('takes the newer copy when an older build wrote a reading into index.json', async () => {
    home = await mkdtemp(join(tmpdir(), 'clikcode-readings-'));
    process.env.CLIKCODE_HOME = home;
    const state = await readState({ transcripts: [] });
    state.accounts.push({ ...account, usage: { at: '2026-10-18T03:00:00.000Z', label: 'old' } } as never);
    await writeState(state);
    const path = join(home, 'index.json');
    const raw = JSON.parse(await readFile(path, 'utf8'));
    raw.accounts[0].usage = { at: '2026-10-18T04:00:00.000Z', label: 'from an older build' };
    await writeFile(path, JSON.stringify(raw));
    const again = await readState({ transcripts: [] });
    expect(again.accounts[0]!.usage).toMatchObject({ label: 'from an older build' });
  });
});
