/**
 * The words for what a person can do to a running turn, and the key for each,
 * shared by the terminal and the VS Code webview. One verb per action: a turn
 * is "stopped" everywhere -- never interrupted or cancelled in what is shown.
 * Chalk free and dependency free, so the webview bundle can import it.
 */

export const ACTIONS = {
  /** End the running turn. Ctrl+C, the stop button, the palette's command --
   *  never Esc, which only ever backs out of something of the user's own. */
  stop: { verb: 'stop', key: 'Ctrl+C' },
  /** Mid-turn, a message waiting: take the newest back into the composer to
   *  edit. Nothing running is touched. */
  takeBack: { verb: 'edit', key: 'Esc' },
  /** Mid-turn, nothing typed, a message already waiting: stop the turn and
   *  send what waits next, at once. Enter AGAIN -- the first Enter is the one
   *  that sent the message. Says "stop": it ends the turn's sub-agents too. */
  sendNow: { verb: 'stop & send', key: 'Enter again' },
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

/** `ctrl+c to stop`: a hint in the terminal's dim status band. */
export function keyHint(action: Action): string {
  const { verb, key } = ACTIONS[action];
  return `${key.toLowerCase()} to ${verb}`;
}

/** `Stop (Ctrl+C)`: a button's title and accessible name. */
export function buttonTitle(action: Action): string {
  const { verb, key } = ACTIONS[action];
  return `${verb[0]!.toUpperCase()}${verb.slice(1)} (${key})`;
}
