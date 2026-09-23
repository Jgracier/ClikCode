/** Gemini CLI: `<GEMINI_CLI_HOME>/.gemini/tmp/<project>/chats/session-<when>-<short>.jsonl`.
 *
 * Project-scoped by the workspace's own directory NAME, and the filename
 * carries a timestamp plus only the first eight characters of the session id
 * -- the full id is the `sessionId` on the file's first line. Observed on
 * disk:
 *   session-2026-09-22T12-31-8ac6abf2.jsonl
 *   {"sessionId":"8ac6abf2-ff23-4cb1-ab85-170400a022f1","projectHash":...}
 *
 * So the short id narrows the candidates and the first line confirms one,
 * rather than trusting an eight-character prefix on its own. The project
 * directory is not assumed either: every project under tmp/ is searched, which
 * costs a readdir and avoids guessing how a cwd becomes a directory name.
 */

import { readdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { nativeDataRoot, type NativeSessionEnvironment, type NativeSessionFile, type NativeSessionStore } from '../stores.js';

/** The first line only: these files grow to megabytes and the id is on line 1. */
async function firstLine(path: string): Promise<string> {
  return new Promise((resolve) => {
    const stream = createReadStream(path, { encoding: 'utf8', start: 0, end: 4096 });
    let data = '';
    stream.on('data', (chunk) => { data += chunk; });
    stream.on('error', () => resolve(''));
    stream.on('close', () => resolve(data.split('\n', 1)[0] ?? ''));
  });
}

async function holdsSession(path: string, nativeId: string): Promise<boolean> {
  try { return (JSON.parse(await firstLine(path)) as { sessionId?: string }).sessionId === nativeId; } catch { return false; }
}

export const geminiSessionStore: NativeSessionStore = {
  root(environment: NativeSessionEnvironment): string {
    return join(nativeDataRoot(environment, 'GEMINI_CLI_HOME', homedir()), '.gemini', 'tmp');
  },
  async locate(root: string, nativeId: string): Promise<NativeSessionFile | undefined> {
    const short = nativeId.split('-', 1)[0];
    const projects = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const chats = join(root, project.name, 'chats');
      const files = await readdir(chats).catch(() => []);
      for (const name of files) {
        if (!name.endsWith('.jsonl') || (short && !name.includes(short))) continue;
        const path = join(chats, name);
        if (await stat(path).then(() => true, () => false) && await holdsSession(path, nativeId)) return { path, root };
      }
    }
    return undefined;
  },
};
