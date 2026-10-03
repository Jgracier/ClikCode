/** Switching the conversation a session is attached to, including the
 * handover a change of provider forces. */

import { randomUUID } from 'node:crypto';
import type { HarnessSession, HarnessState } from '../../session/model.js';
import { sessionProviderLabel } from '../../harness/protocol/labels.js';
import { localHarnessForCommand } from '../../runtime/lazy-bridge.js';
import { readState } from '../../session/state/read.js';
import { resolveDefaultSettings } from '../../session/state/settings.js';
import { writeState } from '../../session/state/write.js';
import { createHandoffBranch, synchronizeNativeTranscript } from '../../turn/handoff.js';
import { consumeSessionTurn } from '../../turn/checkpoint.js';
import { aiHarnessSelect } from './harness.js';
import { preferredAccountId } from './preferred-account.js';
import { isClikCodeAgent, isGatewayService } from '../../session/route.js';

/** A fresh conversation on exactly the setup of the one it came from: same
 * provider, same harness, same model, same effort, permissions and vendor
 * options. /new means "clear the conversation", not "start configuring".
 *
 * `nativeHarness` used to be left out, so an empty session would not look
 * deliberately configured to the old empty-session prune. That prune judges
 * content now (session/blank.ts), and leaving the harness out had a real cost:
 * every command that needs a harness saw "no provider chosen" on the new chat
 * -- which offers the provider picker and, once one is selected,
 * aiHarnessSelect resets the model. /new changed the model.
 */
export function newConversationSession(
  state: HarnessState, source: HarnessSession, now = new Date().toISOString(),
): HarnessSession {
  const id = randomUUID();
  const defaults = resolveDefaultSettings(state, source.provider);
  return {
    id, conversationId: id, route: source.route,
    accountId: isClikCodeAgent(source) ? null : source.accountId ?? null,
    provider: source.provider,
    model: source.provider
      ? state.providerSettings[source.provider]?.model ?? (source.nativeHarness ? localHarnessForCommand(source.nativeHarness)?.defaultModel ?? null : null)
      : null,
    ...(!isClikCodeAgent(source) && source.nativeHarness ? { nativeHarness: source.nativeHarness } : {}),
    ...(source.harnessOptions ? { harnessOptions: { ...source.harnessOptions } } : {}),
    effort: source.effort ?? defaults.effort,
    // A Gateway /new has always started without a stored mode (read as `ask`).
    // ClikCode Local carries it: its agent honours the mode, and a fresh chat
    // silently dropping `auto` back to `ask` would read as a new policy.
    ...(isGatewayService(source) ? {} : { permissionMode: source.permissionMode ?? defaults.permissionMode }),
    accountFailover: source.accountFailover ?? defaults.accountFailover,
    workspace: source.workspace ?? process.cwd(),
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

/** The messages and commands queued behind a turn follow the conversation
 * when "Resume in" moves it to another provider: left in the source, they
 * would run there later (on the provider that ran out) or never, while the
 * conversation carried on without them. Notifications stay: they report the
 * source's own background work. */
export async function moveQueuedTurns(fromId: string, toId: string): Promise<void> {
  if (fromId === toId) return;
  const state = await readState();
  const from = state.sessions.find((item) => item.id === fromId);
  const to = state.sessions.find((item) => item.id === toId);
  const moving = (from?.queuedTurns ?? []).filter((item) => item.kind !== 'notification');
  if (!from || !to || !moving.length) return;
  for (const item of moving) consumeSessionTurn(from, item.id);
  to.queuedTurns = [...(to.queuedTurns ?? []), ...moving];
  from.updatedAt = to.updatedAt = new Date().toISOString();
  await writeState(state);
}

/** Takes the messages typed behind a turn out of the queue, oldest first:
 * the conversation's provider has no usage left and the user chose not to
 * move it, so each would only fail the same way and ask again. They go back
 * to the composer instead. Commands and notifications stay queued. */
export async function takeQueuedMessages(id: string): Promise<string[]> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  const taken = (session?.queuedTurns ?? []).filter((item) => !item.kind);
  if (!session || !taken.length) return [];
  for (const item of taken) consumeSessionTurn(session, item.id);
  session.updatedAt = new Date().toISOString();
  await writeState(state);
  return taken.map((item) => item.text);
}

/** Starting a clean conversation leaves the previous one intact and resumable;
 * the caller switches to the returned id. */
export async function newConversation(
  currentId: string,
  /** Keep the model the current chat runs, rather than the provider's
   * default: the conversation board starts in exactly what it shows. */
  options: { sameModel?: boolean } = {},
): Promise<string> {
  const state = await readState();
  const current = state.sessions.find((item) => item.id === currentId);
  if (!current) throw new Error(`AI session "${currentId}" was not found`);
  const created = newConversationSession(state, current);
  if (options.sameModel && current.model) created.model = current.model;
  state.sessions.push(created);
  await writeState(state);
  return created.id;
}

export async function newProviderConversation(
  currentId: string,
  harnessCommandName: string,
  selection: { accountId?: string | null; model?: string | null; turn?: string } = {},
): Promise<string> {
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
  const lastUsedModel = [...state.sessions]
    .filter((session) => session.nativeHarness === harness.command && session.model)
    .sort((left, right) => Date.parse(right.updatedAt ?? '') - Date.parse(left.updatedAt ?? ''))[0]?.model;
  const now = new Date().toISOString();
  const sourceDisplayName = current.nativeHarness
    ? localHarnessForCommand(current.nativeHarness)?.displayName
    : sessionProviderLabel(current);
  const session = createHandoffBranch({
    source: current, target: harness,
    accountId: selection.accountId ?? preferredAccountId(state, harness.provider),
    model: selection.model ?? (current.nativeHarness === harness.command ? current.model : undefined)
      ?? lastUsedModel ?? state.providerSettings[harness.provider]?.model ?? null,
    defaults, now, sourceDisplayName, ...(selection.turn ? { turn: selection.turn } : {}),
  });
  state.sessions.push(session);
  await writeState(state);
  await aiHarnessSelect(harnessCommandName, session.id);
  return session.id;
}
