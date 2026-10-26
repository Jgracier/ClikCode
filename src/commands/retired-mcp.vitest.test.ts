import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { answerRetiredMcp } from './retired-mcp.js';

describe('a retired ClikCode MCP server', () => {
  it('is a valid server with nothing in it', () => {
    const init = answerRetiredMcp({ id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }, 'conversations-mcp');
    expect(init).toMatchObject({ id: 1, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'conversations-mcp' } } });
    expect(answerRetiredMcp({ id: 2, method: 'tools/list' }, 'swarm-mcp')).toMatchObject({ result: { tools: [] } });
    expect(answerRetiredMcp({ id: 3, method: 'ping' }, 'swarm-mcp')).toMatchObject({ result: {} });
    // A notification wants no answer, and an unknown request gets the protocol's own refusal.
    expect(answerRetiredMcp({ method: 'notifications/initialized' }, 'swarm-mcp')).toBeUndefined();
    expect(answerRetiredMcp({ id: 4, method: 'tools/call' }, 'swarm-mcp')).toMatchObject({ error: { code: -32601 } });
  });

  const entry = join(process.cwd(), 'dist', 'index.js');
  it.skipIf(!existsSync(entry))('answers over stdio and exits 0 when the vendor closes it, and names its launcher in the log', async () => {
    const home = await mkdtemp(join(tmpdir(), 'clikcode-retired-stub-'));
    try {
      const child = spawn(process.execPath, [entry, 'conversations-mcp'], { env: { ...process.env, HOME: home, XDG_CONFIG_HOME: home, CLIKCODE_HOME: join(home, '.clikcode') }, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (chunk) => { out += String(chunk); });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })}\n`);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
      child.stdin.end();
      const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
      expect(code).toBe(0);
      expect(out).toContain('"tools":[]');
    } finally { await rm(home, { recursive: true, force: true }); }
  }, 20_000);

  it.skipIf(!existsSync(entry))('writes down the signal that ends a process which handles none, and still dies of it', async () => {
    const home = await mkdtemp(join(tmpdir(), 'clikcode-signal-'));
    try {
      const state = join(home, '.clikcode');
      await mkdir(state, { recursive: true }); // the logger never creates a state directory of its own
      const child = spawn(process.execPath, [entry, 'swarm-mcp'], { env: { ...process.env, HOME: home, XDG_CONFIG_HOME: home, CLIKCODE_HOME: state, CLIKCODE_LIFECYCLE_LOG: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
      await new Promise<void>((resolve) => child.stdout.once('data', () => resolve()).once('error', () => resolve()) && child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })}\n`));
      child.kill('SIGTERM');
      const [code, signal] = await new Promise<[number | null, string | null]>((resolve) => child.once('exit', (c, s) => resolve([c, s])));
      expect([code, signal]).toEqual([null, 'SIGTERM']);
      const log = (await readFile(join(state, 'logs', 'lifecycle.log'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(log.find((record) => record.event === 'process.signal')).toMatchObject({ signal: 'SIGTERM', argv: 'swarm-mcp' });
      expect(log.find((record) => record.event === 'mcp.retired.launch')).toMatchObject({ command: 'swarm-mcp' });
    } finally { await rm(home, { recursive: true, force: true }); }
  }, 20_000);
});
