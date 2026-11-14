/** The commands each harness's own agent says it has (ACP
 * `available_commands_update`, Claude's `slash_commands`), kept per harness on
 * disk. Turns run in the session worker, so the list it hears never reached
 * the window's `/` menu, and nothing at all was known before a chat's first
 * turn. The worker writes it here; every window reads it for the harness a
 * chat is on. */

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFile } from '../session/store/files.js';
import { stateDirectory } from '../session/store/paths.js';
import { quiet } from '../runtime/lifecycle-log.js';
import type { HarnessAvailableCommand } from '../harness/events/turn-observer.js';

interface Kept { v: 1; harnesses: Record<string, { at: string; commands: HarnessAvailableCommand[] }> }

const file = (): string => join(stateDirectory(), 'cache', 'vendor-commands.json');

let read: { path: string; mtime: number; data: Kept } | undefined;

function load(): Kept {
  const path = file();
  try {
    const mtime = statSync(path).mtimeMs;
    if (read?.path === path && read.mtime === mtime) return read.data;
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Kept;
    const data: Kept = parsed?.v === 1 && parsed.harnesses && typeof parsed.harnesses === 'object' ? parsed : { v: 1, harnesses: {} };
    read = { path, mtime, data };
    return data;
  } catch { return { v: 1, harnesses: {} }; } // fail-open-ok: no file yet, or a damaged one, is no list
}

/** The commands `harness` last said it has; empty when it never said. */
export function knownVendorCommands(harness: string | undefined): readonly HarnessAvailableCommand[] {
  return harness ? load().harnesses[harness]?.commands ?? [] : [];
}

const same = (left: readonly HarnessAvailableCommand[], right: readonly HarnessAvailableCommand[]): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

let writing: Promise<void> = Promise.resolve();

/** Keeps what `harness` just said it has, for every window. Written only when it changed. */
export function rememberVendorCommands(harness: string | undefined, commands: readonly HarnessAvailableCommand[]): Promise<void> {
  if (!harness || !commands.length) return writing;
  writing = writing.then(async () => {
    const data = load();
    if (same(data.harnesses[harness]?.commands ?? [], commands)) return;
    const next: Kept = { v: 1, harnesses: { ...data.harnesses, [harness]: { at: new Date().toISOString(), commands: commands.map((command) => ({ ...command })) } } };
    await atomicWriteFile(file(), `${JSON.stringify(next)}\n`);
    read = undefined;
  }).catch(quiet('turn/vendor-commands'));
  return writing;
}
