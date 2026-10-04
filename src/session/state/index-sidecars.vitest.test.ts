import { afterEach, describe, expect, it } from 'vitest';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readState } from './read.js';
import { writeState } from './write.js';
import { resetHarnessStateCaches } from './index-file.js';
import { capInvocations } from './invocations.js';
import type { AiHarnessAccount } from '../../harness/definition.js';

const previousHome = process.env.CLIKCODE_HOME;
let root = '';
afterEach(async () => {
  if (previousHome === undefined) delete process.env.CLIKCODE_HOME;
  else process.env.CLIKCODE_HOME = previousHome;
  resetHarnessStateCaches();
  if (root) await rm(root, { recursive: true, force: true });
});

async function home(index: Record<string, unknown>): Promise<void> {
  root = await mkdtemp(join(tmpdir(), 'clikcode-sidecars-'));
  process.env.CLIKCODE_HOME = root;
  resetHarnessStateCaches();
  await writeFile(join(root, 'index.json'), JSON.stringify({
    version: 2, installationId: 'i', accounts: [], sessions: [], invocations: [], invocationRollups: {},
    globalSettings: {}, providerSettings: {}, ...index,
  }));
}

const call = (id: string, at: string, accountId = 'a') => ({ id, accountId, provider: 'p', model: 'm', at, latencyMs: 10, inputTokens: 1, outputTokens: 2 });
const json = async (name: string) => JSON.parse(await readFile(join(root, name), 'utf8'));
const lines = async () => (await readFile(join(root, 'invocations.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line).id);

describe('the invocation log beside the index', () => {
  it('moves an older index\'s invocations out on the first write, losing none', async () => {
    const now = new Date().toISOString();
    await home({ invocations: [call('x', now), call('y', now)] });
    const state = await readState();
    expect(state.invocations.map((item) => item.id)).toEqual(['x', 'y']);
    state.invocations.push(call('z', now));
    await writeState(state);
    expect((await json('index.json')).invocations).toBeUndefined();
    expect(await lines()).toEqual(['x', 'y', 'z']);
    resetHarnessStateCaches();
    expect((await readState()).invocations.map((item) => item.id)).toEqual(['x', 'y', 'z']);
  });

  it('appends a new call, and an index-only change does not touch the log', async () => {
    const now = new Date().toISOString();
    await home({});
    const state = await readState();
    state.invocations.push(call('a1', now));
    await writeState(state);
    const before = await readFile(join(root, 'invocations.jsonl'), 'utf8');
    state.globalSettings = { ...state.globalSettings, effort: 'high' } as typeof state.globalSettings;
    await writeState(state);
    expect(await readFile(join(root, 'invocations.jsonl'), 'utf8')).toBe(before);
    state.invocations.push(call('a2', now));
    await writeState(state);
    expect(await readFile(join(root, 'invocations.jsonl'), 'utf8')).toBe(`${before}${JSON.stringify(call('a2', now))}\n`);
  });

  it('skips a line torn by a crash, and the next write repairs the file', async () => {
    const now = new Date().toISOString();
    await home({});
    const state = await readState();
    state.invocations.push(call('ok', now));
    await writeState(state);
    await appendFile(join(root, 'invocations.jsonl'), '{"id":"torn","acc');
    resetHarnessStateCaches();
    const again = await readState();
    expect(again.invocations.map((item) => item.id)).toEqual(['ok']);
    again.invocations.push(call('next', now));
    await writeState(again);
    expect(await lines()).toEqual(['ok', 'next']);
  });

  it('keeps thirty days of calls and folds older ones into exact daily totals', () => {
    const now = Date.parse('2026-10-04T12:00:00Z');
    const day = (n: number) => new Date(now - n * 86_400_000).toISOString();
    const index = { invocations: [call('old1', day(40)), call('old2', day(40)), call('month', day(29)), call('new', day(0))], invocationRollups: {} } as never as Parameters<typeof capInvocations>[0];
    capInvocations(index, now);
    expect(index.invocations.map((item) => item.id)).toEqual(['month', 'new']);
    expect(Object.values(index.invocationRollups)).toEqual([expect.objectContaining({ calls: 2, inputTokens: 2, outputTokens: 4, latencyMs: 20 })]);
    // Within the slack nothing is rewritten.
    const recent = { invocations: [call('d31', day(31)), call('new', day(0))], invocationRollups: {} } as never as Parameters<typeof capInvocations>[0];
    capInvocations(recent, now);
    expect(recent.invocations).toHaveLength(2);
  });
});

describe('model lists stored once', () => {
  const account = (id: string, models: string[]): AiHarnessAccount => ({ id, provider: 'cursor', label: id, authKind: 'vendor-cli', models, status: 'ready', credentialRef: 'native:cursor' } as AiHarnessAccount);

  it('stores identical lists once and reads every account\'s list back', async () => {
    await home({});
    const models = Array.from({ length: 50 }, (_, index) => `model-${index}`);
    const state = await readState();
    state.accounts.push(account('c1', models), account('c2', models), account('c3', ['other']));
    await writeState(state);
    const stored = await json('index.json');
    expect(stored.accounts.map((item: { models: string[] }) => item.models)).toEqual([[], [], []]);
    expect(Object.keys((await json('account-models.json')).lists)).toHaveLength(2);
    resetHarnessStateCaches();
    const again = await readState();
    expect(again.accounts.map((item) => item.models)).toEqual([models, models, ['other']]);
  });

  it('takes a full list an older build wrote over the reference', async () => {
    await home({});
    const state = await readState();
    state.accounts.push(account('c1', ['a', 'b']));
    await writeState(state);
    const stored = await json('index.json');
    stored.accounts[0].models = ['a', 'b', 'c'];
    await writeFile(join(root, 'index.json'), JSON.stringify(stored));
    resetHarnessStateCaches();
    expect((await readState()).accounts[0]?.models).toEqual(['a', 'b', 'c']);
  });
});
