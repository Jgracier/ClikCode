/** Taking a queued turn out of the queue once it has failed. Left at the head,
 * the queue would hand it straight back and it would fail the same way for
 * ever, so this retries a failed write and, when it still cannot, throws:
 * the caller stops running that turn and says so. */

import { readState as readStateFile } from '../session/state/read.js';
import { writeState as writeStateFile } from '../session/state/write.js';
import { consumeSessionTurn } from '../turn/checkpoint.js';
import type { HarnessState } from '../session/model.js';

export interface QueueStateIo {
  readState: (sessionId: string) => Promise<HarnessState>;
  writeState: (state: HarnessState) => Promise<void>;
}

const fileIo: QueueStateIo = { readState: (sessionId) => readStateFile({ transcripts: [sessionId] }), writeState: (state) => writeStateFile(state) };

/** `consumed`, or `gone` when it was no longer queued. Throws the last error
 * after `attempts` failed reads or writes. */
export async function consumeQueuedTurn(
  sessionId: string, queuedTurnId: string, io: QueueStateIo = fileIo, attempts = 3, backoffMs = 100,
): Promise<'consumed' | 'gone'> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const state = await io.readState(sessionId);
      const found = state.sessions.find((item) => item.id === sessionId);
      if (!found || !consumeSessionTurn(found, queuedTurnId)) return 'gone';
      await io.writeState(state);
      return 'consumed';
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolveWait) => setTimeout(resolveWait, backoffMs * attempt));
    }
  }
  throw lastError;
}
