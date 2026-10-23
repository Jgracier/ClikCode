/** The whole conversation as one readable file, for whatever provider takes it up.
 *
 * A provider's window is finite, so a handoff can carry only what fits. What it
 * leaves out must stay reachable, and a provider's own tools are the only
 * thing every provider has: vendors are not given ClikCode's MCP servers, so
 * "ask the conversation tools" pointed at tools that were not there. A plain
 * file in ClikCode's state directory is read by any agent's file tools or
 * grep. Written fresh at each handoff from the stored conversation, in full
 * (every request and every answer), never trimmed to fit a window. */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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
    await writeFile(path, transcriptMarkdown(session), { encoding: 'utf8', mode: 0o600 });
    return path;
  } catch {
    return undefined;
  }
}

/** The line that tells the receiving provider where the rest is. */
export function fullRecordNote(path: string): string {
  return `The complete conversation, every request and answer, is saved at ${path}. Read or search that file when something is not above.`;
}
