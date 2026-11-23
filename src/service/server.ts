/** `clikcode service`: ClikCode's accounts as an HTTP API (docs/SERVICE.md),
 * for a platform that runs its own agents on subscriptions ClikCode signs in
 * to. Every route but /health needs `authorization: Bearer <token>`; every
 * answer carries `x-clikcode-service: 1`; an error is `{ error: { code,
 * message } }`. The routes only translate: what they do is ClikCode's own
 * account, login and turn code, reached through a ServiceBackend. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';
import type { ServiceAccount, ServiceProvider } from './accounts.js';
import { LoginError, type LoginRegistry } from './logins.js';
import { parseTurnRequest, type TurnEvent, type TurnRequest } from './turns.js';

export const SERVICE_API_VERSION = '1';
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** What the routes do, on this machine (service/backend.ts) or in a test. */
export interface ServiceBackend {
  version: string;
  commit?: string;
  providers(): Promise<ServiceProvider[]>;
  accounts(): Promise<ServiceAccount[]>;
  /** undefined: no such account. */
  account(id: string): Promise<ServiceAccount | undefined>;
  checkAccount(id: string): Promise<ServiceAccount | undefined>;
  /** false: no such account. */
  removeAccount(id: string): Promise<boolean>;
  logins: LoginRegistry;
  /** Runs the turn, each event through `emit`; resolves once the last is sent. */
  runTurn(request: TurnRequest, emit: (event: TurnEvent) => void, signal: AbortSignal): Promise<void>;
}

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'x-clikcode-service': SERVICE_API_VERSION, 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) });
  response.end(text);
}

function sendError(response: ServerResponse, error: unknown): void {
  if (error instanceof HttpError) { send(response, error.status, { error: { code: error.code, message: error.message } }); return; }
  if (error instanceof LoginError) {
    const status = error.code === 'unknown-provider' ? 404 : error.code === 'invalid-choice' ? 400 : 409;
    send(response, status, { error: { code: error.code, message: error.message } });
    return;
  }
  // Never the error's own text: it may carry what a vendor printed.
  send(response, 500, { error: { code: 'internal', message: 'The service could not complete the request.' } });
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'body-too-large', 'The request body is too large.');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw new HttpError(400, 'invalid-json', 'The request body is not JSON.'); }
}

/** Constant-time comparison of the bearer token. */
export function tokenMatches(header: string | undefined, token: string): boolean {
  const given = /^Bearer\s+(.+)$/i.exec(header ?? '')?.[1]?.trim();
  if (!given) return false;
  const digest = (value: string): Buffer => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(given), digest(token));
}

export function createServiceServer(backend: ServiceBackend, options: { token: string; log?: (line: string) => void }): Server {
  const log = options.log ?? (() => undefined);
  return createServer((request, response) => {
    const started = Date.now();
    const url = new URL(request.url ?? '/', 'http://service');
    response.on('finish', () => log(`${request.method} ${url.pathname} ${response.statusCode} ${Date.now() - started}ms`));
    void route(backend, options.token, request, response, url).catch((error: unknown) => {
      if (response.headersSent) { response.end(); return; }
      sendError(response, error);
    });
  });
}

async function route(backend: ServiceBackend, token: string, request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
  const method = request.method ?? 'GET';
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (path === '/health' && method === 'GET') {
    send(response, 200, { ok: true, version: backend.version, commit: backend.commit ?? null });
    return;
  }
  if (!tokenMatches(request.headers.authorization, token)) throw new HttpError(401, 'unauthorized', 'A valid bearer token is required.');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] !== 'v1') throw new HttpError(404, 'not-found', 'No such route.');
  const [, resource, id, action] = parts;
  const allow = (...methods: string[]): void => {
    if (!methods.includes(method)) throw new HttpError(405, 'method-not-allowed', `${method} is not allowed here.`);
  };

  if (resource === 'providers' && !id) { allow('GET'); send(response, 200, { providers: await backend.providers() }); return; }

  if (resource === 'accounts') {
    if (!id) { allow('GET'); send(response, 200, { accounts: await backend.accounts() }); return; }
    if (action === 'check') {
      allow('POST');
      const account = await backend.checkAccount(id);
      if (!account) throw new HttpError(404, 'account-not-found', 'No such account.');
      send(response, 200, account);
      return;
    }
    if (action) throw new HttpError(404, 'not-found', 'No such route.');
    allow('GET', 'DELETE');
    if (method === 'GET') {
      const account = await backend.account(id);
      if (!account) throw new HttpError(404, 'account-not-found', 'No such account.');
      send(response, 200, account);
      return;
    }
    if (!await backend.removeAccount(id)) throw new HttpError(404, 'account-not-found', 'No such account.');
    send(response, 200, { ok: true, removed: id });
    return;
  }

  if (resource === 'logins') {
    if (!id) {
      allow('POST');
      const body = await readJson(request) as { provider?: unknown; label?: unknown; accountId?: unknown };
      if (typeof body.provider !== 'string' || !body.provider.trim()) throw new HttpError(400, 'invalid-request', 'provider is required.');
      if (body.label !== undefined && typeof body.label !== 'string') throw new HttpError(400, 'invalid-request', 'label must be a string.');
      if (body.accountId !== undefined && typeof body.accountId !== 'string') throw new HttpError(400, 'invalid-request', 'accountId must be a string.');
      if (body.accountId) {
        const existing = await backend.account(body.accountId);
        if (!existing) throw new HttpError(404, 'account-not-found', 'No such account to reconnect.');
      }
      const login = backend.logins.start({
        provider: body.provider.trim(),
        ...(typeof body.label === 'string' ? { label: body.label } : {}),
        ...(typeof body.accountId === 'string' && body.accountId ? { accountId: body.accountId } : {}),
      });
      send(response, 201, { loginId: login.loginId });
      return;
    }
    const login = backend.logins.get(id);
    if (!login) throw new HttpError(404, 'login-not-found', 'No such sign-in.');
    if (action === 'input') {
      allow('POST');
      const body = await readJson(request) as { value?: unknown };
      if (typeof body.value !== 'string') throw new HttpError(400, 'invalid-request', 'value must be a string.');
      send(response, 200, login.input(body.value));
      return;
    }
    if (action) throw new HttpError(404, 'not-found', 'No such route.');
    allow('GET', 'DELETE');
    if (method === 'DELETE') { backend.logins.cancel(id); send(response, 200, login.view()); return; }
    send(response, 200, login.view());
    return;
  }

  if (resource === 'turns' && !id) {
    allow('POST');
    const parsed = parseTurnRequest(await readJson(request));
    if ('error' in parsed) throw new HttpError(400, 'invalid-request', parsed.error);
    if (!await backend.account(parsed.accountId)) throw new HttpError(404, 'account-not-found', 'No such account.');
    const controller = new AbortController();
    // The caller went away: the turn is stopped, not left running for no one.
    response.on('close', () => { if (!response.writableFinished) controller.abort(); });
    response.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'x-clikcode-service': SERVICE_API_VERSION, 'cache-control': 'no-store' });
    response.flushHeaders();
    const emit = (event: TurnEvent): void => { if (!response.writableEnded) response.write(`${JSON.stringify(event)}\n`); };
    try {
      await backend.runTurn(parsed, emit, controller.signal);
    } catch {
      emit({ type: 'error', reason: 'crashed', message: 'The turn could not be run.' });
    }
    response.end();
    return;
  }
  throw new HttpError(404, 'not-found', 'No such route.');
}
