/** "Steer should always get a reply": when a message typed mid-turn cannot reach the model yet (a tool
 * call is open), ClikCode itself answers at once -- received, held, behind what -- and keeps saying so
 * until it lands. Never a cancel, never silent. */

const STILL_HELD_EVERY_MS = 60_000;

const clip = (text: string, max = 70): string => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};
const duration = (seconds: number): string => seconds >= 120 ? `${Math.round(seconds / 60)} min` : `${seconds}s`;

export interface OpenCall { label: string; seconds: number; count: number }

export function heldSteerNote(text: string, call: OpenCall | undefined): string {
  const behind = call
    ? `${clip(call.label, 60)}${call.count > 1 ? ` (+${call.count - 1} more)` : ''} (running ${duration(call.seconds)})`
    : 'the current call';
  return `Steer received: "${clip(text)}". Held until ${behind} pauses, then it goes to the model. Nothing was stopped.`;
}

export function stillHeldNote(text: string, call: OpenCall | undefined): string {
  const behind = call ? `${clip(call.label, 60)} (running ${duration(call.seconds)})` : 'the current call';
  return `Still held: "${clip(text, 50)}" is waiting behind ${behind}. It is not lost: it is heard when that returns, or runs as your next message when the turn ends.`;
}

export const deliveredSteerNote = (text: string): string => `Delivered to the model: "${clip(text, 50)}".`;
export const ranNextSteerNote = (text: string): string => `The turn ended before the model could take "${clip(text, 50)}": it runs as your next message.`;

/** Replies for one held steer: the first at once, a reminder each minute, and how it ended. */
export function acknowledgeHeldSteer(
  text: string, landed: Promise<boolean>,
  io: { say: (message: string) => void; openCall: () => OpenCall | undefined },
  everyMs = STILL_HELD_EVERY_MS,
): void {
  io.say(heldSteerNote(text, io.openCall()));
  let over = false;
  const timer = setInterval(() => { if (!over) io.say(stillHeldNote(text, io.openCall())); }, everyMs);
  timer.unref?.();
  void landed.then((steered) => { over = true; clearInterval(timer); io.say(steered ? deliveredSteerNote(text) : ranNextSteerNote(text)); },
    () => { over = true; clearInterval(timer); io.say(ranNextSteerNote(text)); });
}
