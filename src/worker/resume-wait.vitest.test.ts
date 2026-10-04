/** "Wait for reset": a turn parked on the session until the provider's quota
 * comes back, then sent once by the worker. Fake clock; CLIKCODE_HOME is
 * throwaway; no vendor runs. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiHarnessAccount } from '../harness/definition';
import type { HarnessPrompter, PickerOption } from '../harness/prompter';
import type { HarnessSession } from '../session/model';
import { readState } from '../session/state/read';
import { writeState } from '../session/state/write';
import { forceStoreSession, unforceStoreSession } from '../session/ephemeral';
import { INTERRUPTED_TURN_REQUEST } from '../turn/failover-prompt';
import { RESUME_GRACE_MS, RESUME_MAX_SLEEP_MS, RESUME_RECHECK_MS, resumeStep, resumeWaitLabel, type ResumeAt } from '../turn/usage-exhausted';
import { carryOnAfterExhaustion, stopWaitingForReset } from '../tui/pickers/resume-in';
import { createResumeWaiter } from './resume-wait';

const T0 = new Date(2026, 9, 4, 15, 0, 0).getTime();
const RESET = T0 + 2 * 60 * 60_000;
const saved = process.env.CLIKCODE_HOME;
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cc-resume-wait-'));
  process.env.CLIKCODE_HOME = root;
});
afterEach(async () => {
  vi.useRealTimers();
  unforceStoreSession('s1');
  if (saved === undefined) delete process.env.CLIKCODE_HOME;
  else process.env.CLIKCODE_HOME = saved;
  await rm(root, { recursive: true, force: true });
});

/** An account whose 5h window is spent until RESET. */
const spentUntilReset = (id = 'a1'): AiHarnessAccount => ({
  id, provider: 'anthropic', label: id, authKind: 'vendor-cli', models: [], status: 'ready',
  usage: { at: new Date(T0).toISOString(), windows: [{ name: '5h', usedPct: 100, resetsAt: new Date(RESET).toISOString() }] },
} as unknown as AiHarnessAccount);

async function chat(fields: Partial<HarnessSession> = {}, accounts = [spentUntilReset()]): Promise<void> {
  const state = await readState();
  state.accounts.push(...accounts);
  const now = new Date(T0).toISOString();
  state.sessions.push({
    id: 's1', conversationId: 's1', route: 'local', accountId: 'a1', provider: 'anthropic', model: null, nativeHarness: 'claude',
    effort: 'medium', permissionMode: 'ask', accountFailover: 'on-quota-exhausted', createdAt: now, updatedAt: now, status: 'active',
    messages: [{ role: 'user', content: 'earlier' }, { role: 'assistant', content: 'done' }], ...fields,
  } as HarnessSession);
  forceStoreSession('s1');
  await writeState(state);
}
const parked = async (): Promise<ResumeAt | undefined> => (await readState()).sessions.find((item) => item.id === 's1')?.resumeAt;
const park = (prompt = INTERRUPTED_TURN_REQUEST): ResumeAt => ({ at: new Date(RESET).toISOString(), prompt, setAt: new Date(T0).toISOString() });

describe('resumeStep', () => {
  const resumeAt = park();
  it('sleeps until the reset, never longer than one look', () => {
    expect(resumeStep(resumeAt, [spentUntilReset()], 'anthropic', T0)).toEqual({ wait: RESUME_MAX_SLEEP_MS });
    expect(resumeStep(resumeAt, [spentUntilReset()], 'anthropic', RESET - 1000)).toEqual({ wait: 1000 });
  });
  it('sends once the reset passed and an account of the same provider can take it', () => {
    expect(resumeStep(resumeAt, [spentUntilReset()], 'anthropic', RESET)).toBe('send');
    expect(resumeStep(resumeAt, [spentUntilReset()], 'openai', RESET)).toEqual({ wait: RESUME_RECHECK_MS });
  });
  it('keeps looking past the reset for a while, then gives up', () => {
    const held = { ...spentUntilReset(), status: 'signed-out' } as unknown as AiHarnessAccount;
    expect(resumeStep(resumeAt, [held], 'anthropic', RESET + 1000)).toEqual({ wait: RESUME_RECHECK_MS });
    expect(resumeStep(resumeAt, [held], 'anthropic', RESET + RESUME_GRACE_MS)).toBe('give-up');
  });
  it('reads as the status line and board row show it', () => {
    expect(resumeWaitLabel(resumeAt, T0)).toBe('waiting for reset · 5:00PM');
  });
});

describe('the worker waiting for the reset', () => {
  const host = (overrides: { running?: () => boolean } = {}) => {
    const sent: string[] = [];
    const notices: string[] = [];
    const waiter = createResumeWaiter({
      sessionId: 's1', turnRunning: overrides.running ?? (() => false),
      send: (prompt) => sent.push(prompt), notice: (message) => notices.push(message), changed: () => undefined,
    });
    return { waiter, sent, notices };
  };

  it('holds the parked turn until the reset, sends it once, and clears it first', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: T0 });
    await chat({ resumeAt: park() });
    const { waiter, sent } = host();
    await waiter.check();
    expect(waiter.pending).toBe(true);
    for (let step = 0; step < 11; step += 1) await vi.advanceTimersByTimeAsync(RESUME_MAX_SLEEP_MS);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(RESET - Date.now());
    await vi.waitFor(() => expect(sent).toEqual([INTERRUPTED_TURN_REQUEST]));
    expect(await parked()).toBeUndefined();
    expect(waiter.pending).toBe(false);
    // Nothing is parked any more: a later look sends nothing.
    await waiter.check();
    expect(sent).toHaveLength(1);
  });

  it('survives a worker restart: the next worker finds it on the session', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: RESET + 5000 });
    await chat({ resumeAt: park('fix the parser') });
    const { waiter, sent } = host();
    await waiter.check();
    expect(sent).toEqual(['fix the parser']);
  });

  it('waits for a running turn to end before sending', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: RESET + 5000 });
    await chat({ resumeAt: park() });
    let running = true;
    const { waiter, sent } = host({ running: () => running });
    await waiter.check();
    expect(sent).toEqual([]);
    expect(waiter.pending).toBe(true);
    running = false;
    await waiter.check();
    expect(sent).toHaveLength(1);
  });

  it('a cancel or a new message drops it, with a notice', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: T0 });
    await chat({ resumeAt: park() });
    const { waiter, sent, notices } = host();
    await waiter.check();
    await waiter.cancel('Stopped waiting for the reset');
    expect(notices).toEqual(['Stopped waiting for the reset']);
    expect(await parked()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(RESET - T0 + RESUME_RECHECK_MS);
    expect(sent).toEqual([]);
    // Nothing parked: cancel says nothing.
    await waiter.cancel('again');
    expect(notices).toHaveLength(1);
  });

  it('stops with a notice when no account can take it an hour past the reset', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: RESET + RESUME_GRACE_MS });
    await chat({ resumeAt: park() }, [{ ...spentUntilReset(), status: 'signed-out' } as unknown as AiHarnessAccount]);
    const { waiter, sent, notices } = host();
    await waiter.check();
    expect(sent).toEqual([]);
    expect(notices[0]).toMatch(/Stopped waiting for the reset/);
    expect(await parked()).toBeUndefined();
  });
});

describe('"Wait for reset" in the Resume-in picker', () => {
  it('parks the continuation of the interrupted turn on the session', async () => {
    await chat({ pendingTurn: { prompt: 'fix the parser', response: 'half', startedAt: '', updatedAt: '', outputStarted: true } },
      [{ ...spentUntilReset(), usage: { at: new Date().toISOString(), windows: [{ name: '5h', usedPct: 100, resetsAt: new Date(Date.now() + 3_600_000).toISOString() }] } } as unknown as AiHarnessAccount]);
    let offered: string[] = [];
    const rl = { select: async (_title: string, options: readonly PickerOption<string>[]) => {
      offered = options.map((option) => option.label);
      return options.at(-1)!.value;
    } } as unknown as HarnessPrompter;
    const next = await carryOnAfterExhaustion(rl, 's1', 'fix the parser', {});
    expect(offered.at(-1)).toMatch(/^Wait for reset \(\d+:\d\d[AP]M/);
    expect('waiting' in next && next.waiting.prompt).toBe(INTERRUPTED_TURN_REQUEST);
    expect((await parked())?.prompt).toBe(INTERRUPTED_TURN_REQUEST);
    expect(await stopWaitingForReset('s1')).toBe(true);
    expect(await parked()).toBeUndefined();
  });
});
