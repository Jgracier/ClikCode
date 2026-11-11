/** A sign-in belongs to the conversation that needs it, and runs in one window
 * showing that conversation: the worker's side (BroadcastObserver) and the
 * windows' side (trackSignIn, signInClaims) together, with windows that move
 * between conversations. */
import type { Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { BroadcastObserver } from './broadcast-observer.js';
import { signInClaims, trackSignIn } from './turn-bridge.js';
import type { ClientCommand, WorkerEvent } from './protocol.js';

/** A window attached to conversation A's worker. `showing` is whether a turn
 * view is open on A (driveWorkerTurn); `running` the sign-ins it runs. */
class Window {
  readonly tracker = { driving: false, signIns: new Set<string>() };
  readonly running = new Set<string>();
  readonly socket: Socket;
  constructor(private readonly observer: BroadcastObserver) {
    this.socket = { write: (frame: string) => { this.receive(JSON.parse(frame) as WorkerEvent); return true; } } as unknown as Socket;
    observer.attach(this.socket);
  }

  private send(command: ClientCommand): void {
    if (command.type === 'sign-in-claim') this.observer.claimSignIn(command.id, this.socket);
    if (command.type === 'sign-in-release') this.observer.releaseSignIn(command.id, this.socket);
  }

  private receive(event: WorkerEvent): void {
    // The connection's own listener first, then the turn view's (turn-bridge.ts).
    trackSignIn(this.tracker, event, (command) => this.send(command));
    if (!this.tracker.driving) return;
    if (event.type === 'sign-in-pending') this.send({ type: 'sign-in-claim', id: event.id });
    if (event.type === 'sign-in-request') this.running.add(event.id);
    if (event.type === 'request-closed') this.running.delete(event.id);
  }

  /** Opens conversation A: its turn view claims what A waits on. */
  open(): void {
    this.tracker.driving = true;
    for (const command of signInClaims(this.tracker, 'sign-in-claim')) this.send(command);
  }

  /** Moves to another conversation: what it ran is taken down and given back. */
  leave(): void {
    const release = signInClaims(this.tracker, 'sign-in-release', this.running);
    this.running.clear();
    this.tracker.driving = false;
    for (const command of release) this.send(command);
  }
}

const request = { command: 'claude', argv: ['auth', 'login'], environment: {}, name: 'Claude Code' };

describe('a sign-in across windows and conversations', () => {
  it('runs in the window that sent the turn, and in no other showing the conversation', () => {
    const observer = new BroadcastObserver();
    const sender = new Window(observer);
    const viewer = new Window(observer);
    sender.open();
    viewer.open();
    observer.noteTurnSender(sender.socket);
    void observer.signIn(request).catch(() => undefined);
    expect(sender.running.size).toBe(1);
    expect(viewer.running.size).toBe(0);
  });

  it('a window showing another conversation is not asked; opening the one that needs it shows it; answering closes it everywhere', async () => {
    const observer = new BroadcastObserver();
    const elsewhere = new Window(observer);
    const other = new Window(observer);
    // Nobody shows A when its (queued) turn needs the sign-in: nothing runs.
    const signedIn = observer.signIn(request);
    expect(elsewhere.running.size + other.running.size).toBe(0);
    elsewhere.open();
    expect([...elsewhere.running]).toHaveLength(1);
    // The second window opens A too: it is already running in the first.
    other.open();
    expect(other.running.size).toBe(0);
    observer.resolveSignIn([...elsewhere.running][0]!);
    await signedIn;
    expect(elsewhere.running.size).toBe(0);
    expect(elsewhere.tracker.signIns.size).toBe(0);
    expect(other.tracker.signIns.size).toBe(0);
  });

  // The screenshot: a window that sent a turn in A moved on to B while A's
  // sign-in waited, and the link went with it.
  it('the window that sent the turn moves to another conversation: the sign-in moves to a window showing A, and comes back to the sender on its return only if no one runs it', () => {
    const observer = new BroadcastObserver();
    const sender = new Window(observer);
    const viewer = new Window(observer);
    sender.open();
    observer.noteTurnSender(sender.socket);
    void observer.signIn(request).catch(() => undefined);
    expect(sender.running.size).toBe(1);
    sender.leave();
    expect(sender.running.size).toBe(0);
    expect(viewer.running.size).toBe(0);
    viewer.open();
    expect(viewer.running.size).toBe(1);
    sender.open();
    expect(sender.running.size).toBe(0);
    viewer.leave();
    // Released by the viewer: the sender, showing A, claims it.
    expect(sender.running.size).toBe(1);
  });

  it('the sender had already left when the sign-in was asked: it gives it back, and a window showing A runs it', () => {
    const observer = new BroadcastObserver();
    const sender = new Window(observer);
    const viewer = new Window(observer);
    observer.noteTurnSender(sender.socket);
    viewer.open();
    void observer.signIn(request).catch(() => undefined);
    expect(sender.running.size).toBe(0);
    expect(viewer.running.size).toBe(1);
  });

  it('a window that returns to the conversation shows the sign-in again while it still waits', () => {
    const observer = new BroadcastObserver();
    const window = new Window(observer);
    window.open();
    observer.noteTurnSender(window.socket);
    void observer.signIn(request).catch(() => undefined);
    const [id] = [...window.running];
    window.leave();
    window.open();
    expect([...window.running]).toEqual([id]);
  });
});
