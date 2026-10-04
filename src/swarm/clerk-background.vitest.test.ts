/** A clerk whose vendor answers with a background task still running waits
 * for the task: closing its input at the answer would have Claude stop the
 * task, and the clerk's report would lack its result.
 *
 * Replays the real claude 2.1.281 stream in harness/transport/native/
 * fixtures/claude-background-bash (a backgrounded `sleep 12; echo
 * done-marker`, the answer, then the task's notification and Claude's
 * follow-up) through a stand-in that, as Claude does, kills its tasks when
 * its input ends. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runProviderPrompt } from './clerk.js';
import type { AiHarnessAccount, AiLocalHarnessDefinition } from '../harness/definition.js';

type Json = Record<string, unknown>;
const records = readFileSync(join(__dirname, '..', 'harness', 'transport', 'native', 'fixtures', 'claude-background-bash.jsonl'), 'utf8')
  .split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line) as Json);
const firstResult = records.findIndex((record) => record.type === 'result') + 1;
const taskId = records.find((record) => record.subtype === 'task_started')?.task_id as string;

const stand = (delayMs: number): string => {
  const head = records.slice(0, firstResult).map((record) => JSON.stringify(record));
  const tail = records.slice(firstResult).map((record) => JSON.stringify(record));
  return `
    const head = ${JSON.stringify(head)}, tail = ${JSON.stringify(tail)};
    let started = false, closed = false, delivered = false;
    process.stdin.on('data', () => { if (started) return; started = true; head.forEach((l) => console.log(l));
      setTimeout(() => { if (closed) return; delivered = true; tail.forEach((l) => console.log(l)); }, ${delayMs}); });
    process.stdin.on('end', () => { closed = true;
      if (!delivered) console.log(JSON.stringify({ type: 'system', subtype: 'task_notification', task_id: ${JSON.stringify(taskId)}, status: 'killed' }));
      setTimeout(() => process.exit(0), 20); });
    process.stdin.resume();`;
};

describe('a clerk whose vendor leaves a background task running', () => {
  it('waits for the task, and reports what came of it', async () => {
    const harness = {
      command: 'claude', provider: 'anthropic', displayName: 'Stand-in Claude', binary: process.execPath, parser: 'claude-stream-json',
      localAuth: ['vendor-cli'], surface: 'terminal', transport: 'structured-cli', integration: 'structured',
      turn: { startArgv: ['-e', stand(600)], promptInput: 'stdin', stdinFormat: 'stream-json', output: 'json-lines', responseFields: ['result'] },
    } as unknown as AiLocalHarnessDefinition;
    const account = { id: 'a', provider: 'anthropic', label: 'test', authKind: 'vendor-cli', models: [], status: 'ready', credentialRef: 'native:claude' } as unknown as AiHarnessAccount;
    const text = await runProviderPrompt({ harness, account, prompt: 'run the build in the background' });
    expect(text).toContain('done-marker');
  }, 20_000);
});
