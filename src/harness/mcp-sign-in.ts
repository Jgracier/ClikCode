/** Whether a remote MCP server needs a browser sign-in before it answers.
 *
 * Why it matters: every vendor and every isolated account profile keeps its
 * own OAuth token store, so a server that needs a sign-in can never be
 * "signed in once" for all of them. Copied everywhere, it is a sign-in owed in
 * every one -- and a vendor that starts OAuth on its own (Copilot's ACP
 * server opens the authorization page as a session starts) opened a browser
 * tab on every session ClikCode started. So provisioning never hands such a
 * server to a vendor; the user signs it in where they put it.
 *
 * The answer comes from the server itself: an unauthenticated MCP request
 * (POST initialize) answered 401/403 with a `WWW-Authenticate` challenge is
 * the MCP authorization spec's "sign in first". A 200 that merely ADVERTISES
 * optional OAuth is not -- Context7 does exactly that, answering 200 with a
 * WWW-Authenticate header and a published protected-resource document.
 *
 * Fail closed: a server that cannot be reached is 'unknown', and unknown is
 * never copied -- the one wrong answer that costs the user something is a
 * popup.
 *
 * Cached by URL (the server's identity) with a clock, since it is a remote
 * server's answer and nothing local changes when it does. An unknown is never
 * cached: the next turn asks again. */
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteFile } from '../session/store/files.js';
import { isRemoteTarget, type McpServerEntry } from './mcp-registry.js';

export type McpSignInAnswer = 'sign-in' | 'open' | 'unknown';

const CACHE_FILE = 'mcp-sign-in.json';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const PROBE_TIMEOUT_MS = 4_000;

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** A header that carries the caller's own credential. An entry sending one is
 * signed in already, as far as a browser is concerned. */
export function carriesCredentials(headers: Readonly<Record<string, string>> | undefined): boolean {
  return Object.entries(headers ?? {}).some(([name, value]) =>
    value.trim() !== '' && /^(authorization|proxy-authorization|cookie)$|api[-_]?key|token|secret|auth/i.test(name));
}

/** The answer one HTTP response gives. Pure, so the rule is testable without
 * a server. */
export function signInFromResponse(status: number, wwwAuthenticate: string | null): Exclude<McpSignInAnswer, 'unknown'> {
  return (status === 401 || status === 403) && !!wwwAuthenticate?.trim() ? 'sign-in' : 'open';
}

/** Asks the server, unauthenticated, the first thing every MCP client asks. */
export async function probeRemoteMcp(url: string, fetchImpl: Fetch = fetch, timeoutMs = PROBE_TIMEOUT_MS): Promise<McpSignInAnswer> {
  const ask = async (init: RequestInit): Promise<{ status: number; challenge: string | null }> => {
    const response = await fetchImpl(url, { ...init, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
    const result = { status: response.status, challenge: response.headers.get('www-authenticate') };
    await response.body?.cancel().catch(() => undefined);
    return result;
  };
  try {
    const posted = await ask({
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'clikcode-sign-in-check', version: '1' } },
      }),
    });
    // An SSE-only server refuses a POST to its stream URL; its GET is the
    // request a client would make first.
    if (posted.status === 404 || posted.status === 405) {
      const got = await ask({ method: 'GET', headers: { accept: 'text/event-stream' } });
      return signInFromResponse(got.status, got.challenge);
    }
    return signInFromResponse(posted.status, posted.challenge);
  } catch {
    return 'unknown';
  }
}

type CacheRecord = Record<string, { answer: Exclude<McpSignInAnswer, 'unknown'>; at: number }>;

async function readCache(stateDir: string): Promise<CacheRecord> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(stateDir, 'cache', CACHE_FILE), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as CacheRecord : {};
  } catch { return {}; }
}

export interface SignInCheckOptions {
  stateDir: string;
  /** False when this vendor is given the server WITHOUT its headers (its
   * `mcp add` has no header flag), so the credential the entry carries never
   * reaches it. */
  headersReach?: boolean;
  probe?: (url: string) => Promise<McpSignInAnswer>;
  now?: number;
}

/** Whether `entry`, as this vendor would receive it, would ask for a sign-in.
 * A local (stdio) server never does. */
export async function mcpServerNeedsSignIn(entry: McpServerEntry, options: SignInCheckOptions): Promise<McpSignInAnswer> {
  if (!isRemoteTarget(entry.target)) return 'open';
  if (options.headersReach !== false && carriesCredentials(entry.headers)) return 'open';
  const now = options.now ?? Date.now();
  const cache = await readCache(options.stateDir);
  const hit = cache[entry.target];
  if (hit && now - hit.at < CACHE_TTL_MS && now >= hit.at) return hit.answer;
  const answer = await (options.probe ?? probeRemoteMcp)(entry.target);
  if (answer !== 'unknown') {
    const fresh = await readCache(options.stateDir);
    fresh[entry.target] = { answer, at: now };
    await mkdir(join(options.stateDir, 'cache'), { recursive: true });
    await atomicWriteFile(join(options.stateDir, 'cache', CACHE_FILE), `${JSON.stringify(fresh, null, 2)}\n`).catch(() => undefined);
  }
  return answer;
}
