import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { currentConversationSession, workerSessionFromArgv } from './current-session.js';

const run = promisify(execFile);
const moduleUrl = pathToFileURL(fileURLToPath(new URL('./current-session.ts', import.meta.url))).href;

/** A stand-in `session-worker <id>` that spawns a helper (as a vendor's MCP
 * server would be) with CLIKCODE_SESSION_ID stripped, and prints what the
 * helper finds. */
async function helperUnderWorker(id: string): Promise<string> {
  const helper = `import(${JSON.stringify(moduleUrl)}).then((m) => process.stdout.write(String(m.currentConversationSession({}))))`;
  const worker = `const { execFileSync } = require('node:child_process'); const env = { ...process.env }; delete env.CLIKCODE_SESSION_ID; process.stdout.write(execFileSync(process.execPath, ['-e', ${JSON.stringify(helper)}], { env }))`;
  const { stdout } = await run(process.execPath, ['-e', worker, 'session-worker', id], { timeout: 15_000 });
  return stdout;
}

describe('currentConversationSession', () => {
  it('reads a session-worker argv', () => {
    expect(workerSessionFromArgv(['/usr/bin/node', '/x/clikcode', 'session-worker', 'abc-123'])).toBe('abc-123');
    expect(workerSessionFromArgv(['/usr/bin/node', '/x/clikcode', 'session-worker', '--flag'])).toBeUndefined();
    expect(workerSessionFromArgv(['/usr/bin/node', '/x/clikcode', 'chat'])).toBeUndefined();
  });

  it('prefers the named session', () => {
    expect(currentConversationSession({ CLIKCODE_SESSION_ID: ' chat-a ' })).toBe('chat-a');
  });

  it.skipIf(process.platform === 'win32')('gives two concurrent conversations each their own id, from ancestry alone', async () => {
    const [a, b] = await Promise.all([helperUnderWorker('chat-a'), helperUnderWorker('chat-b')]);
    expect(a).toBe('chat-a');
    expect(b).toBe('chat-b');
  }, 30_000);
});
