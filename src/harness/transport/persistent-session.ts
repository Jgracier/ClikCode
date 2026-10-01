/** The lifecycle the persistent JSON-RPC transports (ACP, Codex app-server)
 * share: one child kept alive across turns, one active turn at a time raced
 * against its failure, a polite cancel that settles before the child is
 * killed, and background turns for work the vendor does between ours. What
 * a turn says and how it is cancelled stay with each transport. */
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { isTurnCancelled, turnCancelledError } from '../../agent/cancellation.js';
import { spawnPortable } from './spawn.js';
import { JsonRpcPeer, type JsonRpcPeerOptions } from './jsonrpc-peer.js';
import type { BackgroundTurnChannel, BackgroundTurnEnd, VendorBackgroundTurnHandler } from './background-turn.js';
import { createTurnWatchdog, type TurnWatchdog } from './turn-watchdog.js';

/** How long a cancelled turn gets to unwind before its child is killed. */
export const CANCEL_SETTLE_MS = 2000;

type PersistentSpawn = (binary: string, argv: readonly string[], options: SpawnOptions) => ChildProcess;

export interface PersistentSessionOptions {
  spawn?: PersistentSpawn;
  /** Receives work the vendor does between ClikCode turns. */
  backgroundTurns?: VendorBackgroundTurnHandler;
  /** Watchdog budgets (see turn-watchdog.ts); tests shorten them. */
  idleMs?: number;
  toolIdleMs?: number;
}

interface PersistentLive { peer: JsonRpcPeer; key: string }
interface PersistentTurn { done: boolean; fail: (error: Error) => void; watchdog?: TurnWatchdog }
interface PersistentBackground { channel: BackgroundTurnChannel; watchdog?: TurnWatchdog }

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
  private readonly idleMs?: number;
  private readonly toolIdleMs?: number;

  constructor(options: PersistentSessionOptions, private readonly label: string) {
    this.spawn = options.spawn ?? ((binary, argv, spawnOptions) => spawnPortable(binary, [...argv], spawnOptions));
    this.onBackgroundTurn = options.backgroundTurns;
    this.idleMs = options.idleMs;
    this.toolIdleMs = options.toolIdleMs;
  }

  /** Forget the vendor work being tracked as still running. */
  protected abstract clearPending(): void;
  /** Ask the vendor to stop `turn`, settling `this.settling` (settleCancel);
   * false when the turn has not reached the point it can be asked. */
  protected abstract interrupt(turn: T, live: L): boolean;

  cancel(): void {
    if (this.turn) this.cancelTurn(this.turn);
  }

  async close(): Promise<void> {
    this.isClosed = true;
    if (this.turn) this.cancelTurn(this.turn);
    this.finishBackground('closed');
    this.clearPending();
    if (this.settling) await this.settling;
    const live = this.live;
    this.live = undefined;
    if (!live) return;
    live.peer.rejectPending(new Error(`${this.label} session closed`));
    await live.peer.shutdown();
  }

  /** Throws unless a turn may start now. `name` labels the errors. */
  protected assertIdle(name: string): void {
    if (this.isClosed) throw new Error(`${name} session is closed`);
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
    const onAbort = (): void => this.cancelTurn(turn);
    signal?.addEventListener('abort', onAbort, { once: true });
    let succeeded = false;
    try {
      if (this.settling) await this.settling;
      if (signal?.aborted) throw turnCancelledError();
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
      turn.watchdog?.stop();
      signal?.removeEventListener('abort', onAbort);
      if (this.turn === turn) this.turn = undefined;
      hooks.ended(succeeded);
    }
  }

  protected cancelTurn(turn: T): void {
    if (turn.done) return;
    turn.done = true;
    const live = this.live;
    // Mid-setup there is nothing to cancel politely.
    if (live && !this.interrupt(turn, live)) this.dropLive(turnCancelledError());
    turn.fail(turnCancelledError());
  }

  /** Wait up to CANCEL_SETTLE_MS for `wait` to report the cancelled turn
   * settled, so the session stays resumable; then kill the child. */
  protected settleCancel(live: L, wait: (settled: () => void) => void, onTimeout?: () => void): void {
    this.settling = new Promise<void>((resolve) => {
      const timer = setTimeout(() => { onTimeout?.(); if (this.live === live) this.dropLive(turnCancelledError()); resolve(); }, CANCEL_SETTLE_MS);
      wait(() => { clearTimeout(timer); resolve(); });
    }).finally(() => { this.settling = undefined; });
  }

  protected dropLive(error: Error): void {
    const live = this.live;
    if (!live) return;
    this.live = undefined;
    this.finishBackground('closed');
    this.clearPending();
    live.peer.rejectPending(error);
    void live.peer.shutdown();
  }

  /** Why a turn failed when its child closed under it. */
  protected closedTurnError(_turn: T, error: Error): Error {
    return error;
  }

  /** The live child for `key`, spawning one (and dropping the old one with
   * `restarted`) when there is none or its key changed. */
  protected liveFor(key: string, restarted: string, launch: {
    binary: string; argv: readonly string[]; cwd: string; environment?: Readonly<Record<string, string>>;
    peer: Omit<JsonRpcPeerOptions, 'detached' | 'onClose'>;
  }, fields: Omit<L, 'peer' | 'key'>): L {
    if (this.live && !this.live.peer.closed && this.live.key === key) return this.live;
    if (this.live) this.dropLive(new Error(restarted));
    const detached = process.platform !== 'win32';
    const child = this.spawn(launch.binary, launch.argv, {
      cwd: launch.cwd, env: { ...process.env, ...launch.environment }, stdio: ['pipe', 'pipe', 'pipe'], detached,
    });
    const live: L = {
      ...fields,
      key,
      peer: new JsonRpcPeer(child, {
        ...launch.peer,
        detached,
        onClose: (error) => {
          if (this.live === live) {
            this.live = undefined;
            this.finishBackground('closed');
            this.clearPending();
          }
          const turn = this.turn;
          if (turn && !turn.done) turn.fail(this.closedTurnError(turn, error));
        },
      }),
    } as L;
    this.live = live;
    return live;
  }

  protected watchdog(onIdle: (afterMs: number) => void): TurnWatchdog {
    return createTurnWatchdog({
      ...(this.idleMs !== undefined ? { idleMs: this.idleMs } : {}),
      ...(this.toolIdleMs !== undefined ? { toolIdleMs: this.toolIdleMs } : {}),
      onIdle,
    });
  }

  /** Open a background turn (`create`) and hand it to the owner, or return
   * the one already open. Without an owner the vendor's out-of-turn work is
   * not surfaced. `prime` readies its watchdog before the owner sees it. */
  protected openBackgroundRun(create: () => B, prime?: (watchdog: TurnWatchdog) => void): B | undefined {
    if (!this.onBackgroundTurn || this.isClosed) return undefined;
    if (this.background && !this.background.channel.done) return this.background;
    const run = create();
    const watchdog = this.watchdog(() => {
      if (this.background !== run) return;
      // The ceiling ends the background turn, not the child: whatever is
      // still running can report into the next turn.
      this.clearPending();
      this.finishBackground('idle-timeout');
    });
    run.watchdog = watchdog;
    prime?.(watchdog);
    this.background = run;
    try { this.onBackgroundTurn(run.channel); } catch { /* fail-open-ok: the owner's bookkeeping */ }
    return run;
  }

  protected finishBackground(ended: BackgroundTurnEnd): void {
    const run = this.background;
    if (!run) return;
    this.background = undefined;
    run.watchdog?.stop();
    run.channel.finish(ended);
  }
}
