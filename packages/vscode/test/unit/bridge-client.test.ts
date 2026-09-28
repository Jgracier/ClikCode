import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeClient, bridgeEnvironment } from '../../src/bridge-client';
import type { IdeEvent } from '../../src/protocol';

/** A stand-in bridge speaking the real message shapes over the IPC channel. */
const FAKE = `
if (process.argv[2] !== 'ide-bridge') process.exit(2);
console.log('stray stdout line');
process.send({ type: 'ready', version: 'test', pid: process.pid });
process.on('message', (m) => {
  if (m.type === 'open') process.send({ type: 'result', requestId: m.requestId, ok: true, data: { sessionId: 's' } });
  if (m.type === 'query') process.send({ type: 'result', requestId: m.requestId, ok: false, error: 'nope' });
  if (m.type === 'send') process.send({ type: 'something-new', text: m.text });
  if (m.type === 'close') process.exit(0);
});
`;

describe('BridgeClient', () => {
  it('starts the bridge with IPC, answers calls, passes unknown events through, and logs stdout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clikcode-fake-bridge-'));
    const entry = join(dir, 'index.js');
    writeFileSync(entry, FAKE);
    const client = BridgeClient.start({ node: process.execPath, env: {}, entry, nodeSource: 'path' }, dir);
    const events: IdeEvent[] = [];
    const logs: string[] = [];
    client.on('log', (line) => logs.push(line));
    const ready = new Promise<void>((resolve) => client.on('event', (event) => { events.push(event); if (event.type === 'ready') resolve(); }));
    await ready;
    await expect(client.call({ type: 'open', workspace: dir, mode: 'new' })).resolves.toEqual({ sessionId: 's' });
    await expect(client.call({ type: 'query', query: 'slash-commands' })).rejects.toThrow('nope');
    const unknown = new Promise<IdeEvent>((resolve) => client.on('event', (event) => { if ((event.type as string) === 'something-new') resolve(event); }));
    client.send({ type: 'send', text: 'hello' });
    expect(await unknown).toEqual({ type: 'something-new', text: 'hello' });
    const exited = new Promise((resolve) => client.on('exit', resolve));
    client.dispose();
    await exited;
    expect(client.running).toBe(false);
    expect(logs).toContain('stray stdout line');
    expect(client.build).toMatch(/^\d+:\d+$/);
  });
});

describe('the bridge environment', () => {
  it('passes ELECTRON_RUN_AS_NODE only when the runtime sets it, never from the extension host', () => {
    const host = { PATH: '/bin', ELECTRON_RUN_AS_NODE: '1' };
    expect(bridgeEnvironment(host, {})).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
    expect(bridgeEnvironment(host, {}).PATH).toBe('/bin');
    expect(bridgeEnvironment({ PATH: '/bin' }, { ELECTRON_RUN_AS_NODE: '1' }).ELECTRON_RUN_AS_NODE).toBe('1');
    expect(bridgeEnvironment({}, {})).toMatchObject({ CLIKCODE_OUTPUT_MODE: 'json', NO_COLOR: '1' });
  });
});
