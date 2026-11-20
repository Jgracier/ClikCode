import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { probeVendorCommands } from './vendor-commands-probe.js';
import { heldOff } from '../harness/accounts/background-outcome.js';
import { knownVendorCommands, vendorCommandsCheckedAt } from './vendor-commands.js';
import type { AiHarnessAccount, AiLocalHarnessDefinition } from '../harness/definition.js';

/** An ACP agent that, like Claude's or Copilot's, announces its commands just
 * after session/new and deletes the session it is asked to. */
const agent = (announce: boolean) => `
  const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
  let buf = '';
  process.stdin.on('data', (d) => { buf += d; let n; while ((n = buf.indexOf('\\n')) >= 0) { const m = JSON.parse(buf.slice(0, n)); buf = buf.slice(n + 1);
    if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { delete: {} } } } });
    else if (m.method === 'session/new') {
      send({ id: m.id, result: { sessionId: 's1' } });
      ${announce ? "setTimeout(() => send({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'fleet', description: 'Run a fleet' }, { name: 'share', input: { hint: '<path>' } }] } } }), 200);" : ''}
    } else if (m.id !== undefined) send({ id: m.id, result: {} });
  } });
`;
// Signed in by FAKE_COMMANDS_KEY, which the account's environment carries.
const harness = (announce: boolean, command = `fake-${announce}`) => ({ command, displayName: 'Fake', binary: process.execPath, authEnv: ['FAKE_COMMANDS_KEY'], acp: { argv: ['-e', agent(announce)] } }) as unknown as AiLocalHarnessDefinition;
const account = { id: 'acct-1', provider: 'fake', label: 'Fake', authKind: 'vendor-cli', models: [], status: 'ready' } as unknown as AiHarnessAccount;

const previous = process.env.CLIKCODE_HOME;
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'probe-')); process.env.CLIKCODE_HOME = root; process.env.FAKE_COMMANDS_KEY = 'k'; });
afterEach(async () => {
  delete process.env.FAKE_COMMANDS_KEY;
  if (previous === undefined) delete process.env.CLIKCODE_HOME; else process.env.CLIKCODE_HOME = previous;
  await rm(root, { recursive: true, force: true });
});

describe('asking a harness for its commands before a chat\'s first turn', () => {
  it('keeps what the agent announces after its session opens', async () => {
    await probeVendorCommands(harness(true), { ...account });
    expect(knownVendorCommands('fake-true')).toEqual([{ name: 'fleet', description: 'Run a fleet' }, { name: 'share', hint: '<path>' }]);
  }, 20_000);

  it('records an agent that announces none, so it is not asked at every window', async () => {
    await probeVendorCommands(harness(false), { ...account });
    expect(knownVendorCommands('fake-false')).toEqual([]);
    expect(vendorCommandsCheckedAt('fake-false')).toBeGreaterThan(0);
  }, 20_000);

  it('asks nothing under the user\'s own home for a chat with no account', async () => {
    expect(await probeVendorCommands(harness(true, 'fake-no-account'), undefined)).toBe(false);
    expect(vendorCommandsCheckedAt('fake-no-account')).toBeUndefined();
  });

  it('starts nothing for an account with no sign-in on disk, and marks it as needing one', async () => {
    delete process.env.FAKE_COMMANDS_KEY;
    const signedOut = { ...account };
    expect(await probeVendorCommands(harness(true, 'fake-signed-out'), signedOut)).toBe(false);
    expect(signedOut.status).toBe('needs_login');
    expect(vendorCommandsCheckedAt('fake-signed-out')).toBeUndefined();
  });

  it('holds off an agent that failed to answer, instead of starting it at every window', async () => {
    const broken = { ...harness(true, 'fake-broken'), acp: { argv: ['-e', 'process.exit(3)'] } } as AiLocalHarnessDefinition;
    const now = Date.now();
    expect(await probeVendorCommands(broken, { ...account }, now)).toBe(false);
    expect(await heldOff('commands:fake-broken:acct-1', now + 1_000)).toBe(true);
    expect(await heldOff('commands:fake-broken:acct-1', now + 5 * 60_000 + 1)).toBe(false);
  });
});
