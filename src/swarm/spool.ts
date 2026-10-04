/** Activity a clerk emits for the host chat. The host turn tails this file
 * and paints the rows, so a provider process and the host window stay in
 * one conversation. */

import { watch, type FSWatcher } from 'node:fs';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import type { HarnessActivityEvent } from '../harness/prompter.js';
import { swarmActivityPath } from './store.js';
import { basename, dirname } from 'node:path';

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
  // Up to the last complete line: one still being written is read whole
  // next time, not skipped and lost.
  const end = text.lastIndexOf('\n') + 1;
  if (end <= offset) return { events: [], offset };
  const events: HarnessActivityEvent[] = [];
  for (const line of text.slice(offset, end).split('\n')) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line) as HarnessActivityEvent); } catch { /* fail-open-ok: a corrupt line is not an event */ }
  }
  return { events, offset: end };
}

/** Follow the host's spool until stopped: read the moment it changes
 * (fs.watch on its directory, so a spool not created yet counts too), with
 * a slow re-read as the backstop for filesystems that do not report
 * changes. Starts at the end of the file, so a watcher that outlives a turn
 * does not replay clerks that already finished. Quiet when no clerk is
 * writing. */
export function watchSwarmActivity(
  sessionId: string, onEvent: (event: HarnessActivityEvent) => void, backstopMs = 2_000,
): () => void {
  const path = swarmActivityPath(sessionId);
  let offset = -1;
  let stopped = false;
  let reading = false;
  let again = false;
  void readFile(path, 'utf8').then(
    (text) => { offset = text.length; },
    () => { offset = 0; },
  );
  const read = (): void => {
    if (stopped || offset < 0) return;
    // One read at a time; a change during it reads again after.
    if (reading) { again = true; return; }
    reading = true;
    void readSwarmActivity(sessionId, offset).then(({ events, offset: next }) => {
      offset = next;
      if (stopped) return;
      for (const event of events) onEvent(event);
    }).catch(() => undefined).finally(() => {
      reading = false;
      if (again) { again = false; read(); }
    });
  };
  let watcher: FSWatcher | undefined;
  void mkdir(dirname(path), { recursive: true }).then(() => {
    if (stopped) return;
    try {
      watcher = watch(dirname(path), (_event, name) => { if (name === null || name.toString() === basename(path)) read(); });
      watcher.on('error', () => undefined);
      watcher.unref?.();
    } catch { /* fail-open-ok: the backstop still reads it */ }
  }, () => undefined);
  const timer = setInterval(read, backstopMs);
  timer.unref?.();
  return () => { stopped = true; clearInterval(timer); watcher?.close(); };
}
