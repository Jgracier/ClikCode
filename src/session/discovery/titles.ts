/** Naming a conversation that the vendor never named. */

import { failoverPromptRequest } from '../../turn/failover-prompt.js';
import type { AiLocalHarnessDefinition } from '../../harness/types.js';
import { readFileSuffix } from './files.js';
import { NativeSessionEnvironment, locateNativeSessionFile } from './locations.js';

/** A short, single-line title from a chat's first real message — used both
 * here (a discovered session with no explicit title) and by ai.ts itself
 * (naming a session after its own first turn). Lives here, not ai.ts, so
 * ai.ts can depend on this module without this module depending back on it —
 * a real circular import the other way around, not just a style preference. */
export function conversationTitle(prompt: string): string {
  // A rehydration prompt is ClikCode talking to the vendor, not the user
  // talking to ClikCode. Naming a session after one produced the literal
  // title "Continue the same ClikCode conversation after an account or pro…".
  const title = (failoverPromptRequest(prompt) ?? prompt).replace(/\s+/g, ' ').trim();
  return title.length > 64 ? `${title.slice(0, 63).trimEnd()}…` : title;
}

/** The title the harness itself gave this thread, or nothing.
 *
 * Claude Code names a chat a turn or two in and writes the name into its own
 * transcript as an `ai-title` record. That is a real title -- what the
 * conversation is about -- so ClikCode uses it rather than inventing one. The
 * first-message fallback used for the /resume list deliberately does not apply
 * here: a chat with no vendor title stays unnamed and gets asked for one.
 */
export async function nativeGeneratedTitle(
  harness: AiLocalHarnessDefinition, nativeId: string | undefined, workspace: string | undefined,
  environment: NativeSessionEnvironment = {},
): Promise<string | undefined> {
  if (harness.command !== 'claude' || !nativeId || !workspace) return undefined;
  const file = await locateNativeSessionFile(harness, nativeId, workspace, environment);
  if (!file) return undefined;
  // Read the END, not the beginning. Claude writes this record a turn or two
  // in and then rewrites it as the conversation moves on, so the first copy is
  // both late and stale. Measured across real transcripts: the first record
  // sits as far as 66KB in -- well past the 8KB prefix this used to read, which
  // is why four of six transcripts here yielded no title at all -- while the
  // LAST one is always within ~19KB of the end, even in a 27MB file. A 64KB
  // tail therefore finds the newest title in bounded work whatever the size.
  const tail = await readFileSuffix(file.path, 64_000).catch(() => '');
  let latest: string | undefined;
  for (const line of tail.split('\n')) {
    if (!line.includes('ai-title')) continue;
    let record: Record<string, unknown>;
    try { record = JSON.parse(line); } catch { continue; }
    if (record.type === 'ai-title' && typeof record.aiTitle === 'string' && record.aiTitle.trim()) latest = record.aiTitle.trim();
  }
  return latest;
}
