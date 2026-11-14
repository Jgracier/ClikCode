import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { probeVendorCommands } from './vendor-commands-probe.js';
import { knownVendorCommands, vendorCommandsCheckedAt } from './vendor-commands.js';
import type { AiLocalHarnessDefinition } from '../harness/definition.js';

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
const harness = (announce: boolean) => ({ command: `fake-${announce}`, displayName: 'Fake', binary: process.execPath, acp: { argv: ['-e', agent(announce)] } }) as unknown as AiLocalHarnessDefinition;

const previous = process.env.CLIKCODE_HOME;
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'probe-')); process.env.CLIKCODE_HOME = root; });
afterEach(async () => {
  if (previous === undefined) delete process.env.CLIKCODE_HOME; else process.env.CLIKCODE_HOME = previous;
  await rm(root, { recursive: true, force: true });
});

describe('asking a harness for its commands before a chat\'s first turn', () => {
  it('keeps what the agent announces after its session opens', async () => {
    await probeVendorCommands(harness(true), undefined);
    expect(knownVendorCommands('fake-true')).toEqual([{ name: 'fleet', description: 'Run a fleet' }, { name: 'share', hint: '<path>' }]);
  }, 20_000);

  it('records an agent that announces none, so it is not asked at every window', async () => {
    await probeVendorCommands(harness(false), undefined);
    expect(knownVendorCommands('fake-false')).toEqual([]);
    expect(vendorCommandsCheckedAt('fake-false')).toBeGreaterThan(0);
  }, 20_000);
});
