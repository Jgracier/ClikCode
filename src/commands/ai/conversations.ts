/** Switching the conversation a session is attached to, including the
 * handover a change of provider forces. */

import { randomUUID } from 'node:crypto';
import type { HarnessSession, HarnessState } from '../../session/model.js';
import { sessionProviderLabel } from '../../harness/protocol/labels.js';
import { localHarnessForCommand } from '../../runtime/lazy-bridge.js';
import { readState } from '../../session/state/read.js';
import { resolveDefaultSettings } from '../../session/state/settings.js';
import { writeState } from '../../session/state/write.js';
import { createHandoffBranch, synchronizeNativeTranscript } from '../../turn/runtime.js';
import { consumeSessionTurn } from '../../turn/checkpoint.js';
import { aiHarnessSelect } from './harness.js';
import { preferredAccountId } from './sessions.js';

export function newConversationSession(
  state: HarnessState, source: HarnessSession, now = new Date().toISOString(),
): HarnessSession {
  const id = randomUUID();
  const defaults = resolveDefaultSettings(state, source.provider);
  return {
    id, conversationId: id, route: source.route,
    accountId: source.route === 'gateway' ? null : source.accountId ?? null,
    provider: source.provider, model: source.model ?? null,
    effort: source.effort ?? defaults.effort,
    ...(source.route === 'gateway' ? {} : { permissionMode: source.permissionMode ?? defaults.permissionMode }),
    accountFailover: source.accountFailover ?? defaults.accountFailover,
    workspace: source.workspace ?? process.cwd(),
    ...(source.nativeHarness ? { nativeHarness: source.nativeHarness } : {}),
    createdAt: now, updatedAt: now, status: 'active',
  };
}

/** Drop a queued turn that could not start, so a permanent failure cannot
 * replay forever at the head of the queue. */
export async function releaseQueuedTurn(id: string, queuedTurnId: string): Promise<void> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (session && consumeSessionTurn(session, queuedTurnId)) await writeState(state);
}

/** Starting a clean conversation leaves the previous one intact and resumable;
 * the caller switches to the returned id. */
export async function newConversation(currentId: string): Promise<string> {
  const state = await readState();
  const current = state.sessions.find((item) => item.id === currentId);
  if (!current) throw new Error(`AI session "${currentId}" was not found`);
  const created = newConversationSession(state, current);
  state.sessions.push(created);
  await writeState(state);
  return created.id;
}

export async function newProviderConversation(currentId: string, harnessCommandName: string): Promise<string> {
  const state = await readState();
  const current = state.sessions.find((item) => item.id === currentId);
  if (!current) throw new Error(`AI session "${currentId}" was not found`);
  const harness = localHarnessForCommand(harnessCommandName);
  if (!harness) throw new Error(`unknown local harness: ${harnessCommandName}`);
  if (current.route === 'local' && current.nativeHarness === harness.command) return current.id;
  // Refresh the source before freezing its portable ClikCode history into a
  // child branch. The source native session remains untouched after this.
  if (await synchronizeNativeTranscript(state, current)) await writeState(state);
  const defaults = resolveDefaultSettings(state, harness.provider);
  const now = new Date().toISOString();
  const sourceDisplayName = current.nativeHarness
    ? localHarnessForCommand(current.nativeHarness)?.displayName
    : sessionProviderLabel(current);
  const session = createHandoffBranch({
    source: current, target: harness, accountId: preferredAccountId(state, harness.provider),
    model: state.providerSettings[harness.provider]?.model ?? null, defaults, now, sourceDisplayName,
  });
  state.sessions.push(session);
  await writeState(state);
  await aiHarnessSelect(harnessCommandName, session.id);
  return session.id;
}
