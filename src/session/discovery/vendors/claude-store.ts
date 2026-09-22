/** Claude Code: `<CLAUDE_CONFIG_DIR>/projects/<cwd-as-name>/<id>.jsonl`.
 *
 * Project-scoped, so the same id under a different workspace is a different
 * file -- which is why locate() takes the workspace and tries every name the
 * cwd can produce (see claudeProjectDirectoryNames). Moved here verbatim from
 * an if-chain in locations.ts; the behaviour is unchanged. */

import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { nativeDataRoot, type NativeSessionEnvironment, type NativeSessionFile, type NativeSessionStore } from '../stores.js';
import { claudeProjectDirectoryNames } from './claude.js';

export const claudeSessionStore: NativeSessionStore = {
  root(environment: NativeSessionEnvironment): string {
    return join(nativeDataRoot(environment, 'CLAUDE_CONFIG_DIR', join(homedir(), '.claude')), 'projects');
  },
  async locate(root: string, nativeId: string, workspace: string): Promise<NativeSessionFile | undefined> {
    for (const name of claudeProjectDirectoryNames(workspace)) {
      const path = join(root, name, `${nativeId}.jsonl`);
      if (await stat(path).then(() => true, () => false)) return { path, root };
    }
    return undefined;
  },
};
