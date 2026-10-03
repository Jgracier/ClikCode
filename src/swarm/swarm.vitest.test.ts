/** A host may delegate only to a provider that published a usage amount and
 * still has some of it left. The clerk is not a conversation. */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AiHarnessAccount } from '../harness/definition.js';
import { activityLifecyclePhase } from '../harness/protocol/activity-view.js';
import { allLocalHarnesses } from '../runtime/lazy-bridge.js';
import type { HarnessSession, HarnessState } from '../session/model.js';
import { sessionPickerOptions } from '../session/options.js';
import { workingDetail } from '../tui/pickers/conversation-activity.js';
import { beginTurn, boardSlice, cardFromReply, emptyBoard, goalKey, keepOnHost } from './board.js';
import { swarmIsOn } from './policy.js';
import type { HarnessActivityEvent } from '../harness/prompter.js';
import { emptySwarmFold, foldSwarmActivity, isSwarmToolLabel } from './fold.js';
import { swarmProgressLabel } from './mcp.js';
import { formatSwarmOffers, swarmChoiceNote, swarmOffers } from './offers.js';
import { clerkAccounts, pickClerkAccount, runSwarmDelegation } from './run.js';
import { lookupScore, scoresFromOpenRouter } from './scores.js';
import { readBoard } from './store.js';
import { clerkUsage } from './usage.js';

const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const ISO = new Date(NOW).toISOString();
const home = process.env.CLIKCODE_HOME;

afterEach(() => {
  if (home === undefined) delete process.env.CLIKCODE_HOME;
  else process.env.CLIKCODE_HOME = home;
});

function account(partial: Partial<AiHarnessAccount> & Pick<AiHarnessAccount, 'id' | 'provider' | 'label'>): AiHarnessAccount {
  return { authKind: 'vendor-cli', models: [], status: 'ready', credentialRef: 'none', ...partial };
}

function windows(usedPct: number, extra?: { advisory?: true; resetsAt?: string }): AiHarnessAccount['usage'] {
  return { at: ISO, windows: [{ name: '5h', usedPct, ...extra }] } as AiHarnessAccount['usage'];
}

function host(extra: Partial<HarnessSession> = {}): HarnessSession {
  return {
    id: 'host', conversationId: 'host', route: 'local', accountId: 'claude-acct', provider: 'anthropic', model: 'sonnet',
    effort: 'medium', permissionMode: 'ask', accountFailover: 'never', createdAt: ISO, updatedAt: ISO, status: 'active',
    nativeHarness: 'claude', swarm: ['lean'], ...extra,
  } as HarnessSession;
}

function state(accounts: AiHarnessAccount[]): HarnessState {
  return { accounts } as HarnessState;
}

describe('who a host may delegate to', () => {
  it('requires a current reading with a numeric amount and some of it left', () => {
    const withRoom = account({ id: 'cursor', provider: 'cursor', label: 'Ada', usage: windows(38) });
    expect(clerkUsage(withRoom, NOW)?.leftPct).toBe(62);
    expect(clerkUsage(account({ id: 'none', provider: 'cursor', label: 'No reading' }), NOW)).toBeUndefined();
    expect(clerkUsage(account({ id: 'fail', provider: 'cursor', label: 'Failed', usage: { at: ISO, failed: true, windows: [{ name: '5h', usedPct: 10 }] } as AiHarnessAccount['usage'] }), NOW)).toBeUndefined();
    expect(clerkUsage(account({ id: 'spent', provider: 'cursor', label: 'Spent', usage: windows(100) }), NOW)).toBeUndefined();
    expect(clerkUsage(account({ id: 'stale', provider: 'cursor', label: 'Stale', usage: windows(10, { resetsAt: '2026-09-01T00:00:00.000Z' }) }), NOW)).toBeUndefined();
    expect(clerkUsage(account({ id: 'out', provider: 'cursor', label: 'Signed out', status: 'needs_login', usage: windows(10) }), NOW)).toBeUndefined();
  });

  it('keeps an advisory window when that is the only amount the vendor published', () => {
    const auto = account({ id: 'auto', provider: 'cursor', label: 'Auto', usage: windows(40, { advisory: true }) });
    expect(clerkUsage(auto, NOW)?.leftPct).toBe(60);
  });

  it('uses the tightest binding window and ignores a tighter advisory one', () => {
    const mixed = account({
      id: 'mixed', provider: 'cursor', label: 'Mixed',
      usage: { at: ISO, windows: [{ name: '5h', usedPct: 20 }, { name: 'api', usedPct: 90, advisory: true }] } as AiHarnessAccount['usage'],
    });
    expect(clerkUsage(mixed, NOW)?.leftPct).toBe(80);
  });

  it('lists every other account with room, most left first, and leaves only the host account out', () => {
    const accounts = [
      account({ id: 'claude-acct', provider: 'anthropic', label: 'Claude', usage: windows(1) }),
      account({ id: 'claude-2', provider: 'anthropic', label: 'Second', usage: windows(10) }),
      account({ id: 'cursor', provider: 'cursor', label: 'Ada', usage: windows(70) }),
      account({ id: 'codex', provider: 'openai', label: 'Bea', usage: windows(20) }),
      account({ id: 'devin', provider: 'devin', label: 'Dev', usage: windows(50) }),
      account({ id: 'quiet', provider: 'opencode', label: 'No amount' }),
      account({ id: 'empty', provider: 'gemini', label: 'Spent', usage: windows(100) }),
    ];
    const pool = clerkAccounts(state(accounts), host(), NOW);
    expect(pool.map((row) => [row.command, row.account.label, Math.round(row.leftPct)])).toEqual([
      ['claude', 'Second', 90],
      ['codex', 'Bea', 80],
      ['devin', 'Dev', 50],
      ['cursor', 'Ada', 30],
    ]);
    expect(pickClerkAccount(state(accounts), host(), NOW, new Set(['claude-2']))?.account.id).toBe('codex');
  });

  it('can use every terminal harness once that harness has usage left', () => {
    const terminal = allLocalHarnesses().filter((harness) => harness.surface === 'terminal');
    const accounts = terminal.map((harness) => account({
      id: `acct-${harness.command}`, provider: harness.provider, label: harness.displayName, usage: windows(10),
    }));
    const pool = clerkAccounts(state(accounts), host({ accountId: 'the-host' }), NOW);
    const commands = new Set(pool.map((row) => row.command));
    expect(terminal.filter((harness) => !commands.has(harness.command)).map((harness) => harness.command)).toEqual([]);
  });
});

describe('the model list', () => {
  it('lists only model ids accounts with usage actually have', () => {
    const accounts = [
      account({ id: 'cursor', provider: 'cursor', label: 'Ada', usage: windows(70), models: ['claude-sonnet-4.5'] }),
      account({ id: 'cursor-2', provider: 'cursor', label: 'Bea', usage: windows(20), models: ['claude-sonnet-4.5', 'haiku'] }),
      account({ id: 'codex', provider: 'openai', label: 'Codex', usage: windows(40), models: [] }),
    ];
    const offers = swarmOffers(clerkAccounts(state(accounts), host(), NOW), {
      fetchedAt: NOW, byKey: { claudesonnet45: { coding: 63, intelligence: 71 } },
    });
    expect(offers.map((offer) => offer.model)).toEqual(['claude-sonnet-4.5', 'haiku']);
    expect(offers[0]?.seats[0]?.candidate.account.id).toBe('cursor-2');
    expect(formatSwarmOffers(offers)).toContain('claude-sonnet-4.5 · coding 63 · intelligence 71 · 80% left');
    expect(formatSwarmOffers(offers)).toContain('haiku · Cursor Agent · 80% left');
    expect(formatSwarmOffers(offers)).not.toContain('codex');
    expect(swarmChoiceNote(offers)).toContain('Do not invent a model');
  });

  it('reads an OpenRouter intelligence index from the catalog body', () => {
    const scores = scoresFromOpenRouter(JSON.stringify({
      data: [{ id: 'anthropic/claude-sonnet-4.5', canonical_slug: 'anthropic/claude-sonnet-4.5-20260928', pricing: { prompt: '0.000003', completion: '0.000015' }, benchmarks: { artificial_analysis: { intelligence_index: 56, coding_index: null } } }],
    }));
    expect(scores.claudesonnet45).toEqual({ intelligence: 56, promptPerM: 3, completionPerM: 15 });
    const cache = { fetchedAt: NOW, byKey: scores };
    expect(lookupScore(cache, 'claude-sonnet-4.5')).toEqual({ intelligence: 56, promptPerM: 3, completionPerM: 15 });
    expect(lookupScore(cache, 'claude-sonnet-4-5')).toEqual({ intelligence: 56, promptPerM: 3, completionPerM: 15 });
  });

  it('keeps the harness price when a cheaper batch row shares the name', () => {
    const scores = scoresFromOpenRouter(JSON.stringify({
      data: [
        { id: 'anthropic/claude-sonnet-4.5:batch', canonical_slug: 'anthropic/claude-sonnet-4.5-20260928', pricing: { prompt: '0.000001', completion: '0.000005' }, benchmarks: { artificial_analysis: { intelligence_index: 56 } } },
        { id: 'anthropic/claude-sonnet-4.5', canonical_slug: 'anthropic/claude-sonnet-4.5-20260928', pricing: { prompt: '0.000003', completion: '0.000015' }, benchmarks: { artificial_analysis: { intelligence_index: 56 } } },
      ],
    }));
    expect(scores.claudesonnet45).toMatchObject({ promptPerM: 3, completionPerM: 15 });
  });

  it('shows the price and keeps a cheaper model beside the strongest', () => {
    const accounts = [
      account({
        id: 'cursor', provider: 'cursor', label: 'Ada', usage: windows(20),
        models: ['claude-opus-4.5', 'claude-sonnet-4.5', 'claude-haiku-4.5'],
      }),
    ];
    const offers = swarmOffers(clerkAccounts(state(accounts), host(), NOW), {
      fetchedAt: NOW,
      byKey: {
        claudeopus45: { coding: 80, intelligence: 85, promptPerM: 15, completionPerM: 75 },
        claudesonnet45: { coding: 63, intelligence: 71, promptPerM: 3, completionPerM: 15 },
        claudehaiku45: { coding: 40, intelligence: 45, promptPerM: 1, completionPerM: 5 },
      },
    });
    expect(offers.map((offer) => offer.model)).toEqual(['claude-opus-4.5', 'claude-sonnet-4.5', 'claude-haiku-4.5']);
    expect(formatSwarmOffers(offers)).toContain('claude-haiku-4.5 · coding 40 · intelligence 45 · $1 in / $5 out · 80% left');
    expect(swarmChoiceNote(offers)).toContain('cheaper model');
  });

  it('keeps every account model, including a cheap one and one with no score', () => {
    const accounts = [
      account({
        id: 'cursor', provider: 'cursor', label: 'Ada', usage: windows(10),
        models: ['claude-opus-4.5', 'claude-haiku-4.5', 'composer-2.5'],
      }),
    ];
    const offers = swarmOffers(clerkAccounts(state(accounts), host(), NOW), {
      fetchedAt: NOW,
      byKey: {
        claudeopus45: { coding: 80, promptPerM: 15, completionPerM: 75 },
        claudehaiku45: { coding: 40, promptPerM: 1, completionPerM: 5 },
      },
    });
    expect(offers.map((offer) => offer.model)).toEqual(['claude-opus-4.5', 'claude-haiku-4.5', 'composer-2.5']);
  });
});

describe('a delegation', () => {
  it('stays on the host for one file, and runs a clerk when the work spans files', async () => {
    expect(keepOnHost('What does src/app.ts export?')).toBe(true);
    expect(keepOnHost('Review src/a.ts and src/b.ts across the tree')).toBe(false);
    const dir = await mkdtemp(join(tmpdir(), 'clikcode-swarm-'));
    process.env.CLIKCODE_HOME = dir;
    const cursor = account({ id: 'cursor', provider: 'cursor', label: 'Ada', usage: windows(38) });
    const session = host({ id: 'span' });
    const own = await runSwarmDelegation({
      host: session, state: state([cursor]),
      request: { prompt: 'What does src/app.ts export?', description: 'one file', callId: 'own' },
      runClerk: async () => { throw new Error('the host should have kept this'); },
    });
    expect(own).toBeNull();
    const events: HarnessActivityEvent[] = [];
    const done = await runSwarmDelegation({
      host: session, state: state([cursor]),
      request: { prompt: 'Review src/a.ts and src/b.ts across the tree', description: 'review the pair', callId: 'pair' },
      onActivity: (event) => { events.push(event); },
      runClerk: async (input) => {
        input.onStep?.('Read src/a.ts');
        return '{"summary":"both files export a router","facts":["src/a.ts: exports router"],"paths":["src/a.ts","src/b.ts"],"questions":[]}';
      },
    });
    expect(done?.swarm).toEqual({ provider: 'cursor', displayName: 'Cursor Agent', role: 'review', usageLeft: 62 });
    expect(done?.output).toContain('both files export a router');
    expect(done?.activityLabel).toBe('Cursor Agent · review · review the pair');
    expect(events.map((event) => [event.kind, event.id, event.parentId])).toEqual([
      ['tool-start', 'pair', undefined],
      ['tool-start', 'pair/1', 'pair'],
      ['tool-done', 'pair', undefined],
    ]);
    expect(events[0]?.label).toBe('Cursor Agent · review · review the pair');
    expect(events[2]?.label).toBe(events[0]?.label);
    expect(events[2]?.output?.join('\n')).toContain('both files export a router');
    expect((await readBoard(session.id)).goal).toBe('review the pair');
  });

  it('runs the named model on the account that has it and the most usage left', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'clikcode-swarm-'));
    process.env.CLIKCODE_HOME = dir;
    const cursor = account({ id: 'cursor', provider: 'cursor', label: 'Ada', usage: windows(70), models: ['claude-sonnet-4.5'] });
    const codex = account({ id: 'codex', provider: 'openai', label: 'Bea', usage: windows(20), models: [] });
    let ran: { accountId?: string; model?: string } = {};
    const done = await runSwarmDelegation({
      host: host({ id: 'pick-model' }), state: state([cursor, codex]),
      scores: { fetchedAt: NOW, byKey: { claudesonnet45: { coding: 63, intelligence: 71 } } },
      request: { prompt: 'What does src/app.ts export?', description: 'one file', callId: 'named', model: 'claude-sonnet-4.5' },
      runClerk: async (input) => {
        ran = { accountId: input.account.id, model: input.model };
        return '{"summary":"it exports a router"}';
      },
    });
    expect(ran).toEqual({ accountId: 'cursor', model: 'claude-sonnet-4.5' });
    expect(done?.output).toContain('it exports a router');
    expect(done?.activityLabel).toContain('claude-sonnet-4.5');
  });

  it('says so when nobody has published an amount with room left', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'clikcode-swarm-'));
    process.env.CLIKCODE_HOME = dir;
    const result = await runSwarmDelegation({
      host: host({ id: 'nobody' }),
      state: state([account({ id: 'codex', provider: 'openai', label: 'Bea' })]),
      request: { prompt: 'Review src/a.ts and src/b.ts across the tree', callId: 'none' },
      runClerk: async () => { throw new Error('no clerk should start'); },
    });
    expect(result).toBeNull();
  });

  it('stays off until this conversation turns swarm on, and a saved preset list still counts as on', async () => {
    expect(swarmIsOn({})).toBe(false);
    expect(swarmIsOn({ swarm: [] })).toBe(false);
    expect(swarmIsOn({ swarm: true })).toBe(true);
    expect(swarmIsOn({ swarm: ['lean'] })).toBe(true);
    const dir = await mkdtemp(join(tmpdir(), 'clikcode-swarm-'));
    process.env.CLIKCODE_HOME = dir;
    const cursor = account({ id: 'cursor', provider: 'cursor', label: 'Ada', usage: windows(38) });
    const off = await runSwarmDelegation({
      host: host({ id: 'off', swarm: undefined }),
      state: state([cursor]),
      request: { prompt: 'Review src/a.ts and src/b.ts across the tree', callId: 'off' },
      runClerk: async () => { throw new Error('swarm is off'); },
    });
    expect(off).toBeNull();
    const on = await runSwarmDelegation({
      host: host({ id: 'on', swarm: true }),
      state: state([cursor]),
      request: { prompt: 'Review src/a.ts and src/b.ts across the tree', description: 'review the pair', callId: 'on' },
      runClerk: async () => '{"summary":"done","facts":[],"paths":["src/a.ts"],"questions":[]}',
    });
    expect(on?.swarm?.displayName).toBe('Cursor Agent');
  });

  it('keeps a clerk that is still working when the host starts another turn', () => {
    const board = emptyBoard('ship it');
    board.roster = [
      { id: 'a', provider: 'Cursor', role: 'review', paths: '', step: 'reading', key: 'k', status: 'working' },
      { id: 'b', provider: 'Codex', role: 'explore', paths: '', step: 'done', key: 'j', status: 'done' },
    ];
    expect(beginTurn(board).roster.map((line) => line.id)).toEqual(['a']);
  });
});

describe('progress on the open tool call', () => {
  it('sends a clerk step and keeps the card for the tool result', () => {
    expect(swarmProgressLabel({ kind: 'tool-start', label: 'Read src/swarm/run.ts' })).toBe('Read src/swarm/run.ts');
    expect(swarmProgressLabel({ kind: 'tool-done', label: 'Antigravity CLI · review · the handoff' })).toBeUndefined();
    expect(swarmProgressLabel({ kind: 'tool-start', label: '   ' })).toBeUndefined();
  });
});

describe('one row on a vendor host', () => {
  const clerk = (id: string, kind: HarnessActivityEvent['kind'], label: string, parentId?: string): HarnessActivityEvent => ({
    kind, id, label, agent: !parentId, swarm: { provider: 'agy', displayName: 'Antigravity CLI', role: 'review', usageLeft: 100 },
    ...(parentId ? { parentId } : {}),
  });

  it('adopts the host tool id when that row is already on screen', () => {
    expect(isSwarmToolLabel('clikcode-swarm › swarm prompt=Review…')).toBe(true);
    expect(isSwarmToolLabel('swarm')).toBe(true);
    expect(isSwarmToolLabel('Swarm cap')).toBe(false);
    let fold = emptySwarmFold();
    const start = foldSwarmActivity(fold, { kind: 'tool-start', id: 'host-1', label: 'clikcode-swarm › swarm prompt=Review…' });
    fold = start.fold;
    expect(start.event?.id).toBe('host-1');
    const row = foldSwarmActivity(fold, clerk('swarm-a', 'tool-start', 'Antigravity CLI · review · the handoff'));
    fold = row.fold;
    expect(row.event?.id).toBe('host-1');
    const step = foldSwarmActivity(fold, clerk('swarm-a/1', 'tool-start', 'Read src/swarm/run.ts', 'swarm-a'));
    fold = step.fold;
    expect(step.event?.parentId).toBe('host-1');
    const done = foldSwarmActivity(fold, clerk('swarm-a', 'tool-done', 'Antigravity CLI · review · the handoff'));
    fold = done.fold;
    expect(done.event?.id).toBe('host-1');
    const nativeDone = foldSwarmActivity(fold, { kind: 'tool-done', id: 'host-1', label: 'clikcode-swarm › swarm prompt=Review…' });
    expect(nativeDone.event).toBeUndefined();
  });

  it('drops the host tool when the clerk row is already on screen', () => {
    let fold = emptySwarmFold();
    const row = foldSwarmActivity(fold, clerk('swarm-a', 'tool-start', 'Antigravity CLI · review · the handoff'));
    fold = row.fold;
    expect(row.event?.id).toBe('swarm-a');
    const hidden = foldSwarmActivity(fold, { kind: 'tool-start', id: 'host-1', label: 'swarm' });
    fold = hidden.fold;
    expect(hidden.event).toBeUndefined();
    const hiddenDone = foldSwarmActivity(fold, { kind: 'tool-done', id: 'host-1', label: 'swarm' });
    expect(hiddenDone.event).toBeUndefined();
  });
});

describe('the board and the status line', () => {

  it('attaches the same role, paths, and goal, and cuts a card to the cap', () => {
    const key = goalKey('review', ['src/b.ts', 'src/a.ts'], 'Review   src/a.ts');
    expect(key).toBe(goalKey('review', ['src/a.ts', 'src/b.ts'], 'review src/a.ts'));
    const card = cardFromReply('note {"summary":"ok","facts":["src/a.ts: one"],"paths":["src/a.ts"]}', 300);
    expect(card.summary).toBe('ok');
    expect(card.facts).toEqual(['src/a.ts: one']);
  });

  it('drops facts until the slice fits', () => {
    const board = emptyBoard('ship it');
    board.facts = Array.from({ length: 12 }, (_, index) => ({ path: `src/${index}.ts`, text: 'x'.repeat(80) }));
    const slice = boardSlice(board, [], 40);
    expect(Math.ceil(slice.length / 4)).toBeLessThanOrEqual(40);
    expect(slice).toContain('Goal: ship it');
  });

  it('names each provider and how much usage it had left', () => {
    const swarm = { provider: 'cursor', displayName: 'Cursor', role: 'explore' as const, usageLeft: 62 };
    let phase = activityLifecyclePhase(new Map(), { kind: 'tool-start', id: 'a', label: 'Cursor · explore', agent: true, swarm });
    phase = activityLifecyclePhase(phase.activeTools, {
      kind: 'tool-start', id: 'b', label: 'Codex · review', agent: true,
      swarm: { provider: 'codex', displayName: 'Codex', role: 'review', usageLeft: 18.4 },
    });
    expect(phase.phase).toBe('waiting on Cursor (62% left), Codex (18% left)');
  });

  it('hides a clerk from the conversation list and counts providers in the row', () => {
    const chat = host({ id: 'shown', messages: [{ role: 'user', content: 'hi' }] });
    const clerk = host({ id: 'hidden', clerkOf: 'shown', messages: [{ role: 'user', content: 'task' }] });
    const listed = sessionPickerOptions([chat, clerk], 'other', () => 'Claude').map((option) => option.value);
    expect(listed).toContain('shown');
    expect(listed).not.toContain('hidden');
    const pending = {
      prompt: 'go', startedAt: ISO, updatedAt: ISO, outputStarted: true,
      subagents: [
        { id: 'a', label: 'Cursor', startedAt: ISO, provider: 'cursor' },
        { id: 'b', label: 'Codex', startedAt: ISO, provider: 'codex' },
      ],
    };
    expect(workingDetail(pending, NOW).replace(/\u001b\[[0-9;]*m/g, '')).toContain('2 providers ←');
  });
});
