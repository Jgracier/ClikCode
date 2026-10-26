/** What a message typed while a turn runs does: `/send steer|queue`.
 *
 * steer -- into the running turn when the vendor can take it without interrupting
 * anything (Codex at once, an ACP agent once no tool call is open, the Gateway before its
 * next model step); until then it waits in the saved queue. An agent that has no
 * steering leaves it queued for the turn to end, and its row says so.
 * queue -- waits in the saved queue for the turn to end and runs as the next turn;
 * Enter again (nothing typed) offers it to the running turn.
 *
 * A global user setting (globalSettings.sendMode, absent = steer). The worker
 * reads it when a message arrives (session-worker.ts), so every client -- the
 * terminal and VS Code -- gets the same delivery. Chalk free and dependency
 * free, so the webview bundle can import it. */

import type { LiveTurnInputBroker, LiveTurnInputResult } from './live-input.js';

type SendMode = 'steer' | 'queue';

export const SEND_MODES: readonly SendMode[] = ['steer', 'queue'];

export const SEND_MODE_DETAIL: Readonly<Record<SendMode, string>> = {
  steer: 'into the running turn at its next pause; queued where the agent takes none',
  queue: 'wait for the turn to end, then go as the next turn',
};

export function sendModeOf(settings: { sendMode?: unknown } | undefined): SendMode {
  return settings?.sendMode === 'queue' ? 'queue' : 'steer';
}

export function parseSendMode(word: string): SendMode {
  const value = word.trim().toLowerCase();
  if (value === 'steer' || value === 'queue') return value;
  throw new Error('usage: /send [steer|queue]');
}

/** The worker's delivery of a message typed mid-turn: the turn's broker,
 * told by the user's setting whether it is to be steered in. */
export function deliverTyped(
  broker: Pick<LiveTurnInputBroker, 'submit'>, text: string, id: string | undefined, settings: { sendMode?: unknown } | undefined,
): Promise<LiveTurnInputResult> {
  return broker.submit(text, id, { steer: sendModeOf(settings) === 'steer' });
}
