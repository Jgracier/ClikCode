/** One `task` call, routed. The host model receives a card. The chat receives
 * a provider row. A clerk is not a conversation. */

import { randomUUID } from 'node:crypto';
import type { AiHarnessAccount, AiHarnessPermissionMode } from '../harness/definition.js';
import type { HarnessActivityEvent } from '../harness/prompter.js';
import type { HarnessSession, HarnessState } from '../session/model.js';
import { harnessCanRunTurns, localHarnessForCommand, localHarnessForProvider } from '../runtime/lazy-bridge.js';
import {
  applyCard, boardSlice, cardFromReply, clerkBrief, estimateTokens, formatCard, goalKey, keepOnHost, pathsIn, swarmRole,
  type SwarmBoard, type SwarmCard, type SwarmRole,
} from './board.js';
import { runProviderPrompt } from './clerk.js';
import { resolveSwarm, type SwarmPolicy } from './policy.js';
import { appendSwarmActivity } from './spool.js';
import { readBoard, writeBoard } from './store.js';
import { clerkUsage } from './usage.js';
import type { ToolRunResult } from '../agent/tool-contract.js';

const PREFER = ['cursor', 'codex', 'opencode', 'grok', 'gemini', 'kiro', 'cline', 'goose'];

/** Serializes board updates for one host. Clerk runs happen outside the lock. */
const tails = new Map<string, Promise<unknown>>();

function lock<T>(sessionId: string, job: () => Promise<T>): Promise<T> {
  const previous = tails.get(sessionId) ?? Promise.resolve();
  const run = previous.then(job, job);
  tails.set(sessionId, run.then(() => undefined, () => undefined));
  return run;
}

const inflight = new Map<string, number>();

export interface SwarmDelegation {
  host: HarnessSession;
  state: HarnessState;
  request: { prompt: string; description?: string; callId: string; signal?: AbortSignal };
  onActivity?: (event: HarnessActivityEvent) => void;
  /** Tests replace the vendor process. */
  runClerk?: typeof runProviderPrompt;
}

function hostCommand(session: HarnessSession): string | undefined {
  return session.nativeHarness ?? session.provider ?? undefined;
}

export interface ClerkCandidate {
  account: AiHarnessAccount;
  command: string;
  displayName: string;
  leftPct: number;
}

/** Other providers the host may use. Each one has published a usage amount
 * and still has some of it left. The one with the most left is first. */
export function clerkAccounts(state: HarnessState, host: HarnessSession, now = Date.now()): ClerkCandidate[] {
  const own = hostCommand(host);
  const ranked = state.accounts.flatMap((account) => {
    if (account.id === host.accountId) return [];
    const usage = clerkUsage(account, now);
    if (!usage) return [];
    const harness = localHarnessForProvider(account.provider) ?? localHarnessForCommand(account.provider);
    if (!harness || !harnessCanRunTurns(harness) || !harness.turn) return [];
    if (harness.command === own || harness.provider === own || account.provider === own) return [];
    return [{ account, command: harness.command, displayName: harness.displayName, leftPct: usage.leftPct }];
  });
  ranked.sort((left, right) => {
    if (right.leftPct !== left.leftPct) return right.leftPct - left.leftPct;
    const rank = (command: string): number => {
      const index = PREFER.indexOf(command);
      return index < 0 ? PREFER.length : index;
    };
    return rank(left.command) - rank(right.command) || left.displayName.localeCompare(right.displayName);
  });
  return ranked;
}

/** The provider with the most reported usage left, or none when nobody has published an amount. */
export function pickClerkAccount(state: HarnessState, host: HarnessSession, now = Date.now()): ClerkCandidate | undefined {
  return clerkAccounts(state, host, now)[0];
}

function providerLabel(displayName: string, role: SwarmRole, description: string): string {
  return `${displayName} · ${role} · ${description}`;
}

async function emit(hostId: string, event: HarnessActivityEvent, onActivity?: (event: HarnessActivityEvent) => void): Promise<void> {
  onActivity?.(event);
  await appendSwarmActivity(hostId, event).catch(() => undefined);
}

function cardResult(card: SwarmCard, label: string, picked: ClerkCandidate, role: SwarmRole): ToolRunResult {
  return {
    output: formatCard(card),
    activityLabel: label,
    swarm: { provider: picked.command, displayName: picked.displayName, role, usageLeft: Math.round(picked.leftPct) },
  };
}

/** `null` means the host's own sub-agent should do this. A result means a
 * clerk did it, or the swarm refused another worker and said so. */
export async function runSwarmDelegation(input: SwarmDelegation): Promise<ToolRunResult | null> {
  const names = input.host.swarm ?? [];
  const { policy } = resolveSwarm(names);
  if (!policy) return null;
  const text = [input.request.description, input.request.prompt].filter(Boolean).join('\n');
  if (keepOnHost(text)) return null;
  const picked = pickClerkAccount(input.state, input.host);
  if (!picked) return null;
  const role = swarmRole(text);
  const paths = pathsIn(input.request.prompt);
  const key = goalKey(role, paths, input.request.prompt);
  const description = (input.request.description?.trim() || input.request.prompt.replace(/\s+/g, ' ').trim()).slice(0, 80);
  const reserved = await lock(input.host.id, async () => reserve(input.host.id, policy, picked.displayName, role, paths, key, input.request.prompt, description));
  if (reserved.kind === 'attach') return cardResult(reserved.card, `Attached · ${picked.displayName}`, picked, role);
  if (reserved.kind === 'capped') {
    return { output: 'The swarm is already at its parallel cap. Do this with your own tools.', activityLabel: 'Swarm cap' };
  }
  const label = providerLabel(picked.displayName, role, description);
  const swarm = { provider: picked.command, displayName: picked.displayName, role, usageLeft: Math.round(picked.leftPct) };
  await emit(input.host.id, { kind: 'tool-start', id: input.request.callId, label, agent: true, swarm }, input.onActivity);
  const steps: string[] = [];
  try {
    const harness = localHarnessForCommand(picked.command) ?? localHarnessForProvider(picked.account.provider);
    if (!harness) throw new Error(`${picked.displayName} is not available`);
    const reply = await (input.runClerk ?? runProviderPrompt)({
      harness, account: picked.account, prompt: reserved.brief,
      ...(input.host.workspace ? { workspace: input.host.workspace } : {}),
      ...(input.host.permissionMode ? { permissionMode: input.host.permissionMode as AiHarnessPermissionMode } : {}),
      ...(input.request.signal ? { signal: input.request.signal } : {}),
      onStep: (step) => {
        steps.push(step);
        void emit(input.host.id, {
          kind: 'tool-start', id: `${input.request.callId}/${steps.length}`, parentId: input.request.callId, label: step, swarm,
        }, input.onActivity);
      },
    });
    const card = cardFromReply(reply, policy.maxCardTokens);
    await lock(input.host.id, async () => {
      const board = applyCard(await readBoard(input.host.id), reserved.workerId, card);
      await writeBoard(input.host.id, board);
      input.host.swarmBoard = board;
    });
    const done = `${picked.displayName} · ${role} · ${card.summary}`;
    await emit(input.host.id, {
      kind: 'tool-done', id: input.request.callId, label: done, agent: true, swarm, output: steps.slice(-8),
    }, input.onActivity);
    return cardResult(card, done, picked, role);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await lock(input.host.id, async () => {
      const board = await readBoard(input.host.id);
      board.roster = board.roster.map((line) => (line.id === reserved.workerId ? { ...line, status: 'done', step: message } : line));
      await writeBoard(input.host.id, board);
    });
    await emit(input.host.id, {
      kind: 'tool-error', id: input.request.callId, label, agent: true, swarm, output: [message],
    }, input.onActivity);
    return { output: `${picked.displayName} failed: ${message}`, isError: true, activityLabel: label, swarm };
  } finally {
    await lock(input.host.id, async () => { inflight.set(input.host.id, Math.max(0, (inflight.get(input.host.id) ?? 1) - 1)); });
  }
}

type Reservation =
  | { kind: 'attach'; card: SwarmCard }
  | { kind: 'capped' }
  | { kind: 'run'; workerId: string; brief: string };

async function reserve(
  sessionId: string, policy: SwarmPolicy, displayName: string, role: SwarmRole, paths: string[], key: string, task: string, description: string,
): Promise<Reservation> {
  const board = await readBoard(sessionId);
  const existing = board.roster.find((line) => line.key === key && line.status === 'working');
  if (existing) return { kind: 'attach', card: { summary: `${existing.provider} is already on this. ${existing.step}`, facts: [], paths, blockers: [], questions: [] } };
  const running = inflight.get(sessionId) ?? 0;
  if (running >= policy.maxParallel || board.roster.filter((line) => line.status === 'working').length >= policy.maxWorkers) return { kind: 'capped' };
  const workerId = randomUUID();
  const next: SwarmBoard = {
    ...board,
    goal: board.goal || description,
    roster: [...board.roster, { id: workerId, provider: displayName, role, paths: paths.join(', '), step: 'starting', key, status: 'working' }],
  };
  await writeBoard(sessionId, next);
  inflight.set(sessionId, running + 1);
  const slice = boardSlice(next, paths, Math.min(policy.maxBoardTokens, 400));
  let brief = clerkBrief({ role, task, slice });
  if (estimateTokens(brief) > policy.maxBriefTokens) brief = brief.slice(0, policy.maxBriefTokens * 4);
  return { kind: 'run', workerId, brief };
}
