/** Put an agent's temporary files on disk rather than RAM-backed /tmp.
 * The directory belongs to the conversation, so a replacement worker uses
 * the same files. ClikCode does not delete it while a detached command might
 * still be using it. */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { stateDirectory } from '../session/store/paths.js';

export function useConversationTmp(sessionId: string): string | undefined {
  const dir = join(stateDirectory(), 't', sessionId.slice(0, 8));
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { return undefined; }
  process.env.TMPDIR = dir;
  if (process.platform === 'win32') {
    process.env.TMP = dir;
    process.env.TEMP = dir;
  }
  return dir;
}
