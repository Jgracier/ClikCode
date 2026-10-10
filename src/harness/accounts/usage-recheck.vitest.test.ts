import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AiHarnessAccount } from '../definition.js';
import type { HarnessState } from '../../session/model.js';
import { readState } from '../../session/state/read.js';
import { writeState } from '../../session/state/write.js';
import { recheckRecoveredAccounts } from './account-usage.js';

const previousHome = process.env.CLIKCODE_HOME;
let root: string | undefined;

afterEach(async () => {
  if (previousHome === undefined) delete process.env.CLIKCODE_HOME;
  else process.env.CLIKCODE_HOME = previousHome;
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

const held = (id: string): AiHarnessAccount => ({
  id, provider: 'anthropic', label: id, authKind: 'vendor-cli', models: [], status: 'ready', credentialRef: `native:${id}`,
  quotaState: 'exhausted', quotaExhaustedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
});

/** What a real probe leaves: the shared clock stamped on the stored account. */
async function stamp(id: string): Promise<void> {
  const state = await readState({ transcripts: [] });
  state.accounts.find((item) => item.id === id)!.usageCheckedAt = new Date().toISOString();
  await writeState(state);
}

describe('re-reading held accounts', () => {
  it('asks each due account once, however many ticks and windows want it', async () => {
    root = await mkdtemp(join(tmpdir(), 'clikcode-recheck-'));
    process.env.CLIKCODE_HOME = root;
    const state = await readState();
    state.accounts.push(held('a'), held('b'), held('c'));
    await writeState(state);
    const asked: string[] = [];
    const ask = async (account: AiHarnessAccount): Promise<void> => {
      asked.push(account.id);
      await new Promise((resolve) => setTimeout(resolve, 20));
      await stamp(account.id);
      // Another window read `c` meanwhile and published it.
      if (account.id === 'a') await stamp('c');
    };
    const options = { ask, canBeAsked: () => true };
    // Two ticks of this window, both from a read made before any probe.
    const first = await readState({ transcripts: [] }) as HarnessState;
    const second = await readState({ transcripts: [] }) as HarnessState;
    await Promise.all([recheckRecoveredAccounts(first, options), recheckRecoveredAccounts(second, options)]);
    expect(asked).toEqual(['a', 'b']);
    // Nothing is due again until the clock says so.
    await recheckRecoveredAccounts(await readState({ transcripts: [] }), options);
    expect(asked).toEqual(['a', 'b']);
  });

  it('leaves the pass to another process that is running one', async () => {
    root = await mkdtemp(join(tmpdir(), 'clikcode-recheck-'));
    process.env.CLIKCODE_HOME = root;
    const state = await readState();
    state.accounts.push(held('a'));
    await writeState(state);
    const lease = join(root, 'cache', 'usage-recheck.lease');
    await mkdir(join(root, 'cache'), { recursive: true });
    await writeFile(lease, JSON.stringify({ pid: process.ppid, host: hostname(), nonce: 'other', at: new Date().toISOString() }));
    const asked: string[] = [];
    const options = { ask: async (account: AiHarnessAccount) => { asked.push(account.id); }, canBeAsked: () => true };
    await recheckRecoveredAccounts(await readState({ transcripts: [] }), options);
    expect(asked).toEqual([]);
    // Its owner gone: the lease is taken over.
    await writeFile(lease, JSON.stringify({ pid: 2 ** 22 + 7, host: hostname(), nonce: 'gone', at: new Date().toISOString() }));
    await recheckRecoveredAccounts(await readState({ transcripts: [] }), options);
    expect(asked).toEqual(['a']);
  });
});
