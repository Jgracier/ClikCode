/** What a message typed while a turn runs does: `/send steer|queue`.
 *
 * steer -- delivered into the running turn at its next safe point (Codex and
 * the Gateway at once, an ACP agent that takes steering once no tool call is
 * open). An agent that cannot take one queues it instead, and its row says so.
 * queue -- always waits for the turn to end and runs as the next turn.
 *
 * A global user setting (globalSettings.sendMode, absent = steer). The worker
 * reads it when a message arrives (session-worker.ts), so every client -- the
 * terminal and VS Code -- gets the same delivery. Chalk free and dependency
 * free, so the webview bundle can import it. */

import type { LiveTurnInputBroker, LiveTurnInputResult } from './live-input.js';

export type SendMode = 'steer' | 'queue';

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
 * told by the user's setting whether it may steer at all. */
export function deliverTyped(
  broker: Pick<LiveTurnInputBroker, 'submit'>, text: string, id: string | undefined, settings: { sendMode?: unknown } | undefined,
): Promise<LiveTurnInputResult> {
  return broker.submit(text, id, { queue: sendModeOf(settings) === 'queue' });
}
