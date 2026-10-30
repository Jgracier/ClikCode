/** A vendor CLI kept running after its turn ended, for its background work.
 *
 * Claude Code in stream-json mode answers, writes its `result`, and may still
 * have tasks running that it started with `run_in_background` -- a build, a
 * test run, a dev server that never ends. Holding the ClikCode turn open until
 * they finish (background-wait.ts) kept the user's prompt, the thinking line
 * and every slash command waiting behind a dev server that never ends.
 *
 * So the turn ends at that `result` and the process is handed here. It keeps
 * its stdin open, so a task that finishes still gets Claude's follow-up turn,
 * and that follow-up is reported as a vendor background turn
 * (harness/transport/background-turn.ts) -- the same surface Codex and ACP
 * use for work they do between turns. The process is let go when:
 *  - its tasks are done and Claude has said what it had to (settled),
 *  - the next turn on the same account waits for its subagents and their
 *    follow-up, then closes stdin (`releaseHeldVendorProcess`); an independent
 *    background shell may still be stopped on exit,
 *  - the conversation moves on (another account or harness, or the reply that
 *    started it failed) with subagents still running: the process is RETIRED
 *    (`retireHeldVendorProcess`). Nothing waits on it and nothing kills it; its
 *    subagents run on and each one's end is told to the conversation, stdin
 *    closing once the last has ended,
 *  - the process exits, or the user stops it.
 *
 * No timer decides when a subagent has run long enough: its end is the
 * vendor's `task_notification`, the process exiting, or the user's Stop.
 *
 * One per ClikCode session. */
import { lifecycle, quiet } from '../../../runtime/lifecycle-log.js';
import { BackgroundTurnChannel, type BackgroundTurnEnd, type VendorBackgroundTurnHandler } from '../background-turn.js';
import type { HarnessTurnObserver } from '../../events/turn-observer.js';
import type { BackgroundWait } from './background-wait.js';
import type { ReleasedTurnExit } from './turn.js';
import { turnCancelledError } from '../../../agent/cancellation.js';
import { endedAgentWork, type EndedWork, type RunningWork } from '../handoff-work.js';

type Json = Record<string, unknown>;

/** How long a process whose stdin was closed (it said it had nothing left) gets to exit before it is ended. */
const RELEASE_WAIT_MS = 5 * 60 * 1000;
/** How long a process the user stopped gets to exit on its own. */
const STOP_WAIT_MS = 2_000;

export interface HeldOwner { harness?: string; accountId?: string }

interface HeldVendorOptions {
  sessionId: string;
  /** The harness and account the process runs as: a turn on another one leaves it (retireHeldVendorProcess). */
  owner?: HeldOwner;
  background: BackgroundWait;
  /** Close the vendor's stdin. */
  endInput(): void;
  /** The turn's release handle: ends the turn now, keeps the process. */
  release: { release(onExit: (exit: ReleasedTurnExit) => void): boolean; terminate(): void };
  handler: VendorBackgroundTurnHandler;
  /** Told each subagent that ends while the conversation is still in this process (the ledger decides what it means). */
  workEnded?(ended: readonly EndedWork[]): void;
  /** Report one stdout line (and its record, when it is one) to a
   * background turn's observer. */
  report(line: string, observer: HarnessTurnObserver, record: Json | undefined): void;
}

export interface HeldVendor {
  /** Every stdout line after the release, in order, with the record it
   * holds when it is one (parsed once, by the caller). */
  line(text: string, record: Json | undefined): void;
  /** Claude went between turns (BackgroundWait onQuiet). */
  quiet(): void;
  /** Whether a subagent or its follow-up is still running. */
  readonly agentWork: boolean;
  readonly owner: HeldOwner | undefined;
  /** The subagents still running. */
  agents(): RunningWork[];
  /** The conversation leaves this process with subagents still running: it takes no more turns and
   * says nothing more into the conversation, its subagents run on, and each one's end goes to
   * `onEnded`. False when none is running (the caller waits for the follow-up and releases it). */
  retire(onEnded: (ended: EndedWork[]) => void): boolean;
  /** Whether it has been retired. */
  readonly retired: boolean;
  /** End it: close stdin and wait for the exit (bounded; then stopped).
   * `stop`: the user stopped it -- a moment to exit, then it is ended. */
  close(stop?: boolean): Promise<void>;
}

const held = new Map<string, HeldVendor>();
/** Processes a conversation left with subagents still running in them. */
const retiredHeld = new Map<string, Set<HeldVendor>>();
/** Who is waiting for a session's held process to be gone (the worker's
 * idle exit). */
const gone = new Map<string, Array<() => void>>();

function forget(sessionId: string, vendor: HeldVendor): void {
  if (held.get(sessionId) === vendor) {
    held.delete(sessionId);
    lifecycle('vendor.released');
  }
  const retired = retiredHeld.get(sessionId);
  if (retired?.delete(vendor) && !retired.size) retiredHeld.delete(sessionId);
  if (held.has(sessionId) || retiredHeld.has(sessionId)) return;
  for (const resolve of gone.get(sessionId)?.splice(0) ?? []) resolve();
}

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
  /** Once retired: the subagents still running, and who is told of their end. */
  let retiredAgents: Map<string, RunningWork> | undefined;
  let inputEnded = false;
  let told: ((ended: EndedWork[]) => void) | undefined;
  const tell = (ended: EndedWork[]): void => {
    if (!ended.length) return;
    try { told?.(ended); } catch { /* fail-open-ok: the owner's bookkeeping */ }
  };
  /** A subagent's `task_notification`: told with its result or why it stopped, to whoever answers for
   * it -- the retirement's owner once the conversation has left this process, else the ledger of the
   * live one (`workEnded`), which decides what its end means. */
  const agentEnded = (agent: RunningWork, record: Json): void => {
    void endedAgentWork(agent, String(record.status ?? 'completed'),
      typeof record.summary === 'string' ? record.summary : '', typeof record.output_file === 'string' ? record.output_file : undefined)
      .then((work) => { if (told) tell([work]); else options.workEnded?.([work]); }).catch(quiet('harness/transport/native/held-vendor'));
  };
  /** A retired process's record. */
  const retiredRecord = (record: Json): void => {
    if (record.type !== 'system' || record.subtype !== 'task_notification' || typeof record.task_id !== 'string') return;
    const agent = retiredAgents?.get(record.task_id);
    if (!agent) return;
    retiredAgents!.delete(record.task_id);
    agentEnded(agent, record);
  };
  const vendor: HeldVendor = {
    get agentWork() { return options.background.agentWork; },
    owner: options.owner,
    get retired() { return Boolean(retiredAgents); },
    agents: () => retiredAgents ? [...retiredAgents.values()] : options.background.agents(),
    retire(onEnded) {
      if (closing || exited || retiredAgents) return false;
      const running = options.background.agents();
      if (!running.length) return false;
      retiredAgents = new Map(running.map((agent) => [agent.id, agent]));
      told = onEnded;
      end('superseded');
      if (held.get(options.sessionId) === vendor) held.delete(options.sessionId);
      const set = retiredHeld.get(options.sessionId) ?? new Set<HeldVendor>();
      set.add(vendor);
      retiredHeld.set(options.sessionId, set);
      lifecycle('vendor.held.retired', { agents: running.length });
      return true;
    },
    line(text, record) {
      if (retiredAgents) {
        if (record) { retiredRecord(record); options.background.note(record); }
        // The last subagent has ended and been told: nothing is left that the conversation waits on.
        if (!retiredAgents.size && !inputEnded && !options.background.settled && options.background.quiet) { inputEnded = true; options.endInput(); }
        return;
      }
      if (record?.type === 'system' && record.subtype === 'task_notification' && typeof record.task_id === 'string') {
        const agent = options.background.agents().find((work) => work.id === record.task_id);
        if (agent && !closing) agentEnded(agent, record);
      }
      if (!channel && !closing && record && opensBackgroundTurn(record) && !options.background.settled) {
        channel = new BackgroundTurnChannel('structured-cli', 'background-work');
        try { options.handler(channel); } catch { /* fail-open-ok: the owner's bookkeeping */ }
      }
      if (channel) {
        try { options.report(text, channel.observer, record); } catch { /* fail-open-ok: presentation-only consumer */ }
      }
      // After reporting: the record may end the background turn (a result).
      if (record) options.background.note(record);
    },
    quiet() { end('completed'); },
    async close(stop = false) {
      closing = true;
      retiredAgents = undefined;
      forget(options.sessionId, vendor);
      end('superseded');
      options.endInput();
      if (exited) return;
      let timer: NodeJS.Timeout | undefined;
      const stopped = await Promise.race([
        exit.then(() => false),
        new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), stop ? STOP_WAIT_MS : RELEASE_WAIT_MS); timer.unref(); }),
      ]);
      if (timer) clearTimeout(timer);
      if (stopped) {
        options.release.terminate();
        await exit;
      }
    },
  };
  const released = options.release.release(() => {
    exited = true;
    end(options.background.settled ? 'completed' : 'closed');
    // Retired, and the process went: what it still ran went with it.
    const lost = [...retiredAgents?.values() ?? []];
    retiredAgents = undefined;
    tell(lost.map((agent): EndedWork => ({ ...agent, outcome: 'cut-off', tail: 'The process running it ended before it finished.' })));
    forget(options.sessionId, vendor);
    resolveExit();
  });
  if (!released) return undefined;
  const previous = held.get(options.sessionId);
  held.set(options.sessionId, vendor);
  lifecycle('vendor.held', { pending: options.background.pending });
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

/** The user stopped this session's background work: end the held process
 * now, its tasks with it. */
export async function stopHeldVendorProcess(sessionId: string): Promise<boolean> {
  const vendors = [held.get(sessionId), ...retiredHeld.get(sessionId) ?? []].filter((vendor): vendor is HeldVendor => Boolean(vendor));
  await Promise.all(vendors.map((vendor) => vendor.close(true)));
  return vendors.length > 0;
}

/** The held process of this session, if any (not a retired one). */
export function heldVendorOwner(sessionId: string): HeldOwner | undefined {
  return held.get(sessionId)?.owner;
}

/** Retire the held process (HeldVendor.retire): false when it runs no subagent. */
export function retireHeldVendorProcess(sessionId: string, onEnded: (ended: EndedWork[]) => void): boolean {
  return held.get(sessionId)?.retire(onEnded) ?? false;
}

/** How many subagents this session's retired processes still run. */
export function retiredHeldAgentCount(sessionId: string): number {
  let count = 0;
  for (const vendor of retiredHeld.get(sessionId) ?? []) count += vendor.agents().length;
  return count;
}

/** Whether a finished turn left a process running for this session. */
export function hasHeldVendorProcess(sessionId: string): boolean {
  return held.has(sessionId);
}

/** Resolves once no process is held for this session (at once if none is):
 * the worker waits on this rather than idling out under a vendor that is
 * still finishing work it was asked to do. */
export function whenHeldVendorGone(sessionId: string): Promise<void> {
  if (!held.has(sessionId) && !retiredHeld.has(sessionId)) return Promise.resolve();
  return new Promise((resolve) => {
    const waiting = gone.get(sessionId) ?? [];
    waiting.push(resolve);
    gone.set(sessionId, waiting);
  });
}

/** Before the next prompt on the same account, let a held Claude subagent finish in the process
 * that owns it. A background shell may be released normally. Ends when the vendor reports none
 * running (or the process exits); a stop (`signal`) throws. No clock: a turn that must not wait
 * retires the process instead (retireHeldVendorProcess). */
export async function waitForHeldVendorSubagents(sessionId: string, signal?: AbortSignal): Promise<void> {
  while (held.get(sessionId)?.agentWork) {
    if (signal?.aborted) throw turnCancelledError();
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
  }
  if (signal?.aborted) throw turnCancelledError();
}
