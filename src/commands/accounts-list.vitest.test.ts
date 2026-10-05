/** `clikcode accounts list` is what a person, or an agent checking accounts,
 * reads for what is left: usage, whether each can take a turn, and how many
 * others of its provider a chat can move to at the limit. Runs the built CLI
 * against a throwaway home; api-key accounts, so no vendor is ever probed. */
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const entry = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'index.js');
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'cc-accounts-list-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const env = (): NodeJS.ProcessEnv => ({ ...process.env, CLIKCODE_HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'config') });
const clikcode = (...args: string[]): Record<string, unknown> => JSON.parse(execFileSync(process.execPath, [entry, ...args], { encoding: 'utf8', env: env() }));

describe('accounts list', () => {
  it('says what is left on each account and what happens at the limit, without the model catalog', async () => {
    process.env.CLIKCODE_HOME = join(root, 'home');
    const { readState } = await import('../session/state/read.js');
    const { writeState } = await import('../session/state/write.js');
    const state = await readState();
    const account = (id: string, extra: Record<string, unknown> = {}) => ({
      id, provider: 'anthropic', label: id, authKind: 'api-key', models: ['m1', 'm2', 'm3'], status: 'ready', ...extra,
    });
    state.accounts.push(
      account('a1') as never,
      account('a2') as never,
      account('a3', { quotaState: 'exhausted', quotaExhaustedAt: new Date().toISOString() }) as never,
    );
    await writeState(state);
    const listed = clikcode('accounts', 'list') as { accounts: Array<Record<string, unknown>>; onLimit: string };
    expect(listed.onLimit).toMatch(/another account of the same provider/);
    const byId = Object.fromEntries(listed.accounts.map((item) => [item.id, item]));
    expect(byId.a1).toMatchObject({ usage: 'not reported', canTakeTurn: true, fallbacks: 1 });
    expect(byId.a3).toMatchObject({ canTakeTurn: false, fallbacks: 2 });
    expect(byId.a1!.models).toBeUndefined();
    const full = clikcode('accounts', 'list', '--models') as { accounts: Array<Record<string, unknown>> };
    expect(full.accounts[0]!.models).toEqual(['m1', 'm2', 'm3']);
  }, 60_000);
});
