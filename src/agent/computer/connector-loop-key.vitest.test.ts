import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callWithLoopKey, connectorLoopKey, CONNECTOR_LOOP_TOOLS, forgetConnectorLoopKey, keyHash, prepareConnectorLoopKey } from './connector-loop-key.js';
import { unwrapTool } from './connector-runner-live.js';
import { scrubSecrets } from './secret-scrubber.js';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'clikcode-loop-key-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); });

const LOOP = { key: `cd_live_${'d'.repeat(64)}`, platform: 'https://platform.test' };

function fakeFetch(status: number, body: unknown, seen: Array<{ url: string; init: RequestInit }> = []): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
}
const answer = (payload: unknown, isError = false) => ({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(payload) }], ...(isError ? { isError } : {}) } });

describe('the connector loop key in the vault', () => {
  it('prepare saves a fresh key encrypted and returns only its SHA-256; it reads back and forgets', async () => {
    expect(await connectorLoopKey(dir)).toBeUndefined();
    const { keyHash: hash } = await prepareConnectorLoopKey(dir, 'https://platform.test');
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    const loop = await connectorLoopKey(dir);
    expect(loop?.platform).toBe('https://platform.test');
    expect(loop?.key).toMatch(/^cd_live_[a-f0-9]{64}$/);
    expect(keyHash(loop!.key)).toBe(hash);
    // Never in the clear on disk.
    const files = await readdir(join(dir, 'computer', 'vault', 'secrets'));
    for (const file of files) expect(await readFile(join(dir, 'computer', 'vault', 'secrets', file), 'utf8')).not.toContain(loop!.key);
    // And scrubbed from anything that would reach a model or a log.
    expect(scrubSecrets(`key ${loop!.key}`)).not.toContain(loop!.key);
    expect(await forgetConnectorLoopKey(dir)).toBe(true);
    expect(await connectorLoopKey(dir)).toBeUndefined();
  });

  it('a second prepare replaces the key (one key, rotated)', async () => {
    const first = await prepareConnectorLoopKey(dir, 'https://platform.test');
    const second = await prepareConnectorLoopKey(dir, 'https://platform.test');
    expect(second.keyHash).not.toBe(first.keyHash);
    expect(keyHash((await connectorLoopKey(dir))!.key)).toBe(second.keyHash);
  });
});

describe('callWithLoopKey', () => {
  it('calls /mcp tools/call with the loop key as bearer, confirm set, no authenticator header; answers like `tools run`', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const text = await callWithLoopKey(LOOP, 'connector_work_claim', { worker: 'cc-runner' }, { fetchImpl: fakeFetch(200, answer({ success: true, data: { id: 'acme' } }), seen) });
    expect(seen[0]!.url).toBe('https://platform.test/mcp');
    const headers = seen[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${LOOP.key}`);
    expect(Object.keys(headers).map(h => h.toLowerCase())).not.toContain('x-admin-mfa');
    expect(JSON.parse(String(seen[0]!.init.body))).toMatchObject({ method: 'tools/call', params: { name: 'call_tool', arguments: { name: 'connector_work_claim', arguments: { worker: 'cc-runner', confirm: true } } } });
    expect(unwrapTool(text)).toEqual({ id: 'acme' });
    expect(text).not.toContain(LOOP.key);
  });

  it('reads a one-shot SSE body', async () => {
    const sse = `event: message\ndata: ${JSON.stringify(answer({ success: true, data: { total: 3 } }))}\n\n`;
    expect(unwrapTool(await callWithLoopKey(LOOP, 'connector_work_overview', {}, { fetchImpl: fakeFetch(200, sse) }))).toEqual({ total: 3 });
  });

  it('a held write is still a refusal (approval-required), and a tool error keeps its code', async () => {
    const held = await callWithLoopKey(LOOP, 'connector_work_report', {}, { fetchImpl: fakeFetch(200, answer({ ok: false, approvalRequired: true, message: "This agent is in 'ask' mode" })) });
    expect(() => unwrapTool(held)).toThrow(/held this write/);
    const failed = await callWithLoopKey(LOOP, 'connector_work_note', {}, { fetchImpl: fakeFetch(200, answer({ error: true, code: 'LEASE_REQUIRED', message: 'claim it first' }, true)) });
    expect(() => unwrapTool(failed)).toThrow(/claim it first.*LEASE_REQUIRED/);
  });

  it('a revoked or expired key says so and how to fix it', async () => {
    const text = await callWithLoopKey(LOOP, 'connector_work_claim', {}, { fetchImpl: fakeFetch(401, { error: 'invalid_token' }) });
    expect(() => unwrapTool(text)).toThrow(/revoked or has expired/);
  });
});

describe('the tools the key covers', () => {
  it('are connector tools only: no secret, connection, publish or admin tool goes with it', () => {
    for (const name of CONNECTOR_LOOP_TOOLS) expect(name).toMatch(/^connector_/);
    for (const name of ['admin_platform_set_secret', 'admin_platform_save_connector_credentials', 'connect_connector', 'admin_vendor_mfa_store', 'connector_spec_publish', 'connector_spec_delete']) {
      expect(CONNECTOR_LOOP_TOOLS.has(name)).toBe(false);
    }
  });
});

describe('clikdeployToolText: which credential a call goes with', () => {
  it('a connector tool goes with the saved loop key; any other tool, or no key saved, goes through the CLI', async () => {
    const { clikdeployToolText } = await import('./connector-runner-live.js');
    const { chmod, mkdir, writeFile } = await import('node:fs/promises');
    vi.stubEnv('CLIKCODE_HOME', dir);
    await mkdir(join(dir, 'bin'));
    await writeFile(join(dir, 'bin', 'clikdeploy'), `#!/bin/sh\necho '{"status":"success","data":{"via":"cli","tool":"'"$3"'"}}'\n`);
    await chmod(join(dir, 'bin', 'clikdeploy'), 0o755);
    vi.stubEnv('PATH', `${join(dir, 'bin')}:${process.env.PATH}`);
    const calls: string[] = [];
    vi.stubGlobal('fetch', (async (url: string) => { calls.push(url); return new Response(JSON.stringify(answer({ success: true, data: { via: 'key' } })), { status: 200 }); }) as unknown as typeof fetch);
    try {
      expect(unwrapTool(await clikdeployToolText('connector_work_claim', {}))).toEqual({ via: 'cli', tool: 'connector_work_claim' });
      await prepareConnectorLoopKey(dir, 'https://platform.test');
      expect(unwrapTool(await clikdeployToolText('connector_work_claim', {}))).toEqual({ via: 'key' });
      expect(calls).toEqual(['https://platform.test/mcp']);
      expect(unwrapTool(await clikdeployToolText('admin_platform_set_secret', {}))).toEqual({ via: 'cli', tool: 'admin_platform_set_secret' });
      expect(calls).toHaveLength(1);
    } finally { vi.unstubAllGlobals(); }
  });
});
