/** A choice made in the editor's own widgets, applied with the command the
 * terminal's picker ends in. A setting that can change mid-turn does so
 * (commandDuringTurn); anything that moves the conversation waits for no
 * turn, and says so. One module per kind family. */
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
    if (await chooseSetting(cx, choice)) return;
    if (await chooseProvider(cx, choice)) return;
    if (await chooseConversation(cx, choice)) return;
    throw new Error(`unknown choice "${String((choice as { kind?: unknown }).kind)}"`);
  } catch (error) {
    failed(error);
  }
}
