/** One worker on the machine runs the guards that watch the machine, not a
 * conversation: the memory guard (resource-guard.ts) and the state sweep
 * (state-sweep.ts). Every worker used to run its own copy, idle or not, for
 * as long as it lived -- a memory sample every 2 s per worker (on macOS a
 * `sysctl` spawned per tick), of which only one ever acted, and a scan of
 * every process's open files per sweep.
 *
 * The role is a lease (session/store/locks.ts tryLease) in the workers
 * directory: the first worker to take it is the guardian, and when it exits
 * or stalls another takes it at its next look. */
import { connect } from 'node:net';
import { join } from 'node:path';
import { lifecycle, quiet } from '../runtime/lifecycle-log.js';
import { tryLease, type Lease } from '../session/store/locks.js';
import { encodeFrame, type ClientCommand } from './protocol.js';
import { liveWorkerRecords, workersDirectory } from './registry.js';

/** How often a worker that is not the guardian looks whether the role is
 * free, and the guardian checks it still holds it. */
const GUARDIAN_CHECK_MS = 10_000;

function guardianLeasePath(): string {
  return join(workersDirectory(), 'guardian.lease');
}

interface GuardianOptions {
  /** Starts the machine-wide guards; returns what stops them. */
  guard: () => () => void;
  lockPath?: string;
  checkMs?: number;
}

/** Takes the guardian role when it is free, and runs `guard` for as long as
 * it is held. Returns what stops it (the lease is released). */
export function startGuardian(options: GuardianOptions): () => Promise<void> {
  const lockPath = options.lockPath ?? guardianLeasePath();
  let lease: Lease | undefined;
  let stopGuards: (() => void) | undefined;
  let checking = false;
  let stopped = false;
  const check = async (): Promise<void> => {
    if (checking || stopped) return;
    checking = true;
    try {
      if (lease) {
        if (await lease.held()) return;
        // Judged stale (this process stalled) and taken: the other one guards now.
        lifecycle('worker.guardian', { held: false });
        stopGuards?.();
        stopGuards = undefined;
        lease = undefined;
        return;
      }
      const taken = await tryLease(lockPath);
      if (!taken) return;
      if (stopped) { await taken.release(); return; }
      lease = taken;
      lifecycle('worker.guardian', { held: true });
      stopGuards = options.guard();
    } finally {
      checking = false;
    }
  };
  void check().catch(quiet('worker/guardian'));
  const timer = setInterval(() => { void check().catch(quiet('worker/guardian')); }, options.checkMs ?? GUARDIAN_CHECK_MS);
  timer.unref();
  return async () => {
    stopped = true;
    clearInterval(timer);
    stopGuards?.();
    stopGuards = undefined;
    await lease?.release();
    lease = undefined;
  };
}

/** A note the guardian's memory guard has for another worker's conversation:
 * sent to that worker, which delivers it as its own (resource-note-delivery.ts).
 * A worker that is gone has no conversation to tell. */
export async function sendResourceNote(workerPid: number, note: string): Promise<void> {
  const record = (await liveWorkerRecords()).find((item) => item.pid === workerPid);
  if (!record) return;
  await new Promise<void>((resolveSent) => {
    const socket = connect(record.socketPath);
    const done = (): void => { clearTimeout(timer); socket.destroy(); resolveSent(); };
    const timer = setTimeout(done, 2_000);
    socket.on('connect', () => { socket.end(encodeFrame({ type: 'resource-note', token: record.token, note } satisfies ClientCommand)); });
    socket.on('close', done);
    socket.on('error', done);
  });
}
