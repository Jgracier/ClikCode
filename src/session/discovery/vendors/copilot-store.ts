/** GitHub Copilot CLI keeps one DIRECTORY per conversation.
 *
 * `<COPILOT_HOME>/session-state/<session_id>/`, where the id is exactly the
 * one its stream reports and ClikCode already stores as nativeSessionId.
 * Directly observed: a turn driven through ClikCode minted
 * `93413ae0-a9eb-4924-b544-e2c98cdaf8dd` and wrote that directory, holding
 *
 *   events.jsonl          the transcript, append-only, one JSON event a line
 *   workspace.yaml        id, cwd, git_root, repository, branch, title
 *   vscode.metadata.json  created/modified stamps
 *   checkpoints/index.md  checkpoint table, empty until one is taken
 *   .workspace-fork.lock  left behind after the session ends, so it is
 *                         ordinary state rather than a liveness lock
 *
 * The transcript alone is not enough to resume: workspace.yaml carries the id
 * and cwd the CLI matches against. That makes this the one vendor so far whose
 * conversation is a tree rather than a file, which is why carry.ts copies an
 * artifact rather than a file.
 *
 * Not every Copilot account is redirected -- an account with no profile runs
 * against the default `~/.copilot` -- so the fallback here is load-bearing
 * rather than defensive: it is the real root for that account.
 */

import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { nativeDataRoot, type NativeSessionEnvironment, type NativeSessionFile, type NativeSessionStore } from '../stores.js';

export const copilotSessionStore: NativeSessionStore = {
  root(environment: NativeSessionEnvironment): string {
    return join(nativeDataRoot(environment, 'COPILOT_HOME', join(homedir(), '.copilot')), 'session-state');
  },
  async locate(root: string, nativeId: string): Promise<NativeSessionFile | undefined> {
    const path = join(root, nativeId);
    return await stat(path).then(
      (entry) => (entry.isDirectory() ? { path, root } : undefined),
      () => undefined,
    );
  },
};
