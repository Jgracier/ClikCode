/**
 * The words for what a person can do to a running turn, and the key for each,
 * shared by the terminal and the VS Code webview. One verb per action: a turn
 * is "stopped" everywhere -- never interrupted or cancelled in what is shown.
 * Chalk free and dependency free, so the webview bundle can import it.
 */

export const ACTIONS = {
  /** End the running turn. Ctrl+C, the stop button, and the palette's
   *  command. Esc does too, once the turn has an answer. Before that, Esc
   *  puts the prompt back in the composer. */
  stop: { verb: 'stop', key: 'Ctrl+C' },
  /** Mid-turn, a message waiting: take the newest back into the composer to
   *  edit. Nothing running is touched. */
  takeBack: { verb: 'edit', key: 'Esc' },
  /** Mid-turn, nothing typed, a message already waiting: put it into the
   *  chat at the next pause. The turn keeps running, and so do its
   *  sub-agents. Enter AGAIN -- the first Enter is the one that queued it. */
  sendNow: { verb: 'send into the chat', key: 'Enter again' },
  /** Send what is typed: steered into the turn or queued behind it (/send). */
  send: { verb: 'send', key: 'Enter' },
  /** Take the highlighted command from the palette. */
  apply: { verb: 'apply', key: 'Enter' },
} as const;

export type Action = keyof typeof ACTIONS;

/** The notice once a turn has been stopped. */
export const STOPPED = 'Stopped';

/** The VS Code command that stops the turn, as the palette lists it. */
export const STOP_TURN_COMMAND = 'Stop Turn';

/** `ctrl+c stop`: an action's key and verb, as every hint words it. */
export function keyHint(action: Action): string {
  const { verb, key } = ACTIONS[action];
  return keyHintFor(key, verb);
}

/** `esc close`: a key and what it does, lower case -- the one way every hint
 * in the terminal's dim bands is worded, joined by ` · `. */
export function keyHintFor(key: string, verb: string): string {
  return `${key.toLowerCase()} ${verb}`;
}

/** `Stop (Ctrl+C)`: a button's title and accessible name. */
export function buttonTitle(action: Action): string {
  const { verb, key } = ACTIONS[action];
  return `${verb[0]!.toUpperCase()}${verb.slice(1)} (${key})`;
}
