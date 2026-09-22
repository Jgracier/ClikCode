/** Codex: `<CODEX_HOME>/sessions/<y>/<m>/<d>/rollout-<timestamp>-<id>.jsonl`.
 *
 * Date-partitioned, and the filename carries a timestamp the caller does not
 * know, so finding it is a search rather than a join -- locateCodexRollout
 * owns that. Moved here verbatim from an if-chain in locations.ts. */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { nativeDataRoot, type NativeSessionEnvironment, type NativeSessionFile, type NativeSessionStore } from '../stores.js';
import { locateCodexRollout } from './codex.js';

export const codexSessionStore: NativeSessionStore = {
  root(environment: NativeSessionEnvironment): string {
    return join(nativeDataRoot(environment, 'CODEX_HOME', join(homedir(), '.codex')), 'sessions');
  },
  async locate(root: string, nativeId: string): Promise<NativeSessionFile | undefined> {
    const path = await locateCodexRollout(root, nativeId);
    return path ? { path, root } : undefined;
  },
};
