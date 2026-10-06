/** Pi has no MCP (its README: "No MCP. … build an extension that adds MCP
 * support"). This extension registers `swarm` as a Pi tool and answers it by
 * asking ClikCode's swarm server over stdio, so the model list, routing,
 * progress and card are the same as on every other host. Loaded per turn
 * with `-e <file>`; it does nothing without CLIKCODE_SESSION_ID, and nothing
 * on a clerk. */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stateDirectory } from '../session/store/paths.js';

export async function writePiSwarmExtension(server: { command: string; args: string[] }): Promise<string> {
  const directory = join(stateDirectory(), 'swarm');
  const path = join(directory, 'pi-swarm-extension.js');
  const text = PI_EXTENSION.replace('__SERVER__', JSON.stringify(server));
  if (await readFile(path, 'utf8').catch(() => undefined) !== text) {
    await mkdir(directory, { recursive: true });
    await writeFile(path, text, 'utf8');
  }
  return path;
}

const PI_EXTENSION = `// Written by ClikCode (src/swarm/pi-extension.ts). Rewritten when it differs.
import { spawn } from 'node:child_process';
import { Type } from '@earendil-works/pi-ai';

const SERVER = __SERVER__;

export default function clikcodeSwarm(pi) {
  if (!process.env.CLIKCODE_SESSION_ID || process.env.CLIKCODE_SWARM_CLERK) return;
  let child;
  let buffer = '';
  let next = 0;
  const pending = new Map();
  const progress = new Map();
  const start = () => {
    if (child) return child;
    child = spawn(SERVER.command, SERVER.args, { stdio: ['pipe', 'pipe', 'ignore'], env: process.env });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      for (let at = buffer.indexOf('\\n'); at >= 0; at = buffer.indexOf('\\n')) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.method === 'notifications/progress') progress.get(message.params?.progressToken)?.(String(message.params?.message ?? ''));
        else if (message.id !== undefined && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
      }
    });
    child.on('exit', () => {
      child = undefined;
      for (const settle of pending.values()) settle({ error: { message: 'the ClikCode swarm server exited' } });
      pending.clear();
    });
    return child;
  };
  const request = (method, params) => new Promise((settle) => {
    const id = ++next;
    pending.set(id, settle);
    start().stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\\n');
  });
  pi.on('session_start', async () => {
    await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'pi', version: '1' } });
    const listed = await request('tools/list', {});
    const tool = listed.result?.tools?.find((entry) => entry.name === 'swarm');
    if (!tool) return;
    const fields = tool.inputSchema?.properties ?? {};
    pi.registerTool({
      name: 'swarm',
      label: 'Swarm',
      description: tool.description,
      parameters: Type.Object({
        prompt: Type.String({ description: fields.prompt?.description ?? '' }),
        model: Type.String({ description: fields.model?.description ?? '' }),
        description: Type.Optional(Type.String({ description: fields.description?.description ?? '' })),
      }),
      async execute(_callId, params, _signal, onUpdate) {
        const token = 'pi-' + (++next);
        progress.set(token, (step) => onUpdate?.({ content: [{ type: 'text', text: step }], details: {} }));
        try {
          const answer = await request('tools/call', { name: 'swarm', arguments: params, _meta: { progressToken: token } });
          if (answer.error) throw new Error(answer.error.message);
          const text = (answer.result?.content ?? []).map((part) => part.text ?? '').join('\\n');
          if (answer.result?.isError) throw new Error(text);
          return { content: [{ type: 'text', text }], details: {} };
        } finally {
          progress.delete(token);
        }
      },
    });
  });
  pi.on('session_shutdown', () => { child?.kill(); });
}
`;
