/** The lifecycle the persistent JSON-RPC transports (ACP, Codex app-server)
 * share: one child kept alive across turns, one active turn at a time raced
 * against its failure, a polite cancel that settles before the child is
 * killed, and background turns for work the vendor does between ours. What
 * a turn says and how it is cancelled stay with each transport. */
import { lifecycle } from '../../runtime/lifecycle-log.js';
import { markTurn } from '../../runtime/turn-latency.js';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { isTurnCancelled, turnCancelledError } from '../../agent/cancellation.js';
import { spawnPortable } from './spawn.js';
import { JsonRpcPeer, type JsonRpcPeerOptions } from './jsonrpc-peer.js';
import type { BackgroundTurnChannel, BackgroundTurnEnd, OutOfTurnRelay, VendorBackgroundTurnHandler } from './background-turn.js';
import { commandLine, commandRoots, outputFile, processGroup, processGroupMembers, readProcessGroup, toolCallWork } from './process-group.js';
import { readFile } from 'node:fs/promises';
import { redactSecrets } from '../../agent/security.js';
import type { EndedWork, RunningWork, WorkEndedHandler } from './handoff-work.js';

/** How often a retired process's commands are looked at. */
const RETIRED_POLL_MS = 3_000;
/** How long work handed off with a retired process (retire) may run with nobody
 * waiting on it: past this, what is left is told as cut off and the process and
 * its group are closed. The same ceiling as a background shell the worker itself
 * keeps (worker-idle.ts ABANDONED_SHELL_MS): a vendor that never reports its
 * agent done, or a command that never ends, does not keep a process for ever. */
export const ABANDONED_WORK_MS = 24 * 60 * 60 * 1000;
/** How much of a finished command's output goes to the conversation. */
const OUTPUT_TAIL_CHARS = 4_000;

/** The end of what a command wrote to `file`, secrets redacted. */
async function outputTail(file: string | undefined): Promise<string> {
  if (!file) return '';
  const text = await readFile(file, 'utf8').catch(() => '');
  return redactSecrets(text.length > OUTPUT_TAIL_CHARS ? `...${text.slice(-OUTPUT_TAIL_CHARS)}` : text);
}

/** How long a cancelled turn gets to unwind before its child is killed. */
export const CANCEL_SETTLE_MS = 2000;

/** How long a setup request (handshake, session or thread open, model and mode
 * changes) may go with nothing at all from the agent before it is given up as
 * stalled. An idle window, not a deadline: any message or output restarts it,
 * so a cold `session/load` streaming a huge thread is never cut off. MEASURED
 * 2026-10-20 over ~400 ACP setups in lifecycle.log (`vendor.acp.ready`): the
 * slowest whole setup took 11s and the slowest thread load 7.5s; five minutes
 * of total silence is far past anything a live agent does. The prompt turn
 * itself has no clock: an agent legitimately works for hours. */
export const SETUP_IDLE_MS = 5 * 60_000;

type PersistentSpawn = (binary: string, argv: readonly string[], options: SpawnOptions) => ChildProcess;

export interface PersistentSessionOptions {
  spawn?: PersistentSpawn;
  /** Receives work the vendor does between ClikCode turns. */
  backgroundTurns?: VendorBackgroundTurnHandler;
  /** Receives what the vendor says with no prompt open and no tool running: it
   * goes into the conversation, and nothing is shown as working for it. */
  outOfTurn?: OutOfTurnRelay;
  /** Told the work that ends after the conversation left this process (retire), and each agent the
   * account's usage limit cut off. */
  workEnded?: WorkEndedHandler;
  /** SETUP_IDLE_MS, shortened by tests. */
  setupIdleMs?: number;
  /** ABANDONED_WORK_MS, shortened by tests. */
  retiredCeilingMs?: number;
}

/** A retired process (retire): its group, and the work in it still running. */
interface Retirement {
  root: number; peer: JsonRpcPeer; commands: Map<number, RunningWork>; agents: Map<string, RunningWork>;
  timer?: NodeJS.Timeout;
  /** ABANDONED_WORK_MS from the retirement. */
  ceiling?: NodeJS.Timeout;
}

interface PersistentLive { peer: JsonRpcPeer; key: string; pid?: number }
interface PersistentTurn { done: boolean; fail: (error: Error) => void }
interface PersistentBackground { channel: BackgroundTurnChannel }

/** A promise that rejects when `fail` is called: what a turn's flow races. */
export function turnFailure(): { failure: Promise<never>; fail: (error: Error) => void } {
  let fail!: (error: Error) => void;
  const failure = new Promise<never>((_, reject) => { fail = reject; });
  failure.catch(() => undefined);
  return { failure, fail };
}

/** One turn on a session that is closed as soon as it answers. */
export async function runOneTurn<I, R>(session: { runTurn(input: I): Promise<R>; close(): Promise<void> }, input: I): Promise<R> {
  try {
    return await session.runTurn(input);
  } finally {
    // Shutdown is graceful (up to seconds); the caller already has its answer.
    void session.close().catch(() => undefined);
  }
}

export abstract class PersistentSession<L extends PersistentLive, T extends PersistentTurn, B extends PersistentBackground> {
  protected live?: L;
  protected turn?: T;
  protected background?: B;
  protected settling?: Promise<void>;
  protected isClosed = false;
  private readonly spawn: PersistentSpawn;
  private readonly onBackgroundTurn?: VendorBackgroundTurnHandler;
  private readonly outOfTurnRelay?: OutOfTurnRelay;
  private readonly onWorkEnded?: WorkEndedHandler;
  /** The request options of a setup step (SETUP_IDLE_MS). */
  protected readonly setupRequest: { timeoutMs: number; idleReset: true };
  private readonly retiredCeilingMs: number;
  /** Set once the conversation has left this process with work still running in it (retire). */
  private retirement?: Retirement;
  /** The child's process group when the current turn's prompt went out
   * (promptSent): what was already running -- the vendor, its MCP servers. */
  private atPrompt?: Promise<Set<number>>;
  /** Processes a turn started and left running after it. Only some are the
   * vendor's background work (a `run_in_background` shell, a dev server):
   * the rest are helpers it started lazily (MCP servers). toolCallWork
   * (process-group.ts) tells them apart. */
  private readonly leftRunning = new Set<number>();

  constructor(options: PersistentSessionOptions, private readonly label: string) {
    this.spawn = options.spawn ?? ((binary, argv, spawnOptions) => spawnPortable(binary, [...argv], spawnOptions));
    this.onBackgroundTurn = options.backgroundTurns;
    this.outOfTurnRelay = options.outOfTurn;
    this.onWorkEnded = options.workEnded;
    this.setupRequest = { timeoutMs: options.setupIdleMs ?? SETUP_IDLE_MS, idleReset: true };
    this.retiredCeilingMs = options.retiredCeilingMs ?? ABANDONED_WORK_MS;
  }

  /** Where what the vendor says out of turn goes: nowhere once retired -- the conversation is
   * another process's now, and this one's follow-ups are not its words. */
  protected get relay(): OutOfTurnRelay | undefined {
    return this.retirement ? undefined : this.outOfTurnRelay;
  }

  /** Whether the conversation has left this process (retire). */
  get retired(): boolean { return Boolean(this.retirement); }

  /** What a retired process still runs, by kind. */
  get retiredWork(): { agents: number; terminals: number } {
    const retirement = this.isClosed ? undefined : this.retirement;
    return { agents: retirement?.agents.size ?? 0, terminals: retirement?.commands.size ?? 0 };
  }

  /** Agents the vendor is running in the background (ACP: Claude's `task_*` frames). */
  protected runningAgents(): RunningWork[] { return []; }

  /** The commands tool calls left running, one per command (commandRoots), with what they run and
   * where their output goes. */
  private async leftCommands(): Promise<Map<number, RunningWork>> {
    const commands = new Map<number, RunningWork>();
    const root = this.live?.pid;
    if (this.isClosed || !this.live || this.live.peer.closed || !root || !this.leftRunning.size) return commands;
    const group = await processGroup(root);
    for (const pid of this.leftRunning) if (!group.has(pid)) this.leftRunning.delete(pid);
    for (const pid of commandRoots(group, this.leftRunning, toolCallWork(group, root, this.leftRunning))) {
      const [label, output] = await Promise.all([commandLine(pid), outputFile(pid)]);
      commands.set(pid, { id: String(pid), kind: 'command', label: label ?? group.get(pid)?.name ?? 'background command', ...(output ? { outputFile: output } : {}) });
    }
    return commands;
  }

  /** What would be lost by closing this process now. */
  async runningWork(): Promise<RunningWork[]> {
    return [...(await this.leftCommands()).values(), ...this.runningAgents()];
  }

  /** The conversation is leaving this process for another account or provider. Nothing it runs is
   * waited on, and nothing is killed with it: it takes no more turns and says nothing more into the
   * conversation, its commands and agents run on, and each one's end goes to `workEnded`. Closed
   * once nothing is left. False when nothing was running: the caller closes it. */
  async retire(): Promise<boolean> {
    if (this.retirement) return true;
    const root = this.live?.pid;
    if (this.isClosed || !this.live || this.live.peer.closed || !root) return false;
    const commands = await this.leftCommands();
    const agents = new Map(this.runningAgents().map((work) => [work.id, work]));
    if (!commands.size && !agents.size) return false;
    const retirement: Retirement = { root, peer: this.live.peer, commands, agents };
    this.retirement = retirement;
    // Its work runs on even after the vendor itself exits (jsonrpc-peer.ts keepGroup).
    retirement.peer.keepGroup();
    lifecycle('vendor.retired', { transport: this.label, commands: commands.size, agents: agents.size });
    // What was following its work in the conversation ends: the conversation is elsewhere.
    this.finishBackground('superseded');
    const poll = async (): Promise<void> => {
      if (this.retirement !== retirement) return;
      // The group outlives its leader: a command still runs after the vendor itself has gone.
      // Unreadable (no /proc, `ps` failing) is not "ended": nothing is told on a failed read,
      // and the ceiling bounds how long it is looked at.
      const group = await readProcessGroup(retirement.root).catch(() => undefined);
      if (this.retirement !== retirement) return;
      if (group) {
        const ended: EndedWork[] = [];
        for (const [pid, work] of retirement.commands) {
          if (group.has(pid)) continue;
          retirement.commands.delete(pid);
          ended.push({ ...work, outcome: 'finished', tail: await outputTail(work.outputFile) });
        }
        this.retiredEnded(ended);
      }
      if (this.retirement === retirement && retirement.commands.size) retirement.timer = setTimeout(() => void poll(), RETIRED_POLL_MS);
    };
    if (commands.size) retirement.timer = setTimeout(() => void poll(), RETIRED_POLL_MS);
    retirement.ceiling = setTimeout(() => void this.retiredCeiling(retirement), this.retiredCeilingMs);
    retirement.ceiling.unref?.();
    return true;
  }

  /** Retired work still running at the ceiling (ABANDONED_WORK_MS): told as cut off, with what it
   * wrote so far, and the process and its group closed. */
  private async retiredCeiling(retirement: Retirement): Promise<void> {
    if (this.retirement !== retirement || this.isClosed) return;
    const hours = Math.round(this.retiredCeilingMs / 3_600_000);
    const note = `Stopped: it was still running ${hours ? `${hours} hour${hours === 1 ? '' : 's'}` : 'a long time'} after the conversation moved on, with nothing waiting on it.`;
    const commands = [...retirement.commands.values()];
    const agents = [...retirement.agents.values()];
    retirement.commands.clear();
    retirement.agents.clear();
    const ended: EndedWork[] = [
      ...await Promise.all(commands.map(async (work): Promise<EndedWork> => {
        const tail = await outputTail(work.outputFile);
        return { ...work, outcome: 'cut-off', tail: tail ? `${tail}\n${note}` : note };
      })),
      ...agents.map((work): EndedWork => ({ ...work, outcome: 'cut-off', tail: note })),
    ];
    lifecycle('vendor.retired.ceiling', { transport: this.label, commands: commands.length, agents: agents.length });
    this.retiredEnded(ended);
  }

  /** Retired, and the vendor went: its agents went with it, cut off. Its commands are still
   * looked at -- a command can outlive the process that started it. */
  private retiredVendorGone(): void {
    const retirement = this.retirement;
    if (!retirement?.agents.size) return;
    const ended = [...retirement.agents.values()].map((work): EndedWork => ({ ...work, outcome: 'cut-off', tail: 'The process running it ended before it finished.' }));
    retirement.agents.clear();
    this.retiredEnded(ended);
  }

  /** Retired: work that ended is told, and the process is closed once nothing is left. */
  private retiredEnded(ended: readonly EndedWork[]): void {
    const retirement = this.retirement;
    if (!retirement) return;
    if (ended.length) { try { this.onWorkEnded?.(ended); } catch { /* fail-open-ok: the owner's bookkeeping */ } }
    if (!retirement.commands.size && !retirement.agents.size) {
      if (retirement.timer) clearTimeout(retirement.timer);
      if (retirement.ceiling) clearTimeout(retirement.ceiling);
      void this.close().catch(() => undefined);
    }
  }

  /** An agent ended (`task_notification`). Retired: told, whatever its end. Otherwise only an agent
   * the account's usage limit cut off: its own process can no longer start it again, the conversation's
   * next account can. */
  protected agentEnded(ended: EndedWork): void {
    const retirement = this.retirement;
    if (retirement) {
      if (!retirement.agents.delete(ended.id)) return;
      this.retiredEnded([ended]);
      return;
    }
    if (ended.outcome === 'cut-off' && ended.limit) {
      try { this.onWorkEnded?.([ended]); } catch { /* fail-open-ok: the owner's bookkeeping */ }
    }
  }

  /** Forget the vendor work being tracked as still running. */
  protected abstract clearPending(): void;
  /** Vendor work the protocol itself says is still running (Codex items). */
  protected abstract pendingCount(): number;
  /** A live subagent is allowed to finish even if it is silent for an hour. */
  protected hasActiveSubagents(): boolean { return false; }

  /** The transport is about to send the turn's prompt (awaited first): what
   * runs in the child's group from here on, and is still running when the
   * turn ends, is the vendor's background work. */
  protected async promptSent(): Promise<void> {
    const pid = this.live?.pid;
    // Read before the prompt goes out: a job the vendor starts for it must
    // not already be in the snapshot.
    this.atPrompt = pid ? Promise.resolve(await processGroupMembers(pid).catch(() => new Set<number>())) : undefined;
  }

  /** Whether the vendor is still doing work between turns: what its
   * protocol reports still running (Codex items, tools an ACP background
   * turn follows), or what a tool call left running (toolCallWork) -- never
   * the vendor's own helpers. The session worker stays up for it
   * (session-worker.ts) instead of closing the child under it, and reports
   * it stopped when it must close it. */
  async backgroundWorkRunning(): Promise<boolean> {
    if (this.retirement) return this.retirement.commands.size + this.retirement.agents.size > 0;
    if (this.isClosed || !this.live || this.live.peer.closed) return false;
    if (this.pendingCount() > 0) return true;
    const root = this.live.pid;
    if (!this.leftRunning.size || !root) return false;
    const group = await processGroup(root);
    for (const pid of this.leftRunning) if (!group.has(pid)) this.leftRunning.delete(pid);
    return toolCallWork(group, root, this.leftRunning).size > 0;
  }

  private async noteLeftRunning(): Promise<void> {
    const before = this.atPrompt;
    this.atPrompt = undefined;
    const pid = this.live?.pid;
    if (!before || !pid) return;
    const [then, now] = await Promise.all([before, processGroupMembers(pid)]);
    for (const member of now) if (member !== pid && !then.has(member)) this.leftRunning.add(member);
  }
  /** Ask the vendor to stop `turn`, settling `this.settling` (settleCancel);
   * false when the turn has not reached the point it can be asked. */
  protected abstract interrupt(turn: T, live: L): boolean;

  cancel(): void {
    if (this.turn) this.cancelTurn(this.turn);
  }

  /** The prompts a vendor request has open on the user's screen (an approval,
   * a question). Each is aborted when the vendor withdraws it, the turn ends
   * or the child goes: the prompt closes instead of outliving what asked it. */
  private readonly openPrompts = new Set<AbortController>();

  protected openPrompt(): { signal: AbortSignal; abort: () => void; release: () => void } {
    const controller = new AbortController();
    this.openPrompts.add(controller);
    return { signal: controller.signal, abort: () => controller.abort(), release: () => { this.openPrompts.delete(controller); } };
  }

  protected closePrompts(): void {
    for (const controller of this.openPrompts) controller.abort();
    this.openPrompts.clear();
  }

  async close(): Promise<void> {
    const retirement = this.retirement;
    if (retirement?.timer) clearTimeout(retirement.timer);
    if (retirement?.ceiling) clearTimeout(retirement.ceiling);
    // Closed, a retired process's group goes with it -- its vendor may have exited
    // long ago, leaving the group to its work (keepGroup).
    retirement?.peer.keepGroup(false);
    this.isClosed = true;
    if (this.turn) this.cancelTurn(this.turn);
    this.finishBackground('closed');
    this.clearPending();
    this.releaseSetup?.();
    if (this.settling) await this.settling;
    const live = this.live;
    this.live = undefined;
    if (!live) return;
    live.peer.rejectPending(new Error(`${this.label} session closed`));
    await live.peer.shutdown();
  }

  /** Throws unless a turn may start now. `name` labels the errors. */
  protected assertIdle(name: string): void {
    if (this.isClosed || this.retirement) throw new Error(`${name} session is closed`);
    if (this.turn) throw new Error(`${name} session already has an active turn`);
  }

  /** Run `turn` until its flow answers or it fails. `failed` sees every
   * failure but a cancellation; `ended` runs last, once the turn is done. */
  protected async runActive<R>(turn: T, signal: AbortSignal | undefined, failure: Promise<never>, flow: () => Promise<R>, hooks: {
    failed: (error: Error) => void;
    ended: (succeeded: boolean) => void;
  }): Promise<R> {
    // From here on the user's turn receives what the vendor says.
    this.finishBackground('superseded');
    this.turn = turn;
    const onAbort = (): void => this.cancelTurn(turn, signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    let succeeded = false;
    try {
      if (this.settling) await this.settling;
      // Cancelled while it waited: nothing of it may start now.
      if (signal?.aborted || turn.done) throw turnCancelledError();
      const running = flow();
      running.catch(() => undefined);
      const result = await Promise.race([running, failure]);
      succeeded = true;
      return result;
    } catch (error) {
      const failureError = error instanceof Error ? error : new Error(String(error));
      if (!isTurnCancelled(failureError)) hooks.failed(failureError);
      throw failureError;
    } finally {
      turn.done = true;
      this.closePrompts();
      signal?.removeEventListener('abort', onAbort);
      if (this.turn === turn) this.turn = undefined;
      hooks.ended(succeeded);
      void this.noteLeftRunning().catch(() => undefined);
    }
  }

  protected cancelTurn(turn: T, reason?: unknown): void {
    if (turn.done) return;
    turn.done = true;
    this.closePrompts();
    const live = this.live;
    const error = turnCancelledError();
    // False: nothing can be asked of the vendor, and the child goes.
    if (live && !this.interrupt(turn, live)) this.dropLive(error);
    turn.fail(error);
  }

  /** Wait up to CANCEL_SETTLE_MS for `wait` to report the cancelled turn
   * settled, so the session stays resumable; then kill the child. */
  protected settleCancel(live: L, wait: (settled: () => void) => void, onTimeout?: () => void): void {
    this.settling = new Promise<void>((resolve) => {
      const timer = setTimeout(() => { onTimeout?.(); if (this.live === live) this.dropLive(turnCancelledError()); resolve(); }, CANCEL_SETTLE_MS);
      wait(() => { clearTimeout(timer); resolve(); });
    }).finally(() => { this.settling = undefined; });
  }

  /** Ends the wait on a setup let finish in the background (settleSetup). */
  private releaseSetup?: () => void;

  /** Whether a cancelled turn's setup is still finishing in the background. */
  protected get setupSettling(): boolean { return Boolean(this.releaseSetup); }

  /** A turn cancelled mid-setup: the setup it started (`setup`, its flow) is left
   * to finish on the live child -- a multi-minute session load is not thrown away
   * with the child -- and the next turn waits for it, then starts where it ended.
   * Bounded by the setup's own idle window; close() stops waiting at once. */
  protected settleSetup(setup: Promise<unknown>): void {
    let release!: () => void;
    const settled = new Promise<void>((resolve) => { release = resolve; void setup.then(() => resolve(), () => resolve()); });
    this.releaseSetup = release;
    const settling: Promise<void> = settled.finally(() => {
      if (this.releaseSetup === release) this.releaseSetup = undefined;
      if (this.settling === settling) this.settling = undefined;
    });
    this.settling = settling;
  }

  /** Children this session let go of itself: their exit is not the current turn's failure. */
  private readonly dropped = new WeakSet<object>();

  protected dropLive(error: Error): void {
    const live = this.live;
    if (!live) return;
    this.live = undefined;
    this.dropped.add(live);
    this.finishBackground('closed');
    this.clearPending();
    this.closePrompts();
    live.peer.rejectPending(error);
    void live.peer.shutdown();
  }

  /** Why a turn failed when its child closed under it. */
  protected closedTurnError(_turn: T, error: Error): Error {
    return error;
  }

  /** Whether liveFor(`key`) would reuse the running child rather than spawn one. */
  protected reusable(key: string): boolean {
    return Boolean(this.live && !this.live.peer.closed && this.live.key === key);
  }

  /** The live child for `key`, spawning one (and dropping the old one with
   * `restarted`) when there is none or its key changed. */
  protected liveFor(key: string, restarted: string, launch: {
    binary: string; argv: readonly string[]; cwd: string; environment?: Readonly<Record<string, string>>;
    peer: Omit<JsonRpcPeerOptions, 'detached' | 'onClose'>;
  }, fields: Omit<L, 'peer' | 'key'>): L {
    if (this.live && this.reusable(key)) {
      markTurn('spawned', { reused: true, transport: this.label });
      return this.live;
    }
    if (this.live) this.dropLive(new Error(restarted));
    const detached = process.platform !== 'win32';
    const child = this.spawn(launch.binary, launch.argv, {
      cwd: launch.cwd, env: { ...process.env, ...launch.environment }, stdio: ['pipe', 'pipe', 'pipe'], detached,
    });
    this.leftRunning.clear();
    lifecycle('vendor.child.spawn', { transport: this.label, child: child.pid });
    markTurn('spawned', { reused: false, transport: this.label });
    child.once('close', (code, signal) => lifecycle('vendor.child.exit', { transport: this.label, child: child.pid, code, signal }));
    const live: L = {
      ...fields,
      key,
      ...(child.pid ? { pid: child.pid } : {}),
      peer: new JsonRpcPeer(child, {
        ...launch.peer,
        detached,
        onClose: (error) => {
          this.retiredVendorGone();
          if (this.live === live) {
            this.live = undefined;
            this.finishBackground('closed');
            this.clearPending();
          }
          const turn = this.turn;
          if (turn && !turn.done && !this.dropped.has(live)) turn.fail(this.closedTurnError(turn, error));
        },
      }),
    } as L;
    this.live = live;
    return live;
  }

  /** Open a background turn (`create`) and hand it to the owner, or return
   * the one already open. Without an owner the vendor's out-of-turn work is
   * not surfaced. */
  protected openBackgroundRun(create: () => B): B | undefined {
    // Retired: what it does now is not the conversation's (retire).
    if (!this.onBackgroundTurn || this.isClosed || this.retirement) return undefined;
    // A stopped turn still unwinding: what the vendor says now is that turn's
    // tail (a chunk already on its way when the stop landed), not new work.
    // Opened as a background turn it showed "thinking" after Ctrl+C, with
    // nothing left to end it but the idle ceiling.
    if (this.settling) return undefined;
    if (this.background && !this.background.channel.done) return this.background;
    const run = create();
    this.background = run;
    try { this.onBackgroundTurn(run.channel); } catch { /* fail-open-ok: the owner's bookkeeping */ }
    return run;
  }

  protected finishBackground(ended: BackgroundTurnEnd): void {
    const run = this.background;
    if (!run) return;
    this.background = undefined;
    run.channel.finish(ended);
  }
}
