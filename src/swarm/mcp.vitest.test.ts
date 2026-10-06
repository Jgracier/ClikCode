import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('swarm MCP framing', () => {
  it('answers framed tool discovery without waiting for a JSON newline', async () => {
    const home = await mkdtemp(join(tmpdir(), 'clikcode-swarm-mcp-'));
    const child = spawn(process.execPath, ['dist/index.js', 'swarm-mcp'], {
      cwd: process.cwd(), env: { ...process.env, HOME: home, CLIKCODE_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    try {
      const listed = await new Promise<{ result?: { tools?: Array<{ name: string; inputSchema: { required: string[] } }> } }>((resolve, reject) => {
        let bytes = Buffer.alloc(0);
        const timer = setTimeout(() => reject(new Error('swarm tools/list did not answer')), 5_000);
        child.once('error', reject);
        child.stdout.on('data', (chunk: Buffer) => {
          bytes = Buffer.concat([bytes, chunk]);
          for (;;) {
            const end = bytes.indexOf('\r\n\r\n');
            if (end < 0) return;
            const length = Number(/Content-Length:\s*(\d+)/i.exec(bytes.subarray(0, end).toString('utf8'))?.[1]);
            if (!Number.isFinite(length) || bytes.length < end + 4 + length) return;
            const message = JSON.parse(bytes.subarray(end + 4, end + 4 + length).toString('utf8')) as { id?: number; result?: { tools?: Array<{ name: string; inputSchema: { required: string[] } }> } };
            bytes = bytes.subarray(end + 4 + length);
            if (message.id === 2) { clearTimeout(timer); resolve(message); return; }
          }
        });
        const frame = (id: number, method: string): string => {
          const body = JSON.stringify({ jsonrpc: '2.0', id, method });
          return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
        };
        const first = frame(1, 'initialize');
        child.stdin.write(first.slice(0, 12));
        child.stdin.write(first.slice(12) + frame(2, 'tools/list'));
      });
      expect(listed.result?.tools?.[0]?.name).toBe('swarm');
      expect(listed.result?.tools?.[0]?.inputSchema.required).toEqual(['prompt']);
    } finally {
      if (child.exitCode === null) {
        child.kill();
        await new Promise<void>((resolve) => child.once('close', () => resolve()));
      }
      await rm(home, { recursive: true, force: true });
    }
  });

  it('answers a newline-delimited client in newline-delimited JSON', async () => {
    const home = await mkdtemp(join(tmpdir(), 'clikcode-swarm-mcp-'));
    const child = spawn(process.execPath, ['dist/index.js', 'swarm-mcp'], {
      cwd: process.cwd(), env: { ...process.env, HOME: home, CLIKCODE_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    try {
      const lines = await new Promise<string[]>((resolve, reject) => {
        let text = '';
        const timer = setTimeout(() => reject(new Error(`swarm did not answer: ${text}`)), 5_000);
        child.stdout.on('data', (chunk: Buffer) => {
          text += chunk.toString('utf8');
          const done = text.split('\n').filter(Boolean);
          if (done.length >= 2 && text.endsWith('\n')) { clearTimeout(timer); resolve(done); }
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' })}\n${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
      });
      expect(lines.map((line) => (JSON.parse(line) as { id: number }).id)).toEqual([1, 2]);
      expect(lines.join('')).not.toContain('Content-Length');
    } finally {
      if (child.exitCode === null) {
        child.kill();
        await new Promise<void>((resolve) => child.once('close', () => resolve()));
      }
      await rm(home, { recursive: true, force: true });
    }
  });

  it('hides the swarm tool from a clerk process', async () => {
    const home = await mkdtemp(join(tmpdir(), 'clikcode-swarm-clerk-'));
    const child = spawn(process.execPath, ['dist/index.js', 'swarm-mcp'], {
      cwd: process.cwd(), env: { ...process.env, HOME: home, CLIKCODE_HOME: home, CLIKCODE_SWARM_CLERK: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    try {
      const listed = await new Promise<{ result?: { tools?: Array<{ name: string }> } }>((resolve, reject) => {
        let text = '';
        const timer = setTimeout(() => reject(new Error(`swarm did not answer: ${text}`)), 5_000);
        child.stdout.on('data', (chunk: Buffer) => {
          text += chunk.toString('utf8');
          const done = text.split('\n').filter(Boolean);
          if (done.length >= 2 && text.endsWith('\n')) {
            clearTimeout(timer);
            resolve(JSON.parse(done[1]) as { result?: { tools?: Array<{ name: string }> } });
          }
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' })}\n${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
      });
      expect(listed.result?.tools).toEqual([]);
    } finally {
      if (child.exitCode === null) {
        child.kill();
        await new Promise<void>((resolve) => child.once('close', () => resolve()));
      }
      await rm(home, { recursive: true, force: true });
    }
  });
});
