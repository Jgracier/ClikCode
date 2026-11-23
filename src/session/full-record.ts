/** The whole conversation as one readable file, and where a provider is told
 * to find what a handoff left out.
 *
 * A provider's window is finite, so a handoff can carry only what fits. What it
 * leaves out must stay reachable. Where the harness is given ClikCode's MCP
 * server (harness/transport/acp-mcp-servers.ts: ACP, Codex's app-server, a
 * per-run MCP flag) and in ClikCode's own agent, that is the `hindsight` tool,
 * which searches this conversation by words and meaning and reads it by
 * message number. Anywhere else a provider's own tools are all it has, so the
 * note names this file, read by any agent's file tools or grep.
 *
 * The file is written either way, fresh at each handoff from the stored
 * conversation, in full (every request and every answer), never trimmed to fit
 * a window: it is also the copy session/audit.ts checks a log against, and
 * what ClikCode's read_context reads. */
import { quiet } from '../runtime/lifecycle-log.js';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { HarnessSession } from './model.js';

export function fullRecordPath(stateDir: string, sessionId: string): string {
  return join(stateDir, 'records', `${sessionId}.md`);
}

/** Writes the conversation's Markdown and returns its path; undefined when it
 * could not be written (a handoff does not fail for it). The Markdown comes
 * from the same code as `/export`, loaded here so a handoff's prompt-building
 * modules do not depend on the terminal's. */
export async function writeFullRecord(session: HarnessSession, stateDir: string): Promise<string | undefined> {
  try {
    const { transcriptMarkdown } = await import('../tui/slash/export-transcript.js');
    const path = fullRecordPath(stateDir, session.id);
    await mkdir(join(stateDir, 'records'), { recursive: true, mode: 0o700 });
    const markdown = transcriptMarkdown(session);
    await setAsideLongerRecord(path, session.id, recordTurns(markdown));
    await writeFile(path, markdown, { encoding: 'utf8', mode: 0o600 });
    return path;
  } catch {
    return undefined;
  }
}

/** How many requests a record holds: one `## You` heading each. */
export function recordTurns(markdown: string): number {
  return (markdown.match(/^## You$/gm) ?? []).length;
}

/** The record is the one copy of the conversation outside its log and the index, which is what
 * lets a log that fell behind be found out and rebuilt. A handoff from a conversation that has
 * fallen behind would write that shorter conversation over it. A longer record is moved aside
 * (records/older/<id>.<time>.md) instead, never replaced: an undo makes the conversation shorter
 * on purpose, and then the longer one is simply the one before. */
async function setAsideLongerRecord(path: string, id: string, turns: number): Promise<void> {
  const existing = await readFile(path, 'utf8').catch(quiet('session/full-record'));
  if (existing === undefined || recordTurns(existing) <= turns) return;
  const older = join(dirname(path), 'older');
  await mkdir(older, { recursive: true, mode: 0o700 });
  await rename(path, join(older, `${id}.${new Date().toISOString().replace(/[:.]/g, '-')}.md`));
}

/** Where the receiving provider reaches the rest: its hindsight tool, or the file. */
export type RecordReach = { tool: 'hindsight' } | { path: string };

/** The tool when the receiving harness has it, else the file when it was written. */
export function recordReachFor(hasHindsight: boolean, path: string | undefined): RecordReach | undefined {
  return hasHindsight ? { tool: 'hindsight' } : path ? { path } : undefined;
}

/** A few words for where the rest is, for a line that has room for no more. */
export function recordReachLabel(reach: RecordReach): string {
  return 'path' in reach ? reach.path : 'the hindsight tool';
}

/** The line that tells the receiving provider where the rest is. */
export function fullRecordNote(reach: RecordReach): string {
  if ('path' in reach) return `The complete conversation, every request and answer, is saved at ${reach.path}. Read or search that file when something is not above.`;
  return 'The complete conversation, every request and answer, is in the hindsight tool: query finds a phrase or a subject in it, from and to read messages by number. Use it when something is not above.';
}
