/** Activity a clerk emits for the host chat. The host turn tails this file
 * and paints the rows, so a provider process and the host window stay in
 * one conversation. */

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import type { HarnessActivityEvent } from '../harness/prompter.js';
import { swarmActivityPath } from './store.js';
import { dirname } from 'node:path';

export async function appendSwarmActivity(sessionId: string, event: HarnessActivityEvent): Promise<void> {
  const path = swarmActivityPath(sessionId);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(event)}\n`, 'utf8');
}

/** Lines appended since `offset`, and the offset to resume from. A missing
 * file is an idle swarm, not an error. */
export async function readSwarmActivity(sessionId: string, offset: number): Promise<{ events: HarnessActivityEvent[]; offset: number }> {
  let text = '';
  try { text = await readFile(swarmActivityPath(sessionId), 'utf8'); } catch { return { events: [], offset }; }
  if (offset > text.length) offset = 0;
  const slice = text.slice(offset);
  const events: HarnessActivityEvent[] = [];
  for (const line of slice.split('\n')) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line) as HarnessActivityEvent); } catch { /* a torn write is completed on the next poll */ }
  }
  return { events, offset: text.length };
}

/** Poll the host's spool until stopped. Starts at the end of the file, so a
 * watcher that outlives a turn does not replay clerks that already finished.
 * Quiet when no clerk is writing. */
export function watchSwarmActivity(
  sessionId: string, onEvent: (event: HarnessActivityEvent) => void, intervalMs = 200,
): () => void {
  let offset = -1;
  let stopped = false;
  void readFile(swarmActivityPath(sessionId), 'utf8').then(
    (text) => { offset = text.length; },
    () => { offset = 0; },
  );
  const poll = (): void => {
    if (stopped || offset < 0) return;
    void readSwarmActivity(sessionId, offset).then(({ events, offset: next }) => {
      offset = next;
      if (stopped) return;
      for (const event of events) onEvent(event);
    }).catch(() => undefined);
  };
  const timer = setInterval(poll, intervalMs);
  timer.unref?.();
  return () => { stopped = true; clearInterval(timer); };
}
