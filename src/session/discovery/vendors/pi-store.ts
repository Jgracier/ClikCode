/** Pi: `<PI_CODING_AGENT_DIR>/sessions/**\/<id>.jsonl`, or `~/.pi/agent/sessions`
 *  when the profile variable is unset.
 *
 *  The filename IS the session id, nested under a project directory whose
 *  escaping scheme discoverPiFsSessions deliberately does not assume -- it
 *  walks instead, and so does this, for the same reason. */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { walkFilesRecursive } from '../files.js';
import { type NativeSessionEnvironment, type NativeSessionFile, type NativeSessionStore } from '../stores.js';

export const piSessionStore: NativeSessionStore = {
  root(environment: NativeSessionEnvironment): string {
    const configured = environment.PI_CODING_AGENT_DIR?.trim();
    return configured ? join(configured, 'sessions') : join(homedir(), '.pi', 'agent', 'sessions');
  },
  async locate(root: string, nativeId: string): Promise<NativeSessionFile | undefined> {
    const wanted = `${nativeId}.jsonl`;
    for (const path of await walkFilesRecursive(root, 3, '.jsonl').catch(() => [])) {
      if (path.endsWith(`/${wanted}`)) return { path, root };
    }
    return undefined;
  },
};
