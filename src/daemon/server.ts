/**
 * The local HTTP daemon: `clikcode ai start|status|stop`.
 *
 * A long-lived process that answers turn requests over a loopback port, for
 * callers that are not this terminal. It shares the harness machinery with the
 * interactive path and nothing else: no conversation state, no rendering, no
 * pickers. It lived in the same file as the turn loop only because both are
 * reached by the same command group.
 */
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, open, readFile, unlink, writeFile, type FileHandle } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import type Conf from 'conf';
import { emitJson } from '../cli/structured-output.js';
import { isAllowedLoopbackHost } from './host-allowlist.js';
import { harnessCommand, harnessStatePath } from '../session/state/paths.js';
import { readState } from '../session/state/read.js';
import { accountView, deviceManifest } from '../session/state/views.js';
import { writeState } from '../session/state/write.js';
import { streamLocalAiTurn } from '../harness/transport/native-protocol.js';
import type { AiHarnessAccount } from '../harness/types.js';

async function acquireRuntimeLock(lockPath: string, runtimePath: string): Promise<FileHandle> {
  const attempt = () => open(lockPath, 'wx', 0o600);
  try {
    return await attempt();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    try {
      const runtime = JSON.parse(await readFile(runtimePath, 'utf8')) as { pid?: unknown };
      if (typeof runtime.pid === 'number') {
        process.kill(runtime.pid, 0);
        throw new Error(`a ${harnessCommand()} control API is already running (pid ${runtime.pid})`);
      }
    } catch (runtimeError) {
      if (runtimeError instanceof Error && runtimeError.message.includes('control API is already running')) throw runtimeError;
      if ((runtimeError as NodeJS.ErrnoException).code === 'EPERM') {
        throw new Error(`a ${harnessCommand()} control API appears to be running but its process cannot be inspected`);
      }
      // Missing/corrupt runtime metadata or ESRCH means the lock is stale.
    }
    await unlink(lockPath).catch((unlinkError: NodeJS.ErrnoException) => {
      if (unlinkError.code !== 'ENOENT') throw unlinkError;
    });
    return attempt();
  }
}

function sendJson(response: ServerResponse, code: number, body: unknown): void {
  response.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

function boundPort(server: Server): number {
  const address = server.address();
  return address && typeof address !== 'string' ? address.port : -1;
}

function methodAndPath(request: IncomingMessage): `${string} ${string}` {
  return `${request.method ?? 'GET'} ${new URL(request.url ?? '/', 'http://127.0.0.1').pathname}`;
}

function authorized(request: IncomingMessage, expected: string): boolean {
  const value = request.headers.authorization;
  if (!value?.startsWith('Bearer ')) return false;
  const presented = Buffer.from(value.slice('Bearer '.length));
  const secret = Buffer.from(expected);
  return presented.length === secret.length && timingSafeEqual(presented, secret);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  let body = '';
  for await (const chunk of request) {
    body += String(chunk);
    if (body.length > 1_000_000) throw new Error('request body too large');
  }
  return JSON.parse(body);
}

export function localApiKey(account: AiHarnessAccount): string {
  if (account.authKind !== 'api-key' || !account.credentialRef.startsWith('env:')) {
    throw new Error('this account needs a supported local API-key resolver (env:NAME)');
  }
  const name = account.credentialRef.slice(4);
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error('invalid local environment credential reference');
  const value = process.env[name];
  if (!value) throw new Error(`local credential ${name} is not available in this harness process`);
  return value;
}


/** Starts an intentionally loopback-only harness service. It exposes no provider tokens. */
export async function aiStart(_config: Conf, options: { port?: string }): Promise<void> {
  // The control API is optional. When no port is requested, defer entirely to
  // the OS so ClikCode never competes with ClikDeploy or another local tool.
  const port = options.port === undefined ? 0 : Number(options.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('port must be an integer from 0 to 65535');
  const runtimeDirectory = join(harnessStatePath(), '..');
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
  const runtimePath = join(runtimeDirectory, 'runtime.json');
  const lockPath = join(runtimeDirectory, 'runtime.lock');
  const runtimeLock = await acquireRuntimeLock(lockPath, runtimePath);
  const startupState = await readState();
  const server = createServer(async (request, response) => {
    try {
      // DNS-rebinding guard: only a literal loopback authority on OUR port.
      if (!isAllowedLoopbackHost(request.headers.host, boundPort(server))) return sendJson(response, 403, { error: 'forbidden_host' });
      const route = methodAndPath(request);
      if (route === 'GET /v1/health') {
        sendJson(response, 200, { status: 'ok', installationId: startupState.installationId, runtime: harnessCommand(), credentialBoundary: 'local-only' });
      } else if (!authorized(request, startupState.localApiToken)) {
        sendJson(response, 401, { error: 'unauthorized' });
      } else {
        // Commands and native harnesses may update state while the optional
        // control API is running. Always serve the latest atomic snapshot.
        const state = await readState();
        if (route === 'GET /v1/accounts') {
        sendJson(response, 200, { accounts: state.accounts.map(accountView) });
        } else if (route === 'GET /v1/device') {
        sendJson(response, 200, { device: deviceManifest(state) });
        } else if (route === 'GET /v1/models') {
        sendJson(response, 200, {
          models: state.accounts.flatMap((account) => account.models.map((model) => ({ accountId: account.id, provider: account.provider, model }))),
        });
        } else if (route === 'GET /v1/sessions') {
        sendJson(response, 200, { sessions: state.sessions });
        } else if (route === 'GET /v1/usage') {
        sendJson(response, 200, { invocations: state.invocations });
        } else if (route === 'POST /v1/chat') {
        const body = await readJson(request) as { accountId?: unknown; messages?: unknown; effort?: unknown };
        const account = state.accounts.find((item) => item.id === body.accountId);
        if (!account) throw new Error('local account not found');
        if (!Array.isArray(body.messages) || !body.messages.every((m) => typeof m === 'object' && m !== null && ((m as { role?: unknown }).role === 'user' || (m as { role?: unknown }).role === 'assistant') && typeof (m as { content?: unknown }).content === 'string')) {
          throw new Error('messages must be user/assistant text messages');
        }
        const model = account.models[0];
        if (!model) throw new Error('local account has no configured model');
        const startedAt = Date.now();
        const turn = await streamLocalAiTurn({ provider: account.provider, model, apiKey: localApiKey(account), credentialSource: 'env', messages: body.messages as Array<{ role: 'user' | 'assistant'; content: string }>, ...(typeof body.effort === 'string' ? { reasoningEffort: body.effort as never } : {}) });
        const invocation = { id: randomUUID(), accountId: account.id, provider: account.provider, model, at: new Date().toISOString(), inputTokens: turn.usage.inputTokens, outputTokens: turn.usage.outputTokens, latencyMs: Date.now() - startedAt };
        // The turn above can run for minutes, and the interactive CLI writes
        // real conversation state throughout. `state` is the pre-turn snapshot
        // of the WHOLE file, so persisting it here would revert every message,
        // rename, and new conversation written meanwhile. Re-read so appending
        // one usage record only ever appends.
        const latest = await readState();
        latest.invocations.push(invocation);
        await writeState(latest);
        sendJson(response, 200, { text: turn.text, toolCalls: turn.toolCalls, usage: turn.usage, invocation });
        } else {
          sendJson(response, 404, { error: 'not_found' });
        }
      }
    } catch {
      sendJson(response, 500, { error: 'harness_error' });
    }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('local control API did not expose a TCP address');
    await writeFile(runtimePath, `${JSON.stringify({ pid: process.pid, port: address.port, host: '127.0.0.1', installationId: startupState.installationId, startedAt: new Date().toISOString() }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    emitJson({ status: 'running', url: `http://127.0.0.1:${address.port}`, installationId: startupState.installationId, credentialBoundary: 'local-only' });
    await new Promise<void>((resolve) => {
      const stop = () => server.close(() => resolve());
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
  } finally {
    await runtimeLock.close().catch(() => undefined);
    await unlink(runtimePath).catch(() => undefined);
    await unlink(lockPath).catch(() => undefined);
  }
}

export async function aiStatus(): Promise<void> {
  const runtimePath = join(harnessStatePath(), '..', 'runtime.json');
  try {
    const runtime = JSON.parse(await readFile(runtimePath, 'utf8')) as { pid?: unknown; port?: unknown; host?: unknown; installationId?: unknown; startedAt?: unknown };
    let running = false;
    if (typeof runtime.pid === 'number') {
      try { process.kill(runtime.pid, 0); running = true; } catch (error) { running = (error as NodeJS.ErrnoException).code === 'EPERM'; }
    }
    emitJson({ status: running ? 'running' : 'stale', ...runtime, credentialBoundary: 'local-only' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    emitJson({ status: 'stopped' });
  }
}

export async function aiStop(): Promise<void> {
  const runtimePath = join(harnessStatePath(), '..', 'runtime.json');
  const state = await readState();
  let runtime: { pid?: unknown; installationId?: unknown };
  try {
    runtime = JSON.parse(await readFile(runtimePath, 'utf8')) as typeof runtime;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emitJson({ status: 'stopped' });
    throw error;
  }
  if (runtime.installationId !== state.installationId || typeof runtime.pid !== 'number') {
    throw new Error('refusing to stop a runtime record that does not belong to this ClikCode installation');
  }
  try { process.kill(runtime.pid, 'SIGTERM'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
  emitJson({ status: 'stopping', pid: runtime.pid });
}