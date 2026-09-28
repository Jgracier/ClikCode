/** Resolve a conversation and dispatch its turn by execution protocol. */
import { readState } from '../session/state/read.js';
import { isClikCodeAgent } from '../session/route.js';
import { hermesTurboFitModelId } from '../harness/accounts/hermes-discovery.js';
import { prepareAttachments } from '../session/attachments.js';
import { shellContextBlock } from '../commands/ai/shell-run.js';
import { isDirectModelProvider } from '../runtime/lazy-bridge.js';
import type { TurnRunOptions } from './turn-options.js';
import { sendDirectApiTurn } from './direct-turn.js';
import { sendVendorTurn } from './vendor-turn.js';

export async function aiSessionSend(
  id: string, prompt: string, signal?: AbortSignal, run: TurnRunOptions = {},
): Promise<void> {
  const state = await readState();
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  if (isClikCodeAgent(session)) throw new Error('use aiGatewaySessionSend for gateway and ClikCode Local sessions');
  if (!session.accountId) throw new Error('local AI session has no account selected');
  let account = state.accounts.find((item) => item.id === session.accountId);
  if (!account) throw new Error('local AI session account was removed');
  let model: string | null = session.model ?? account.models[0] ?? null;
  // A model this account lists, spelled as it was listed: TurboFit ids saved
  // before they were corrected to `custom:turbofit:` still count, or a session
  // corrected on its first turn would be refused on its second.
  const listed = (candidate: string): boolean => account!.models.includes(candidate)
    || account!.models.some((item) => hermesTurboFitModelId(item) === candidate);
  if (model && account.models.length > 0 && !listed(model)) {
    throw new Error(`model "${model}" is not available through local account "${account.label}"`);
  }
  const text = prompt.trim();
  if (!text) throw new Error('prompt is required');
  const prepared = await prepareAttachments(session.attachments ?? []);
  let turnText = `${text}${prepared.textContext}`;
  // A resumed native-harness thread never replays ClikCode's own transcript
  // (see failoverPrompt and the attachment envelope: the vendor process keeps
  // its own session and ClikCode's `messages` are not passed back in). So `!`
  // output has to ride in like an attachment -- injected here and cleared
  // beside session.attachments, so a resumed vendor still learns what the
  // shell printed. Fresh native threads and the direct/gateway routes replay
  // session.messages and already carry the note; gating on resumed-only keeps
  // it from being delivered twice to them.
  if (session.nativeSessionId && !session.nativeSessionPreallocated) {
    turnText += shellContextBlock(session.shellNotes ?? []);
  }
  const startedAt = Date.now();

  const input = { state, session, account, model, text, prepared, turnText, startedAt, signal, run };
  if (account.authKind === 'vendor-cli' || !isDirectModelProvider(account.provider)) return sendVendorTurn(input);
  return sendDirectApiTurn(input);
}
