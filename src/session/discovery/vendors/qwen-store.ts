/** Qwen Code: `<QWEN_HOME>/projects/<cwd-as-name>/chats/<id>.jsonl`.
 *
 * Directly observed: a turn driven against an OpenAI-compatible endpoint wrote
 * `projects/-home-user-projects-app/chats/<uuid>.jsonl`, whose
 * every line carries `sessionId` equal to that uuid -- the same id ClikCode
 * stores as nativeSessionId. The lines are uuid/parentUuid/sessionId/cwd
 * records, so the format is Claude Code's; the path is not, because of the
 * extra `chats` level.
 *
 * The cwd name is Qwen's own `sanitizeCwd` -- one deterministic name, read out
 * of its bundle rather than guessed:
 *
 *   normalizedCwd.replace(/[^a-zA-Z0-9]/g, '-')   // lowercased first on win32
 *
 * so unlike Claude Code there is no second candidate name to try. Sharing
 * claudeProjectDirectoryNames here would have been wrong in exactly the cases
 * the two rules disagree, which is any cwd holding a dot or an underscore.
 *
 * `<id>.runtime.json` sits beside the transcript and is deliberately NOT
 * carried: Qwen writes it so "external observers (terminal multiplexers, IDE
 * integrations, status daemons) can scan the same directory to find LIVE
 * sessions". Copying it would announce a session running in a profile where
 * nothing is running. The transcript alone is what resume reads.
 *
 * Verified end to end: the transcript copied under a second QWEN_HOME resumed
 * there, and Qwen replayed the original user turn and assistant reply to the
 * model rather than starting a new thread.
 */

import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { nativeDataRoot, type NativeSessionEnvironment, type NativeSessionFile, type NativeSessionStore } from '../stores.js';

/** Qwen's sanitizeCwd, from packages/core/src/config/storage.ts. */
function qwenProjectDirectoryName(workspace: string): string {
  const normalized = process.platform === 'win32' ? workspace.toLowerCase() : workspace;
  return normalized.replace(/[^a-zA-Z0-9]/g, '-');
}

export const qwenSessionStore: NativeSessionStore = {
  root(environment: NativeSessionEnvironment): string {
    return join(nativeDataRoot(environment, 'QWEN_HOME', join(homedir(), '.qwen')), 'projects');
  },
  async locate(root: string, nativeId: string, workspace: string): Promise<NativeSessionFile | undefined> {
    const path = join(root, qwenProjectDirectoryName(workspace), 'chats', `${nativeId}.jsonl`);
    return await stat(path).then(() => ({ path, root }), () => undefined);
  },
};
