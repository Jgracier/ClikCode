/** The connector loop's OWN ClikDeploy credential: the @connector-loop agent's standing key.
 *
 * The loop used to make every ClikDeploy call with the person's CLI key (~/.config/clikdeploy-nodejs). ClikDeploy holds a person's
 * scoped key on every write unless the call carries that person's live 24-hour authenticator unlock, so each night the unlock lapsed
 * and every claim, report and note came back "held for approval". The agent key names @connector-loop: ClikDeploy serves it exactly
 * that agent's connector tools at /mcp, under the agent's own grant and bypass mode, with no unlock. It works nowhere else (every
 * other route refuses it), and it covers only CONNECTOR_LOOP_TOOLS: any other tool still goes through the person's CLI as before.
 *
 * The key is made here and kept only in the local vault (credential-vault.ts, encrypted). ClikDeploy is given its SHA-256 alone, by
 * the person, through admin_connector_loop_credential_issue (authenticator + super-admin password). It is never printed, logged, put
 * in a file in the clear, or passed on a command line. The person's own CLI config is never touched. */
import { createHash, randomBytes } from 'node:crypto';
import { deleteNamedSecret, namedSecretInfo, readNamedSecret, saveNamedSecret } from './credential-vault.js';
import { registerSecret } from './secret-scrubber.js';
import { stateDirectory } from '../../session/store/paths.js';

/** The vault name of the key. */
export const CONNECTOR_LOOP_SECRET = 'clikdeploy/connector-loop-key';
export const DEFAULT_PLATFORM = 'https://clikdeploy.com';

/** The tools @connector-loop holds at ClikDeploy (clikagents connector-loop-agent.ts CONNECTOR_LOOP_CAPABILITIES there). A tool not
 * named here is refused by that key, so it keeps going through the person's CLI. */
export const CONNECTOR_LOOP_TOOLS: ReadonlySet<string> = new Set([
  'connector_pipeline_status', 'connector_work_overview', 'connector_attention_list', 'connector_spec_get', 'connector_proof',
  'connector_build', 'connector_copy_task', 'connector_scope_check', 'connector_test_job_status',
  'connector_work_claim', 'connector_work_renew', 'connector_work_note', 'connector_work_report', 'connector_work_enqueue', 'connector_attention_resolve',
  'connector_onboard', 'connector_onboard_batch', 'connector_discover', 'connector_enrich', 'connector_spec_put', 'connector_spec_patch',
  'connector_build_apply', 'connector_copy_apply', 'connector_seed_plan', 'connector_seed_apply', 'connector_harvest_fixtures',
  'connector_test', 'connector_test_job_start', 'connector_test_job_step', 'connector_preflight', 'connector_finish',
]);

/** ClikDeploy's key format (cd_live_ + 64 hex) and its stored hash (hashApiKey: SHA-256 hex). */
export const keyHash = (key: string): string => createHash('sha256').update(key).digest('hex');
const KEY_FORMAT = /^cd_live_[a-f0-9]{64}$/;

export interface LoopKey { key: string; platform: string }

/** The saved key and the platform it is for, or undefined when none is saved (the loop then uses the CLI, as before). */
export async function connectorLoopKey(stateDir = stateDirectory()): Promise<LoopKey | undefined> {
  const info = (await namedSecretInfo(stateDir).catch(() => [])).find(entry => entry.name === CONNECTOR_LOOP_SECRET);
  if (!info) return undefined;
  const key = await readNamedSecret(stateDir, CONNECTOR_LOOP_SECRET).catch(() => '');
  if (!KEY_FORMAT.test(key)) return undefined;
  registerSecret(key);
  return { key, platform: (info.meta?.url ?? DEFAULT_PLATFORM).replace(/\/+$/, '') };
}

/** Make a new key and keep it in the vault (replacing any earlier one). Returns only its SHA-256, which is what ClikDeploy is given. */
export async function prepareConnectorLoopKey(stateDir = stateDirectory(), platform = DEFAULT_PLATFORM): Promise<{ keyHash: string }> {
  const key = `cd_live_${randomBytes(32).toString('hex')}`;
  registerSecret(key);
  await saveNamedSecret(stateDir, CONNECTOR_LOOP_SECRET, key, { vendor: 'clikdeploy', owner: 'connector-loop', url: platform });
  return { keyHash: keyHash(key) };
}

/** Remove the key from this computer: the loop goes back to the person's CLI key. (Revoke it at ClikDeploy too.) */
export async function forgetConnectorLoopKey(stateDir = stateDirectory()): Promise<boolean> {
  return deleteNamedSecret(stateDir, CONNECTOR_LOOP_SECRET);
}

/** The streamable-HTTP answer: JSON, or a one-shot SSE body whose last data line is the JSON. */
function rpcBody(text: string): { result?: { content?: Array<{ type?: string; text?: string }>; isError?: boolean }; error?: { message?: string; code?: number } } {
  for (const line of text.split('\n').reverse()) {
    const trimmed = line.trim();
    if (trimmed.startsWith('data:')) { try { return JSON.parse(trimmed.slice(5).trim()); } catch { /* fail-open-ok: try the next line */ } }
  }
  try { return JSON.parse(text); } catch { return {}; }
}

/**
 * One tool call at ClikDeploy's /mcp with the loop's own key. Answers in the shape `clikdeploy tools run` prints (`{status: 'success', data}` or
 * `{status:'error', error}`), so the caller reads both the same way (connector-runner-live.ts unwrapTool).
 */
export async function callWithLoopKey(loop: LoopKey, name: string, args: Record<string, unknown>, options: { timeoutMs?: number; signal?: AbortSignal; fetchImpl?: typeof fetch } = {}): Promise<string> {
  const signals = [AbortSignal.timeout(options.timeoutMs ?? 90_000), ...(options.signal ? [options.signal] : [])];
  const response = await (options.fetchImpl ?? fetch)(`${loop.platform}/mcp`, {
    method: 'POST',
    signal: AbortSignal.any(signals),
    headers: { authorization: `Bearer ${loop.key}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'mcp-method': 'tools/call', 'mcp-name': name },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { ...args, confirm: true } } }),
  });
  const text = await response.text();
  if (response.status === 401 || response.status === 403) {
    return JSON.stringify({ status: 'error', error: { code: 'CONNECTOR_LOOP_KEY_REFUSED', message: `ClikDeploy refused the connector loop's own key (HTTP ${response.status}): it was revoked or has expired. Issue a new one (clikcode connectors credential prepare, then admin_connector_loop_credential_issue), or run clikcode connectors credential forget to go back to the CLI key.` } });
  }
  const body = rpcBody(text);
  if (body.error) return JSON.stringify({ status: 'error', error: { code: body.error.code === -32601 ? 'UNKNOWN_TOOL' : 'MCP_ERROR', message: body.error.message ?? `ClikDeploy answered ${name} with an error` } });
  if (!response.ok || !body.result) return JSON.stringify({ status: 'error', error: { code: `HTTP_${response.status}`, message: `ClikDeploy answered ${name} with HTTP ${response.status}` } });
  const said = body.result.content?.find(part => part.type === 'text')?.text ?? '';
  let data: unknown = said;
  try { data = JSON.parse(said); } catch { /* fail-open-ok: a plain-text answer */ }
  const structured = data && typeof data === 'object' && (data as { error?: unknown }).error === true ? data as { code?: string; message?: string; detail?: string } : undefined;
  if (structured) return JSON.stringify({ status: 'error', error: { code: structured.code ?? 'TOOL_ERROR', message: structured.detail ?? structured.message ?? 'Tool failed' } });
  if (body.result.isError) return JSON.stringify({ status: 'error', error: { code: 'TOOL_ERROR', message: typeof data === 'string' ? data || 'Tool failed' : JSON.stringify(data) } });
  return JSON.stringify({ status: 'success', tool: name, data });
}
