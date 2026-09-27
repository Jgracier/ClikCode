/** A vendor CLI kept running after its turn ended, for its background work.
 *
 * Claude Code in stream-json mode answers, writes its `result`, and may still
 * have tasks running that it started with `run_in_background` -- a build, a
 * test run, a dev server that never ends. Holding the ClikCode turn open until
 * they finish (background-wait.ts) kept the user's prompt, the thinking line
 * and every slash command waiting behind a dev server for the whole hour-long
 * tool budget, after which the watchdog killed it.
 *
 * So the turn ends at that `result` and the process is handed here. It keeps
 * its stdin open, so a task that finishes still gets Claude's follow-up turn,
 * and that follow-up is reported as a vendor background turn
 * (harness/transport/background-turn.ts) -- the same surface Codex and ACP
 * use for work they do between turns. The process is let go when:
 *  - its tasks are done and Claude has said what it had to (settled),
 *  - the user sends the next turn (`releaseHeldVendorProcess`): stdin closes,
 *    a follow-up already under way finishes into Claude's own transcript --
 *    which the next turn resumes -- and Claude stops its remaining tasks on
 *    exit, as it always does when its input ends,
 *  - the ceiling passes, or the idle watchdog stops a silent process.
 *
 * One per ClikCode session. */
import { BackgroundTurnChannel, type BackgroundTurnEnd, type VendorBackgroundTurnHandler } from '../background-turn.js';
import type { HarnessTurnObserver } from '../../events/turn-observer.js';
import type { BackgroundWait } from './background-wait.js';
import type { ReleasedTurnExit } from './turn.js';

/** Wall-clock ceiling on a held process: after this its stdin closes. */
export const HELD_VENDOR_CEILING_MS = 60 * 60 * 1000;
/** How long a new turn waits for a held process to exit before stopping it. */
const RELEASE_WAIT_MS = 5 * 60 * 1000;

export interface HeldVendorOptions {
  sessionId: string;
  background: BackgroundWait;
  /** Close the vendor's stdin. */
  endInput(): void;
  /** The turn's release handle: ends the turn now, keeps the process. */
  release: { release(onExit: (exit: ReleasedTurnExit) => void): boolean; terminate(): void };
  handler: VendorBackgroundTurnHandler;
  /** Report one stdout line to a background turn's observer. */
  report(line: string, observer: HarnessTurnObserver): void;
  ceilingMs?: number;
}

export interface HeldVendor {
  /** Every stdout line after the release, in order. */
  line(text: string): void;
  /** Claude went between turns (BackgroundWait onQuiet). */
  quiet(): void;
  /** End it: close stdin and wait for the exit (bounded; then stopped). */
  close(): Promise<void>;
}

const held = new Map<string, HeldVendor>();

type Json = Record<string, unknown>;

/** A record that begins work a background turn should show. */
function opensBackgroundTurn(record: Json): boolean {
  return record.type === 'system' && (record.subtype === 'init' || record.subtype === 'task_notification');
}

/** Release the turn and keep its process. Undefined when the turn had already
 * ended (the caller keeps its ordinary path). */
export function holdVendorProcess(options: HeldVendorOptions): HeldVendor | undefined {
  let channel: BackgroundTurnChannel | undefined;
  let exited = false;
  /** Let go: what it says on the way out (its tasks reported killed) is not
   * work to show. */
  let closing = false;
  let resolveExit!: () => void;
  const exit = new Promise<void>((resolve) => { resolveExit = resolve; });
  const end = (ended: BackgroundTurnEnd): void => {
    channel?.finish(ended);
    channel = undefined;
  };
  const ceiling = setTimeout(() => { closing = true; end('completed'); options.endInput(); }, options.ceilingMs ?? HELD_VENDOR_CEILING_MS);
  ceiling.unref();
  const vendor: HeldVendor = {
    line(text) {
      let record: Json | undefined;
      if (text.trimStart().startsWith('{')) {
        try { record = JSON.parse(text) as Json; } catch { record = undefined; }
      }
      if (!channel && !closing && record && opensBackgroundTurn(record) && !options.background.settled) {
        channel = new BackgroundTurnChannel('structured-cli', 'background-work');
        try { options.handler(channel); } catch { /* fail-open-ok: the owner's bookkeeping */ }
      }
      if (channel) {
        try { options.report(text, channel.observer); } catch { /* fail-open-ok: presentation-only consumer */ }
      }
      // After reporting: the record may end the background turn (a result).
      if (record) options.background.note(record);
    },
    quiet() { end('completed'); },
    async close() {
      closing = true;
      if (held.get(options.sessionId) === vendor) held.delete(options.sessionId);
      end('superseded');
      options.endInput();
      if (exited) return;
      let timer: NodeJS.Timeout | undefined;
      const stopped = await Promise.race([
        exit.then(() => false),
        new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), RELEASE_WAIT_MS); timer.unref(); }),
      ]);
      if (timer) clearTimeout(timer);
      if (stopped) {
        options.release.terminate();
        await exit;
      }
    },
  };
  const released = options.release.release((outcome) => {
    exited = true;
    clearTimeout(ceiling);
    options.background.dispose();
    end(outcome.timedOut ? 'idle-timeout' : options.background.settled ? 'completed' : 'closed');
    if (held.get(options.sessionId) === vendor) held.delete(options.sessionId);
    resolveExit();
  });
  if (!released) {
    clearTimeout(ceiling);
    return undefined;
  }
  const previous = held.get(options.sessionId);
  held.set(options.sessionId, vendor);
  if (previous) void previous.close();
  return vendor;
}

/** Let go of the process a finished turn left running for this session, if
 * any, before another turn starts: two vendor processes must not write one
 * conversation. */
export async function releaseHeldVendorProcess(sessionId: string): Promise<boolean> {
  const vendor = held.get(sessionId);
  if (!vendor) return false;
  await vendor.close();
  return true;
}

/** Whether a finished turn left a process running for this session. */
export function hasHeldVendorProcess(sessionId: string): boolean {
  return held.has(sessionId);
}
