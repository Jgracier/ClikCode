import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeMessage, LspConnection, MessageDecoder } from './client.js';

const FAKE_SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-lsp-server.mjs');

describe('LSP base protocol framing', () => {
  it('counts bytes, not characters, in Content-Length', () => {
    const frame = encodeMessage({ jsonrpc: '2.0', method: 'x', params: { text: 'héllo ✓' } }).toString('utf8');
    const [header, body] = frame.split('\r\n\r\n');
    expect(header).toBe(`Content-Length: ${Buffer.byteLength(body!)}`);
    expect(Buffer.byteLength(body!)).toBeGreaterThan(body!.length);
  });

  it('reassembles messages cut anywhere, even inside a multi-byte character', () => {
    const frames = Buffer.concat([
      encodeMessage({ jsonrpc: '2.0', id: 1, result: 'naïve ✓' }),
      encodeMessage({ jsonrpc: '2.0', method: 'note', params: [1, 2] }),
    ]);
    const decoder = new MessageDecoder();
    const out = [];
    for (let i = 0; i < frames.length; i += 1) out.push(...decoder.push(frames.subarray(i, i + 1)));
    expect(out).toEqual([{ jsonrpc: '2.0', id: 1, result: 'naïve ✓' }, { jsonrpc: '2.0', method: 'note', params: [1, 2] }]);
  });

  it('reads extra headers and two messages in one chunk', () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 7, result: null });
    const one = `Content-Type: application/vscode-jsonrpc; charset=utf-8\r\nContent-Length: ${body.length}\r\n\r\n${body}`;
    expect(new MessageDecoder().push(Buffer.from(one + one))).toHaveLength(2);
  });
});

describe('LspConnection against a fake server', () => {
  let dir: string | undefined;
  const children: import('node:child_process').ChildProcess[] = [];
  afterEach(async () => {
    for (const child of children.splice(0)) child.kill('SIGKILL');
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  const start = (env: Record<string, string> = {}): LspConnection => {
    const child = spawn(process.execPath, [FAKE_SERVER], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    children.push(child);
    return new LspConnection(child, 'fake', [{ uri: 'file:///w', name: 'w' }]);
  };

  it('matches responses to requests over a chunked stream and answers the server\'s configuration request', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'lsp-client-'));
    const record = path.join(dir, 'config.json');
    const connection = start({ FAKE_LSP_CHUNKED: '1', FAKE_LSP_RECORD: record });
    const init = await connection.request<{ capabilities: { hoverProvider: boolean } }>('initialize', { rootUri: 'file:///w' }, 5000);
    expect(init.capabilities.hoverProvider).toBe(true);
    connection.notify('initialized', {});
    const published = new Promise<unknown>((resolve) => connection.onNotification((method, params) => { if (method === 'textDocument/publishDiagnostics') resolve(params); }));
    connection.notify('textDocument/didOpen', { textDocument: { uri: 'file:///w/a.go', languageId: 'go', version: 1, text: 'x ERROR' } });
    expect(await published).toMatchObject({ uri: 'file:///w/a.go', version: 1, diagnostics: [{ severity: 1 }] });
    await expect.poll(() => readFile(record, 'utf8').catch(() => '')).toBe('[null,null]');
    await expect(connection.request('nope', {}, 5000)).rejects.toThrow('no nope');
  });

  it('fails waiting requests when the server exits, with what it last printed', async () => {
    const child = spawn(process.execPath, ['-e', 'process.stdin.once("data", () => { console.error("boom: missing toolchain"); process.exit(3); })'], { stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(child);
    const connection = new LspConnection(child, 'broken');
    await expect(connection.request('initialize', {}, 5000)).rejects.toThrow(/broken exited with code 3: boom: missing toolchain/);
    expect(connection.closed).toBe(true);
    await expect(connection.request('x', {}, 5000)).rejects.toThrow(/exited with code 3/);
  });

  it('times out a request the server never answers', async () => {
    const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(child);
    await expect(new LspConnection(child, 'mute').request('initialize', {}, 200)).rejects.toThrow('mute did not answer initialize within 0s');
  });
});
