/** A conversation moved to another provider ("Resume in", `/<harness>`)
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
import { readState } from '../session/state/read.js';
import { writeState } from '../session/state/write.js';
import type { AiHarnessAccount } from '../harness/definition.js';
import type { HarnessSession } from '../session/model.js';
import { forceStoreSession, unforceStoreSession } from '../session/ephemeral.js';
import { leaveProvider } from '../session/native-thread.js';
import { INTERRUPTED_TURN_REQUEST } from './failover-prompt.js';
import { runSessionTurn } from './session-turn.js';
import { resumePromptForPendingTurn } from '../tui/pickers/resume-in.js';
import { NATIVE_SESSION_STORES } from '../session/discovery/registry.js';
import type { NativeSessionStore, NativeThreadWriteContext } from '../session/discovery/stores.js';
import type { CanonicalRecord } from '../session/canonical.js';

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

/** A Claude Code chat that ran out mid-turn, moved to Continue in place (as
 * moveToProvider does, without installing anything). */
async function handedOff(pendingTurn?: HarnessSession['pendingTurn'], fields: Partial<HarnessSession> = {}): Promise<string> {
  const state = await readState();
  const now = new Date().toISOString();
  const account = { id: 'cn-1', provider: 'continue', label: 'cn', authKind: 'vendor-cli', models: [], status: 'ready' } as unknown as AiHarnessAccount;
  state.accounts.push(account);
  const source: HarnessSession = {
    id: randomUUID(), conversationId: randomUUID(), route: 'local', accountId: null, provider: 'anthropic', model: null,
    nativeHarness: 'claude', nativeSessionId: randomUUID(), workspace: root,
    effort: 'medium', permissionMode: 'ask', createdAt: now, updatedAt: now, status: 'active',
    messages: [
      { role: 'user', content: 'rename the parser', attachments: [join(root, 'spec.md')] },
      { role: 'assistant', content: 'renamed it to Reader', activities: [
        { responseOffset: 0, event: { kind: 'tool-done', label: 'Edit src/parser.ts', category: 'edit', call: { name: 'Edit', input: { file_path: 'src/parser.ts' } } } },
        { responseOffset: 20, event: { kind: 'tool-error', label: '$ npm test', category: 'run', exitCode: 1, output: ['1 failing'] } },
      ] },
    ],
    ...(pendingTurn ? { pendingTurn } : {}), ...fields,
  };
  leaveProvider(source);
  Object.assign(source, { nativeHarness: 'cn', provider: 'continue', accountId: account.id, model: null });
  state.sessions.push(source);
  forceStoreSession(source.id); forced.push(source.id);
  await writeState(state);
  return source.id;
}

async function sentPrompts(): Promise<string[]> {
  return (await readFile(promptLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as string);
}

describe("the first vendor turn after a provider switch", () => {
  it('hands the new vendor the earlier conversation along with the request', async () => {
    const id = await handedOff();
    await runSessionTurn({} as never, id, 'now run the focused test');
    const [wire] = await sentPrompts();
    expect(wire).toContain('rename the parser');
    expect(wire).toContain('renamed it to Reader');
    expect(wire).toContain('now run the focused test');
    expect(wire!.indexOf('renamed it to Reader')).toBeLessThan(wire!.indexOf('now run the focused test'));
    // The transfer, not a bare replay: every request, the calls of a turn
    // that also wrote text, the files it changed, what was attached.
    expect(wire).toContain('<requests>\n1. rename the parser');
    expect(wire).toMatch(/<tool_digest>[\s\S]*edit src\/parser\.ts; run npm test \(failed, exit 1\)/);
    expect(wire).toMatch(/<touched_files>[\s\S]*- src\/parser\.ts/);
    expect(wire).toMatch(/<attachments>[\s\S]*spec\.md/);
  }, 30_000);

  it('writes the conversation as the vendor\'s own thread where a writer exists, and sends only the request', async () => {
    const writes: Array<{ record: CanonicalRecord; context: NativeThreadWriteContext }> = [];
    const stores = NATIVE_SESSION_STORES as Record<string, NativeSessionStore>;
    stores.cn = {
      root: () => join(root, 'cn-store'),
      writer: {
        testedVersions: ['1.0.0'],
        versionOk: (context) => context.version === '1.0.0',
        write: async (record, context) => { writes.push({ record, context }); return { nativeId: 'written-thread' }; },
      },
    };
    try {
      const id = await handedOff();
      await runSessionTurn({} as never, id, 'now run the focused test');
      const [wire] = await sentPrompts();
      // The request as the turn sends it (an unnamed chat also asks for a
      // title); nothing of the history is retold.
      expect(wire!.startsWith('now run the focused test')).toBe(true);
      expect(wire).not.toContain('rename the parser');
      expect(writes).toHaveLength(1);
      expect(writes[0]!.record.turns.map((turn) => turn.user)).toEqual(['rename the parser']);
      expect(writes[0]!.record.turns[0]!.tools.map((call) => call.name)).toEqual(['Edit', 'shell']);
      expect(writes[0]!.context).toMatchObject({ workspace: root, version: '1.0.0' });
      const state = await readState();
      expect(state.sessions.find((item) => item.id === id)?.nativeSessionId).toBe('written-thread');
    } finally {
      delete stores.cn;
    }
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

  it('carries the files the interrupted request had attached, not only its words', async () => {
    const notes = join(root, 'notes.txt');
    await writeFile(notes, 'the parser lives in src/read.ts');
    const pending = { prompt: 'finish the edit', response: 'changed a.ts', startedAt: '', updatedAt: '', outputStarted: true };
    const id = await handedOff(pending, { attachments: [notes] });
    await runSessionTurn({} as never, id, resumePromptForPendingTurn(pending, 'finish the edit'));
    const [wire] = await sentPrompts();
    expect(wire).toContain('the parser lives in src/read.ts');
  }, 30_000);
});
