/** Which vendors ClikCode can discover sessions for, and which of those it
 * can read a whole transcript back from. One table each, so adding a vendor
 * is one entry and not a search. */

import type { AiLocalHarnessDefinition } from '../../harness/definition.js';
import { discoverClaudeFsSessions, readClaudeFsTranscript } from './vendors/claude.js';
import { discoverCodexFsSessions, readCodexFsTranscript } from './vendors/codex.js';
import { discoverCursorFsSessions } from './vendors/cursor.js';
import { NativeSessionEnvironment } from './locations.js';
import { readOpencodeTranscript } from './vendors/opencode.js';
import { discoverPiFsSessions } from './vendors/pi.js';
import { DiscoveredNativeSession } from './discovered-session.js';
import type { NativeSessionStore } from './stores.js';
import { claudeSessionStore } from './vendors/claude-store.js';
import { codexSessionStore } from './vendors/codex-store.js';
import { antigravitySessionStore } from './vendors/antigravity-store.js';
import { geminiSessionStore } from './vendors/gemini-store.js';
import { piSessionStore } from './vendors/pi-store.js';
import { copilotSessionStore } from './vendors/copilot-store.js';
import { qwenSessionStore } from './vendors/qwen-store.js';

/** Only harnesses genuinely observed to store sessions on disk in a
 * predictable, project-scoped way get an entry here — this is deliberately
 * not a declarative catalog field like discoverArgv, because unlike a shell
 * command's argv, each vendor's own on-disk layout (path, format, title
 * source) is a real, unrelated shape with nothing left to normalize. */
export const FS_SESSION_DISCOVERY: Readonly<Record<string, (workspace: string, environment?: NativeSessionEnvironment) => Promise<DiscoveredNativeSession[]>>> = {
  claude: discoverClaudeFsSessions,
  codex: discoverCodexFsSessions,
  cursor: discoverCursorFsSessions,
  pi: discoverPiFsSessions,
};

/** Only wired for the harnesses with a confirmed, complete way to read a
 * whole past conversation back out (not just enough to title it): Claude
 * Code and Codex's own jsonl files, and opencode's real `export` command.
 * Adopting a chat from any other harness still works — its native identity
 * is real either way, and the underlying vendor thread has its own full
 * memory regardless — it just starts blank in ClikCode's own transcript view
 * until the next turn, the same as it did for every harness before this. */
export const ADOPTED_TRANSCRIPT_READERS: Readonly<Record<string, (harness: AiLocalHarnessDefinition, nativeId: string, workspace: string, environment?: NativeSessionEnvironment) => Promise<Array<{ role: 'user' | 'assistant'; content: string }>>>> = {
  claude: (_harness, nativeId, workspace, environment) => readClaudeFsTranscript(nativeId, workspace, environment),
  codex: (_harness, nativeId, workspace, environment) => readCodexFsTranscript(nativeId, workspace, environment),
  opencode: readOpencodeTranscript,
};

/** Where each vendor keeps a conversation on disk. One entry per vendor, so
 * teaching ClikCode to carry a thread across an account failover is a line
 * here plus a small module -- not an edit to two if-chains.
 *
 * Only layouts directly observed on disk are listed. A harness with no entry
 * re-seeds on failover exactly as before, which is correct rather than
 * degraded: for the fifteen harnesses that run every account against one
 * vendor home, the thread never moves and there is nothing to carry. */
export const NATIVE_SESSION_STORES: Readonly<Record<string, NativeSessionStore>> = {
  claude: claudeSessionStore,
  codex: codexSessionStore,
  antigravity: antigravitySessionStore,
  gemini: geminiSessionStore,
  pi: piSessionStore,
  copilot: copilotSessionStore,
  qwen: qwenSessionStore,
};

export function nativeSessionStore(harness: AiLocalHarnessDefinition): NativeSessionStore | undefined {
  return NATIVE_SESSION_STORES[harness.command];
}
