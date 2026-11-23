import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLIKDEPLOY_CHAT_ENV, CLIKDEPLOY_CONFIG_DIR_ENV, clikDeployConnection, clikDeploySessionServer } from './clikdeploy-session.js';
import { forgetChatClikDeployKey, readChatClikDeployKey, saveChatClikDeployKey, validChatClikDeployKey } from './chat-clikdeploy-key.js';
import { ampMcpConfig, BUILT_IN_MCP_NAME, codexMcpLaunch, globalMcpServers } from '../../harness/transport/acp-mcp-servers.js';
import { nativeMcpConfig } from '../../harness/transport/native/mcp-config.js';

const URL_ = 'http://127.0.0.1:9';
const KEY = 'cdk_test_secret_key_123';
let root: string;
const saved: Record<string, string | undefined> = {};
const names = ['XDG_CONFIG_HOME', 'CLIKDEPLOY_API_URL_OVERRIDE', 'CLIKCODE_HOME', 'CLIKCODE_MCP_ENTRY', 'CLIKCODE_SESSION_ID'];

/** The servers besides ClikCode's own (acp-mcp-servers.ts), which goes to every harness. */
async function others(): Promise<Awaited<ReturnType<typeof globalMcpServers>>> {
  return (await globalMcpServers('some-harness', undefined, '/nonexistent-home')).filter((server) => server.name !== BUILT_IN_MCP_NAME);
}

async function signIn(): Promise<void> {
  await mkdir(join(root, 'config', 'clikdeploy-nodejs'), { recursive: true });
  await writeFile(join(root, 'config', 'clikdeploy-nodejs', 'config.json'), JSON.stringify({ authByUrl: { [URL_]: { apiKey: KEY } } }));
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cd-session-'));
  for (const name of names) saved[name] = process.env[name];
  process.env.XDG_CONFIG_HOME = join(root, 'config');
  process.env.CLIKDEPLOY_API_URL_OVERRIDE = URL_;
  process.env.CLIKCODE_HOME = join(root, 'state');
  process.env.CLIKCODE_MCP_ENTRY = '/opt/clikcode/index.js';
});
afterEach(async () => {
  for (const name of names) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; }
  await rm(root, { recursive: true, force: true });
});

describe('the ClikDeploy session server', () => {
  it('is left out while this machine is not signed in to ClikDeploy, without an error', async () => {
    expect(clikDeploySessionServer()).toBeUndefined();
    expect(await others()).toEqual([]);
  });

  it('goes to every harness while signed in, as a stdio proxy that names where the sign-in is, not the key', async () => {
    await signIn();
    const servers = await others();
    expect(servers).toEqual([{ name: 'clikdeploy', transport: 'stdio', command: process.execPath, args: ['/opt/clikcode/index.js', 'clikdeploy-mcp-serve'], env: expect.objectContaining({
      CLIKCODE_WORKER_PID: String(process.pid), [CLIKDEPLOY_CONFIG_DIR_ENV]: join(root, 'config', 'clikdeploy-nodejs'),
    }) }]);
    expect(JSON.stringify(servers)).not.toContain(KEY);
  });

  it('never puts the key in a vendor file, launch line or environment', async () => {
    await signIn();
    const servers = await globalMcpServers('some-harness', undefined, '/nonexistent-home');
    expect(JSON.stringify(ampMcpConfig(servers))).not.toContain(KEY);
    expect(JSON.stringify(codexMcpLaunch(servers))).not.toContain(KEY);
    const native = await nativeMcpConfig({ command: 'amp', turn: { mcpConfigArgv: ['--mcp-config'] } } as never);
    try {
      expect(native.argv[0]).toBe('--mcp-config');
      const written = await readFile(native.argv[1]!, 'utf8');
      expect(written).toContain('clikdeploy-mcp-serve');
      expect(written).not.toContain(KEY);
    } finally { await native.dispose(); }
  });

  it('steps aside for a server the user recorded under the same name', async () => {
    await signIn();
    await mkdir(join(root, 'state'), { recursive: true });
    await writeFile(join(root, 'state', 'mcp.json'), JSON.stringify({ mcpServers: { clikdeploy: { command: 'mine', args: [] } } }));
    expect(await others()).toEqual([{ name: 'clikdeploy', transport: 'stdio', command: 'mine', args: [], env: {} }]);
  });
});

describe('a ClikDeploy key handed to one chat (the canvas turn running on this machine)', () => {
  const HANDED = { url: 'https://clikdeploy.example', key: 'cdk_canvas_turn_key' };

  it('only keeps an https (or loopback) URL and a key, and refuses a chat id that is not one', () => {
    expect(validChatClikDeployKey({ url: 'https://a.example/', key: ' k ' })).toEqual({ url: 'https://a.example', key: 'k' });
    expect(validChatClikDeployKey({ url: 'http://a.example', key: 'k' })).toBeUndefined();
    expect(validChatClikDeployKey({ url: 'http://127.0.0.1:3000', key: 'k' })).toBeDefined();
    expect(validChatClikDeployKey({ url: 'https://a.example', key: '' })).toBeUndefined();
    expect(() => saveChatClikDeployKey('../escape', HANDED)).toThrow();
  });

  it('gives a chat ClikDeploy tools on a machine never signed in, running as the handed key', async () => {
    saveChatClikDeployKey('chat-1', HANDED);
    process.env.CLIKCODE_SESSION_ID = 'chat-1';
    const spec = clikDeploySessionServer();
    expect((spec as { env?: Record<string, string> } | undefined)?.env?.[CLIKDEPLOY_CHAT_ENV]).toBe('chat-1');
    // The key never goes in the spec (it is copied into vendor command lines).
    expect(JSON.stringify(spec)).not.toContain(HANDED.key);
    const connection = clikDeployConnection({ ...process.env, [CLIKDEPLOY_CHAT_ENV]: 'chat-1' });
    expect(connection).toMatchObject({ url: HANDED.url, key: HANDED.key, chat: true });
  });

  it('wins over the machine sign-in for that chat only; other chats keep the machine sign-in', async () => {
    await signIn();
    saveChatClikDeployKey('chat-2', HANDED);
    expect(clikDeployConnection({ ...process.env, [CLIKDEPLOY_CHAT_ENV]: 'chat-2' }).key).toBe(HANDED.key);
    const machine = clikDeployConnection({ ...process.env, [CLIKDEPLOY_CHAT_ENV]: 'other-chat' });
    expect(machine.key).toBe(KEY);
    expect(machine.chat).toBeUndefined();
    forgetChatClikDeployKey('chat-2');
    expect(readChatClikDeployKey('chat-2')).toBeUndefined();
  });
});
