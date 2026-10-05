/** Switching the conversation a session is attached to, including the
 * handover a change of provider forces. */

import type { HarnessPrompter } from '../../harness/prompter.js';
import { randomUUID } from 'node:crypto';
import type { HarnessSession, HarnessState } from '../../session/model.js';
import { localHarnessForCommand } from '../../runtime/lazy-bridge.js';
import { readState } from '../../session/state/read.js';
import { resolveDefaultSettings } from '../../session/state/settings.js';
import { writeState } from '../../session/state/write.js';
import { carriedHandoffModel, carriedHandoffSettings, synchronizeNativeTranscript } from '../../turn/handoff.js';
import { effortChoicesFor } from '../../harness/accounts/effort-choices.js';
import { harnessSupportsEffort } from '../../runtime/lazy-bridge.js';
import { consumeSessionTurn } from '../../turn/checkpoint.js';
import { leaveProvider } from '../../session/native-thread.js';
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
  const state = await readState({ transcripts: [id] });
  const session = state.sessions.find((item) => item.id === id);
  if (session && consumeSessionTurn(session, queuedTurnId)) await writeState(state);
}

/** Takes the messages typed behind a turn out of the queue, oldest first:
 * the conversation's provider has no usage left and the user chose not to
 * move it, so each would only fail the same way and ask again. They go back
 * to the composer instead. Commands and notifications stay queued. */
export async function takeQueuedMessages(id: string): Promise<string[]> {
  const state = await readState({ transcripts: [id] });
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
  // The new chat copies the current one's settings, never its history.
  const state = await readState({ transcripts: [] });
  const current = state.sessions.find((item) => item.id === currentId);
  if (!current) throw new Error(`AI session "${currentId}" was not found`);
  const created = newConversationSession(state, current);
  if (options.sameModel && current.model) created.model = current.model;
  state.sessions.push(created);
  await writeState(state);
  return created.id;
}

/** A conversation's worker running a turn keeps the provider it started on;
 * moving the conversation under it would answer on one provider into a
 * record that says another. */
export async function refuseWhileTurnRuns(id: string): Promise<void> {
  const { workerTurn } = await import('../../worker/turn-bridge.js');
  if (await workerTurn(id).catch(() => undefined)) {
    throw new Error('A turn is still running in this conversation -- switch when it ends, or stop it first.');
  }
}

/** Moves the conversation onto another harness, in place: same session, same
 * history, the effort, permission mode and model it can carry
 * (carriedHandoffSettings, carriedHandoffModel). Then selected the way any
 * harness is (aiHarnessSelect: install, sign-in, a real model). */
export async function moveToProvider(
  id: string,
  harnessCommandName: string,
  selection: { accountId?: string | null; model?: string | null; prompter?: HarnessPrompter } = {},
): Promise<void> {
  const harness = localHarnessForCommand(harnessCommandName);
  if (!harness) throw new Error(`unknown local harness: ${harnessCommandName}`);
  const state = await readState({ transcripts: [id] });
  const current = state.sessions.find((item) => item.id === id);
  if (!current) throw new Error(`AI session "${id}" was not found`);
  if (current.route === 'local' && current.nativeHarness === harness.command) return;
  await refuseWhileTurnRuns(id);
  // What was said in the vendor's own CLI is the leaving provider's too.
  await synchronizeNativeTranscript(state, current);
  const accountId = selection.accountId ?? preferredAccountId(state, harness.provider);
  const account = accountId ? state.accounts.find((item) => item.id === accountId) : undefined;
  // Effort and permission mode are the conversation's, not the provider's.
  const efforts = harnessSupportsEffort(harness)
    ? (await effortChoicesFor(harness, account, current.model).catch(() => undefined))?.values
    : undefined;
  const defaults = carriedHandoffSettings(current, harness, resolveDefaultSettings(state, harness.provider), efforts);
  const lastUsedModel = [...state.sessions]
    .filter((session) => session.nativeHarness === harness.command && session.model)
    .sort((left, right) => Date.parse(right.updatedAt ?? '') - Date.parse(left.updatedAt ?? ''))[0]?.model;
  const model = selection.model ?? carriedHandoffModel(current, account?.models ?? [],
    lastUsedModel ?? state.providerSettings[harness.provider]?.model ?? null);
  leaveProvider(current);
  Object.assign(current, {
    route: 'local', provider: harness.provider, nativeHarness: harness.command, accountId, model,
    effort: defaults.effort, permissionMode: defaults.permissionMode, accountFailover: defaults.accountFailover,
  });
  await writeState(state);
  await aiHarnessSelect(harnessCommandName, id, selection.prompter ? { prompter: selection.prompter } : {});
}
