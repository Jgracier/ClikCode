/** A conversation handed to another provider ("Resume in", `/<harness>`)
 * starts a fresh vendor thread that knows nothing of it. Its first turn is
 * the only place the earlier conversation can reach that vendor: this drives
 * that turn through a fake vendor CLI on PATH and reads the prompt it was
 * actually given. HOME, CLIKCODE_HOME and PATH are throwaway, so no real
 * vendor CLI or real home is touched. */
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { localHarnessForCommand } from '@clikcode/router/ai-local-harness';
import { readState } from '../session/state/read.js';
import { writeState } from '../session/state/write.js';
import type { AiHarnessAccount } from '../harness/definition.js';
import type { HarnessSession } from '../session/model.js';
import { forceStoreSession, unforceStoreSession } from '../session/ephemeral.js';
import { createHandoffBranch } from './handoff.js';
import { INTERRUPTED_TURN_REQUEST } from './failover-prompt.js';
import { runSessionTurn } from './session-turn.js';
import { resumePromptForPendingTurn } from '../tui/pickers/resume-in.js';

const saved = { ...process.env };
let root: string;
let promptLog: string;
const forced: string[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'clikcode-handoff-replay-'));
  const bin = join(root, 'bin');
  await mkdir(bin, { recursive: true });
  await mkdir(join(root, 'home'), { recursive: true });
  promptLog = join(root, 'prompts.jsonl');
  // Continue's `cn`: text output, the prompt after `-p`. It records what it
  // was asked and answers.
  await writeFile(join(bin, 'cn'), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('1.0.0'); process.exit(0); }
const at = args.indexOf('-p');
require('node:fs').appendFileSync(${JSON.stringify(promptLog)}, JSON.stringify(at >= 0 ? args[at + 1] : null) + '\\n');
console.log('carried on');
`);
  await chmod(join(bin, 'cn'), 0o755);
  Object.assign(process.env, { HOME: join(root, 'home'), USERPROFILE: join(root, 'home'), CLIKCODE_HOME: join(root, 'clikcode') });
  process.env.PATH = [bin, dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter);
});

afterEach(async () => {
  for (const id of forced.splice(0)) unforceStoreSession(id);
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  await rm(root, { recursive: true, force: true });
});

/** A Claude Code chat that ran out mid-turn, handed to Continue. */
async function handedOff(pendingTurn?: HarnessSession['pendingTurn']): Promise<string> {
  const state = await readState();
  const now = new Date().toISOString();
  const account = { id: 'cn-1', provider: 'continue', label: 'cn', authKind: 'vendor-cli', models: [], status: 'ready' } as unknown as AiHarnessAccount;
  state.accounts.push(account);
  const source: HarnessSession = {
    id: randomUUID(), conversationId: randomUUID(), route: 'local', accountId: null, provider: 'anthropic', model: null,
    nativeHarness: 'claude', nativeSessionId: randomUUID(), workspace: root,
    effort: 'medium', permissionMode: 'ask', accountFailover: 'never', createdAt: now, updatedAt: now, status: 'active',
    messages: [{ role: 'user', content: 'rename the parser' }, { role: 'assistant', content: 'renamed it to Reader' }],
    ...(pendingTurn ? { pendingTurn } : {}),
  };
  const branch = createHandoffBranch({
    source, target: localHarnessForCommand('cn')!, accountId: account.id, model: null,
    defaults: { effort: 'medium', permissionMode: 'ask', accountFailover: 'never' }, now,
  });
  state.sessions.push(source, branch);
  for (const id of [source.id, branch.id]) { forceStoreSession(id); forced.push(id); }
  await writeState(state);
  return branch.id;
}

async function sentPrompts(): Promise<string[]> {
  return (await readFile(promptLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as string);
}

describe("a handoff branch's first vendor turn", () => {
  it('hands the new vendor the earlier conversation along with the request', async () => {
    const id = await handedOff();
    await runSessionTurn({} as never, id, 'now run the focused test');
    const [wire] = await sentPrompts();
    expect(wire).toContain('rename the parser');
    expect(wire).toContain('renamed it to Reader');
    expect(wire).toContain('now run the focused test');
    expect(wire!.indexOf('renamed it to Reader')).toBeLessThan(wire!.indexOf('now run the focused test'));
  }, 30_000);

  it('carries an interrupted request and its partial answer into "Resume in"', async () => {
    const pending = { prompt: 'finish the edit', response: 'changed a.ts', startedAt: '', updatedAt: '', outputStarted: true };
    const id = await handedOff(pending);
    await runSessionTurn({} as never, id, resumePromptForPendingTurn(pending, 'finish the edit'));
    const [wire] = await sentPrompts();
    for (const part of ['rename the parser', 'renamed it to Reader', 'finish the edit', 'changed a.ts', INTERRUPTED_TURN_REQUEST]) {
      expect(wire).toContain(part);
    }
  }, 30_000);
});
