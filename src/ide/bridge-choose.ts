/** A choice made in the editor's own widgets, applied with the command the
 * terminal's picker ends in. A setting that can change mid-turn does so
 * (commandDuringTurn). A provider or account change is recorded the same way:
 * the call already started finishes, and the next model call moves. One module per kind family. */
import { catalogModel, resolveLocalModelId } from '../local-models/catalog.js';
import { GATEWAY_ID } from '../session/picker-rows.js';
import { aiSessionCommand } from '../tui/slash/handlers.js';
import { commandDuringTurn } from '../tui/slash/queue.js';
import type { IdeChoice } from './protocol.js';
import { messageOf } from './bridge-support.js';
import type { BridgeHost } from './bridge-host.js';
import { chooseConversation } from './bridge-choose-conversation.js';
import { chooseProvider } from './bridge-choose-provider.js';
import { chooseSetting } from './bridge-choose-settings.js';

/** What a family's handlers answer and queue with. */
export interface ChooseContext {
  host: BridgeHost;
  /** The request's success result. */
  done: (data?: unknown) => void;
  /** A setting line, applied now when a turn runs (or when it does not). */
  setting: (line: string) => Promise<void>;
  /** A job behind the work queue, answering the request when it ends. */
  queued: (job: () => Promise<unknown>) => void;
}

/** A model chosen in the Gateway's list while the chat runs one on this computer: both are the Gateway provider, so the chat
 * moves to the Gateway route with it. A model of this computer's own stays a model setting. */
export async function routedChoice(host: BridgeHost, choice: IdeChoice): Promise<IdeChoice> {
  if (choice.kind !== 'model') return choice;
  const { session } = await host.current();
  if (session.route !== 'clikcode-local') return choice;
  const local = (() => { try { return Boolean(catalogModel(resolveLocalModelId(choice.model))); } catch { return false; } })();
  return local ? choice : { kind: 'provider', provider: GATEWAY_ID, model: choice.model };
}

export async function choose(host: BridgeHost, requestId: string, choice: IdeChoice): Promise<void> {
  const done = (data?: unknown): void => host.channel.send({ type: 'result', requestId, ok: true, ...(data === undefined ? {} : { data }) });
  const failed = (error: unknown): void => host.channel.send({ type: 'result', requestId, ok: false, error: messageOf(error) });
  const quietly = <T>(job: () => Promise<T>): Promise<T> => host.quietly(job);
  const setting = async (line: string): Promise<void> => {
    const id = host.requireSession();
    await quietly(async () => { if (host.link.workerTurnRunning) await commandDuringTurn(id, line); else await aiSessionCommand(id, line); });
    await host.emitSession();
  };
  const queued = (job: () => Promise<unknown>): void => {
    host.enqueue(async () => {
      try { done(await quietly(job)); } catch (error) { failed(error); }
    });
  };
  const cx: ChooseContext = { host, done, setting, queued };
  try {
    const routed = await routedChoice(host, choice);
    if (await chooseSetting(cx, routed)) return;
    if (await chooseProvider(cx, routed)) return;
    if (await chooseConversation(cx, routed)) return;
    throw new Error(`unknown choice "${String((choice as { kind?: unknown }).kind)}"`);
  } catch (error) {
    failed(error);
  }
}
