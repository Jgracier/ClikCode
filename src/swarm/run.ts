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
import { SWARM_POLICY, swarmIsOn, type SwarmPolicy } from './policy.js';
import { appendSwarmActivity } from './spool.js';
import { readBoard, writeBoard } from './store.js';
import { clerkUsage } from './usage.js';
import type { ToolRunResult } from '../agent/tool-contract.js';

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

export interface ClerkCandidate {
  account: AiHarnessAccount;
  command: string;
  displayName: string;
  leftPct: number;
}

/** Every other account the host may use. A headless turn (its CLI, or ACP)
 * and a usage amount with room left are the whole test. The one with the
 * most left is first. The host's own account is the only one left out. */
export function clerkAccounts(state: HarnessState, host: HarnessSession, now = Date.now()): ClerkCandidate[] {
  const ranked = state.accounts.flatMap((account) => {
    if (account.id === host.accountId) return [];
    const usage = clerkUsage(account, state, now);
    if (!usage) return [];
    const harness = localHarnessForProvider(account.provider) ?? localHarnessForCommand(account.provider);
    if (!harness || !harnessCanRunTurns(harness)) return [];
    return [{ account, command: harness.command, displayName: harness.displayName, leftPct: usage.leftPct }];
  });
  ranked.sort((left, right) => right.leftPct - left.leftPct || left.displayName.localeCompare(right.displayName) || left.account.label.localeCompare(right.account.label));
  return ranked;
}

/** The account with the most usage left that is not already working. When
 * every eligible account is busy, the one with the most left is used again. */
export function pickClerkAccount(
  state: HarnessState, host: HarnessSession, now = Date.now(), busy: ReadonlySet<string> = new Set(),
): ClerkCandidate | undefined {
  const ranked = clerkAccounts(state, host, now);
  return ranked.find((row) => !busy.has(row.account.id)) ?? ranked[0];
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

/** What the host is told the moment a clerk starts. The card comes later,
 * as a message, so this turn can keep going. */
function handoffAck(picked: ClerkCandidate, role: SwarmRole, description: string): ToolRunResult {
  const left = Math.round(picked.leftPct);
  return {
    output: `Handed to ${picked.displayName} · ${role} (${left}% left). "${description}" is running in this chat. Continue with other work; do not wait or poll. The card arrives as a message when it finishes.`,
    activityLabel: providerLabel(picked.displayName, role, description),
  };
}

type StartedHandoff =
  | { mode: 'immediate'; result: ToolRunResult | null }
  | { mode: 'running'; ack: ToolRunResult; finished: Promise<ToolRunResult> };

/** Reserve a clerk and start it. `running` means the clerk is in flight and
 * the host already has the acknowledgement. */
async function startHandoff(input: SwarmDelegation): Promise<StartedHandoff> {
  if (!swarmIsOn(input.host)) return { mode: 'immediate', result: null };
  const policy = SWARM_POLICY;
  const text = [input.request.description, input.request.prompt].filter(Boolean).join('\n');
  if (keepOnHost(text)) return { mode: 'immediate', result: null };
  const role = swarmRole(text);
  const paths = pathsIn(input.request.prompt);
  const key = goalKey(role, paths, input.request.prompt);
  const description = (input.request.description?.trim() || input.request.prompt.replace(/\s+/g, ' ').trim()).slice(0, 80);
  const opened = await lock(input.host.id, async () => {
    const board = await readBoard(input.host.id);
    const busy = new Set(board.roster.flatMap((line) => (line.status === 'working' && line.accountId ? [line.accountId] : [])));
    const picked = pickClerkAccount(input.state, input.host, Date.now(), busy);
    if (!picked) return undefined;
    const reserved = await reserve(input.host.id, policy, picked.displayName, role, paths, key, input.request.prompt, description, picked.account.id);
    return { picked, reserved };
  });
  if (!opened) return { mode: 'immediate', result: null };
  const { picked, reserved } = opened;
  if (reserved.kind === 'attach') return { mode: 'immediate', result: cardResult(reserved.card, `Attached · ${picked.displayName}`, picked, role) };
  if (reserved.kind === 'capped') {
    return { mode: 'immediate', result: { output: 'The swarm is already at its parallel cap. Do this with your own tools.', activityLabel: 'Swarm cap' } };
  }
  const label = providerLabel(picked.displayName, role, description);
  const swarm = { provider: picked.command, displayName: picked.displayName, role, usageLeft: Math.round(picked.leftPct) };
  await emit(input.host.id, { kind: 'tool-start', id: input.request.callId, label, agent: true, swarm }, input.onActivity);
  const steps: string[] = [];
  const finished = (async (): Promise<ToolRunResult> => {
    try {
      const harness = localHarnessForCommand(picked.command) ?? localHarnessForProvider(picked.account.provider);
      if (!harness) throw new Error(`${picked.displayName} is not available`);
      const reply = await (input.runClerk ?? runProviderPrompt)({
        harness, account: picked.account, prompt: reserved.brief,
        state: input.state, sessionId: input.host.id,
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
        kind: 'tool-done', id: input.request.callId, label: done, agent: true, swarm, output: formatCard(card).split('\n'),
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
  })();
  return { mode: 'running', ack: handoffAck(picked, role, description), finished };
}

/** `null` means the host's own sub-agent should do this. A result means a
 * clerk did it, or the swarm refused another worker and said so. Waits for
 * the card. The host tool uses `beginSwarmHandoff` so the turn can continue. */
export async function runSwarmDelegation(input: SwarmDelegation): Promise<ToolRunResult | null> {
  const started = await startHandoff(input);
  if (started.mode === 'immediate') return started.result;
  return started.finished;
}

/** Start a clerk and return as soon as the host chat is showing it. The
 * card is written to the activity spool when the clerk finishes. The host's
 * turn signal is not passed on: ending the turn must not cancel the handoff. */
export async function beginSwarmHandoff(input: SwarmDelegation): Promise<ToolRunResult | null> {
  const request = { ...input.request };
  delete request.signal;
  const started = await startHandoff({ ...input, request });
  if (started.mode === 'immediate') return started.result;
  void started.finished.catch(() => undefined);
  return started.ack;
}

type Reservation =
  | { kind: 'attach'; card: SwarmCard }
  | { kind: 'capped' }
  | { kind: 'run'; workerId: string; brief: string };

async function reserve(
  sessionId: string, policy: SwarmPolicy, displayName: string, role: SwarmRole, paths: string[], key: string, task: string, description: string, accountId: string,
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
    roster: [...board.roster, { id: workerId, provider: displayName, role, paths: paths.join(', '), step: 'starting', key, status: 'working', accountId }],
  };
  await writeBoard(sessionId, next);
  inflight.set(sessionId, running + 1);
  const slice = boardSlice(next, paths, Math.min(policy.maxBoardTokens, 400));
  let brief = clerkBrief({ role, task, slice });
  if (estimateTokens(brief) > policy.maxBriefTokens) brief = brief.slice(0, policy.maxBriefTokens * 4);
  return { kind: 'run', workerId, brief };
}
