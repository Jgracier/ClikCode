/** What one session worker's parts share, held in one object: the conversation's
 * identity, the turn and queue flags, the timers, and the parts themselves. */
import type { OutOfTurn } from './out-of-turn.js';
import type { KeepWarm } from './cache-keepwarm.js';
import type { Server, Socket } from 'node:net';
import type Conf from 'conf';
import type { LiveTurnInputBroker } from '../turn/live-input.js';
import type { LiveSettings } from '../turn/live-settings.js';
import type { sessionState } from '../agent/session-state.js';
import type { BroadcastObserver } from './broadcast-observer.js';
import type { FrameDecoder } from './protocol.js';
import type { createResumeWaiter } from './resume-wait.js';
import type { createVendorBackgroundRunner } from './vendor-background.js';
import type { ConversationHold, currentWorkerBuild } from './registry.js';
import type { IdleControl } from './worker-idle.js';
import type { WorkerIo } from './worker-io.js';
import type { WorkerQueue } from './worker-queue.js';
import type { ClientCommand } from './protocol.js';

export interface ConnectionState {
  socket: Socket;
  frames: FrameDecoder;
  attached: boolean;
  /** The attach being answered. A command sent right behind `attach` (a
   * `retire`, a `submit`) waits for it rather than being dropped as sent by
   * a window that never attached. */
  attaching?: Promise<void>;
}

export interface WorkerContext {
  readonly sessionId: string;
  readonly config: Conf<Record<string, unknown>>;
  readonly observer: BroadcastObserver;
  readonly token: string;
  readonly hold: ConversationHold;
  readonly socketPath: string;
  /** The agent's in-process state for this conversation: its background
   * shells and their exit notifications (agent/session-state.ts). */
  readonly agentSession: ReturnType<typeof sessionState>;
  readonly connections: Map<Socket, ConnectionState>;
  /** The state directory this worker started in is gone (by identity). */
  readonly homeGone: () => boolean;
  /** The entry this process loaded. Re-stat'd while idle: a rebuild changes
   * mtime/size, and a worker nobody has reattached to would otherwise keep
   * the old code for its whole IDLE_EXIT_MS lifetime. */
  readonly spawnedBuild: ReturnType<typeof currentWorkerBuild>;

  /** Set the moment a turn is decided on (startTurn), synchronously, and
   * cleared when the turn ends: the one guard that keeps two turns from
   * ever running at once, whoever asked for them. */
  turnRunning: boolean;
  /** The queued turn the running turn is, so a second request for it -- the
   * client draining the same queue entry -- follows it instead of rerunning it. */
  activeQueuedTurnId: string | undefined;
  draining: boolean;
  /** A queued turn that failed and could not be taken out of the queue:
   * never started again, so a failing write cannot become a loop. */
  stalledQueuedTurnId: string | undefined;
  idleTimer: NodeJS.Timeout | undefined;
  /** The turn currently in flight, if any -- all cleared together when the
   * turn ends. A `cancel` with nothing running is simply a no-op. */
  activeController: AbortController | undefined;
  activeLiveInput: LiveTurnInputBroker | undefined;
  /** The settings the running turn reads; `settings-changed` writes them. */
  readonly liveSettings: LiveSettings;
  /** Messages typed during the running turn that the worker is still placing
   * (steered, or queued durably) and answering. The turn is not over for the
   * windows until each has been. */
  activeSubmissions: Set<Promise<void>> | undefined;
  /** The window whose Esc stopped the turn asking for its message back. */
  activeRestoreDraft: Socket | undefined;
  /** `submit`s accepted and not yet answered (started, queued or rejected). A
   * `cancel` that finds no turn while one is in flight is kept in
   * `pendingCancel` and applied the moment the turn starts. */
  submitsInFlight: number;
  /** A Stop that arrived before the turn it is for had started. */
  pendingCancel: { restoreDraft: Socket | undefined; askers: Set<Socket> } | undefined;
  /** The running turn's Stop has been accepted and announced (`stopping`). */
  stopAnnounced: boolean;
  /** The running turn's vendor work is over (it is only saving now): a Stop has nothing left to stop. */
  turnWorkDone?: boolean;
  /** A Stop the turn did not answer: after a while, or on a second one, it is ended by force. */
  stopEscalation?: ReturnType<typeof setTimeout>;
  forceStop?: () => void;
  /** A turn parked until the quota resets was sent from here: marks it for the turn runner. */
  resumingTurn: boolean;
  /** A newer build asked for this worker while it was busy. */
  retireWhenIdle: boolean;
  /** The last write of this worker's record: an approval's state, chained
   * so the file ends as the last state told. */
  recordWrite: Promise<void>;
  /** The conversation being got ready for its first turn (a chat that moved
   * here, worker-commands.ts `warm`): a turn waits for it, then starts on
   * the vendor it opened. */
  warming: Promise<void> | undefined;

  // The parts, assigned as they are built.
  vendorBackground: ReturnType<typeof createVendorBackgroundRunner>;
  /** What the vendor says with no turn open, streamed live and saved once said (out-of-turn.ts). */
  outOfTurn: OutOfTurn;
  resumeWaiter: ReturnType<typeof createResumeWaiter>;
  /** Keeps a large conversation's prompt cache alive for hours after its last turn (cache-keepwarm.ts). */
  keepWarm: KeepWarm;
  io: WorkerIo;
  idle: IdleControl;
  queue: WorkerQueue;
  runTurn: (command: Extract<ClientCommand, { type: 'submit' }>) => Promise<void>;
  shutdown: (reason: string) => Promise<void>;
  server: Server;
}
