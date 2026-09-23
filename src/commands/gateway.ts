/**
 * Slim Gateway sign-in for ClikCode.
 *
 * Performs the same browser OAuth login as commands/auth.ts `login` with
 * `--google` / `--github`: the Gate PKCE device flow (init → open browser →
 * poll → verify the minted API key → persist it per API URL and in the
 * canonical auth file). It is reimplemented on `fetch` so the ClikCode bundle
 * does not drag in api/client.ts (axios, axios-retry), ui/prompts (inquirer),
 * utils/spinner (ora), or — through auth.ts's dynamic import — server-connect
 * and the whole self-host tree.
 *
 * Not supported here on purpose (deployment-CLI-only): email/password, pasted
 * API keys, `--return-url`, `--exchange`.
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import type Conf from 'conf';
import { isJsonDefaultMode } from '../cli/output-mode.js';
import { CLIKCODE_USER_AGENT } from '../version.js';
import { getApiUrl, saveGatewayAuth } from '../gateway/credentials.js';

type GatewayLoginProvider = 'google' | 'github';

interface GatewayLoginOptions {
  google?: boolean;
  github?: boolean;
  /** Return to an owning TUI instead of terminating the process. */
  embedded?: boolean;
}

interface GatewayLoginDeps {
  fetch?: typeof fetch;
  openBrowser?: (url: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

const REQUEST_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 2_000;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

class GatewayHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'GatewayHttpError';
  }
}

function openBrowserDefault(url: string): void {
  let cmd: string, args: string[];
  if (process.platform === 'darwin') { cmd = 'open'; args = [url]; }
  else if (process.platform === 'win32') { cmd = 'cmd'; args = ['/c', 'start', '', url]; }
  else { cmd = 'xdg-open'; args = [url]; }
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
  child.on('error', () => {});
  child.unref();
}

async function requestJson(
  fetchImpl: typeof fetch,
  url: string,
  init: { method: 'GET' | 'POST'; body?: unknown; bearer?: string }
): Promise<any> {
  const response = await fetchImpl(url, {
    method: init.method,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': CLIKCODE_USER_AGENT,
      ...(init.bearer ? { Authorization: `Bearer ${init.bearer}` } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  let payload: any = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
  if (!response.ok) {
    const detail = payload?.error?.message ?? payload?.error ?? payload?.message;
    throw new GatewayHttpError(
      typeof detail === 'string' && detail ? detail : `ClikDeploy Gateway request failed with HTTP ${response.status}`,
      response.status
    );
  }
  return payload;
}

/** Same unwrapping as ApiClient.extractUserFromAuthResponse. */
function extractUser(payload: any): { email?: string } | null {
  const data = payload?.data;
  if (data && typeof data === 'object' && 'user' in data && data.user) return data.user;
  return payload?.user ?? data ?? null;
}

/**
 * Run the OAuth device flow and store the resulting Gateway credential.
 * Resolves with the signed-in user when `embedded`; otherwise terminates the
 * process (exit 0 on success, 1 on failure) exactly like the legacy command.
 */
export async function gatewayLogin(
  config: Conf,
  options: GatewayLoginOptions = {},
  deps: GatewayLoginDeps = {}
): Promise<{ email?: string } | undefined> {
  const provider: GatewayLoginProvider = options.github ? 'github' : 'google';
  const embedded = Boolean(options.embedded);
  const log = deps.log ?? ((line: string) => { if (!isJsonDefaultMode()) console.log(line); });
  try {
    const user = await runDeviceFlow(config, provider, { ...deps, log });
    log(`\nLogged in as ${user.email ?? 'unknown'}`);
    log('Authentication saved securely.\n');
    if (embedded) return user;
    process.exit(0);
  } catch (error) {
    if (embedded) throw error;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Authentication failed: ${message}`);
    if (error instanceof GatewayHttpError && error.status === 401) {
      console.error('Tip: CLIKCODE_GATEWAY_URL must point to the same platform you signed in to.');
    }
    process.exit(1);
  }
}

async function runDeviceFlow(
  config: Conf,
  provider: GatewayLoginProvider,
  deps: GatewayLoginDeps & { log: (line: string) => void }
): Promise<{ email?: string }> {
  const fetchImpl = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const baseUrl = getApiUrl(config).replace(/\/$/, '');

  // PKCE: the server only ever sees the SHA-256; the verifier stays in this
  // process and is what the poll must present, so a leaked flowId is worthless.
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');
  const initResponse = await requestJson(fetchImpl, `${baseUrl}/api/gate/auth/device/init`, {
    method: 'POST',
    body: { provider, codeChallenge, codeChallengeMethod: 'S256' },
  });
  const initPayload = initResponse?.data ?? initResponse;
  const flowId = String(initPayload?.flowId || '');
  const authUrl = String(initPayload?.authUrl || '');
  if (!flowId || !authUrl) throw new Error('Failed to start auth flow');

  (deps.openBrowser ?? openBrowserDefault)(authUrl);
  deps.log('\nOpening browser for authentication...');
  deps.log(`\nIf your browser did not open, visit:\n  ${authUrl}\n`);
  deps.log('Waiting for authentication...');

  const deadline = now() + (deps.timeoutMs ?? LOGIN_TIMEOUT_MS);
  while (now() < deadline) {
    await sleep(deps.pollIntervalMs ?? POLL_INTERVAL_MS);
    let poll: any;
    try {
      // A body, not a query string: the verifier must not land in access logs.
      poll = await requestJson(fetchImpl, `${baseUrl}/api/gate/auth/device/poll`, {
        method: 'POST',
        body: { flowId, codeVerifier },
      });
    } catch {
      continue; // transient network/server error — keep polling
    }
    const status = String(poll?.status || 'pending');
    if (status === 'expired') {
      throw Object.assign(new Error('Authentication session expired. Run the login command again.'), { code: 'AUTH_EXPIRED' });
    }
    const apiKey = poll?.data?.apiKey ?? poll?.apiKey;
    if (status === 'complete' && apiKey) {
      let user: { email?: string } | null;
      try {
        user = extractUser(await requestJson(fetchImpl, `${baseUrl}/api/gate/auth/me`, { method: 'GET', bearer: String(apiKey) }));
      } catch {
        continue; // legacy parity: a failed verify is retried on the next poll
      }
      if (!user) throw new Error('Authentication verification returned no user');
      saveGatewayAuth(config, String(apiKey), user);
      return user;
    }
  }
  throw new Error('Authentication timed out. Run the login command again.');
}
