/** A vendor status probe that never answers must not hold `accounts list`:
 * the account shows "checking…" (or its last reading) and the rest is listed. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../harness/accounts/usage-probes.js', async (original) => ({
  ...(await original<typeof import('../harness/accounts/usage-probes.js')>()),
  NATIVE_USAGE_PROBES: { claude: () => new Promise(() => undefined), codex: async () => ({ windows: [], label: '42 credits' }) },
}));
const emitted: Array<{ accounts: Array<Record<string, unknown>> }> = [];
vi.mock('../cli/structured-output.js', () => ({ emitResult: (value: never) => { emitted.push(value); } }));

const previousHome = process.env.CLIKCODE_HOME;
let root: string | undefined;
afterEach(async () => {
  if (previousHome === undefined) delete process.env.CLIKCODE_HOME; else process.env.CLIKCODE_HOME = previousHome;
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe('accounts list with a probe that never answers', () => {
  it('lists every account without waiting for it', async () => {
    root = await mkdtemp(join(tmpdir(), 'cc-list-hung-'));
    process.env.CLIKCODE_HOME = root;
    const { readState } = await import('../session/state/read.js');
    const { writeState } = await import('../session/state/write.js');
    const { aiAccountsList } = await import('./account.js');
    const state = await readState();
    const account = (id: string, provider: string) => ({ id, provider, label: id, authKind: 'vendor-cli', models: [], status: 'ready', credentialRef: `native:${id}` }) as never;
    state.accounts.push(account('hung', 'anthropic'), account('fine', 'openai'));
    await writeState(state);
    const started = Date.now();
    await aiAccountsList();
    expect(Date.now() - started).toBeLessThan(5_000);
    const byId = Object.fromEntries(emitted[0]!.accounts.map((item) => [item.id, item]));
    expect(byId.hung).toMatchObject({ usage: 'checking…' });
    expect(byId.fine).toMatchObject({ usage: '42 credits' });
  }, 15_000);
});
