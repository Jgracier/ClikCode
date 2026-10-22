/** Private ClikDeploy step-up. Answers go from the window to this worker and
 * directly to ClikDeploy; neither the code nor password is a model argument. */
import Conf from 'conf';
import { defineTool } from '../tool-contract.js';
import { openTransport } from '../mcp/transport.js';
import { getApiKeyForUrl, getApiUrl } from '../../gateway/credentials.js';
import { registerSecret, scrubSecrets } from '../computer/secret-scrubber.js';

type Args = { action: 'unlock' | 'call'; tool?: string; arguments?: Record<string, unknown>; password?: boolean };
type Json = Record<string, unknown>;

function connection(): { url: string; key: string; config: Conf; codeConfig: Conf } {
  const cli = new Conf({ projectName: 'clikdeploy', configFileMode: 0o600 });
  const code = new Conf({ projectName: 'clikcode', configFileMode: 0o600 });
  const cliUrl = (process.env.CLIKDEPLOY_API_URL_OVERRIDE || process.env.CLIKDEPLOY_API_URL || getApiUrl(cli)).replace(/\/+$/, '');
  const config = getApiKeyForUrl(cli, cliUrl) ? cli : code;
  const url = config === cli ? cliUrl : getApiUrl(code);
  const key = getApiKeyForUrl(config, url);
  if (!key) throw new Error('Sign in to ClikDeploy with clikdeploy login or clikcode gateway login first.');
  return { url, key, config, codeConfig: code };
}

function rememberUnlock(config: Conf, codeConfig: Conf, url: string, key: string, token: string): void {
  config.set('adminMfaToken', token);
  // A Gateway chat uses ClikCode's config, while the standalone CLI uses its
  // own. Share an unlock only if both are the same ClikDeploy identity.
  if (config !== codeConfig && getApiKeyForUrl(codeConfig, url) === key) codeConfig.set('adminMfaToken', token);
}

function responseError(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const result = value as Json;
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content.filter((item): item is { text: string } => Boolean(item && typeof item === 'object' && typeof (item as Json).text === 'string')).map(item => item.text).join('\n');
  let data: Json | undefined;
  try { data = JSON.parse(text) as Json; } catch { /* plain text */ }
  if (result.isError === true || data?.error === true) return `${String(data?.code ?? '')} ${String(data?.message ?? data?.detail ?? text)}`.trim();
  return undefined;
}

async function unlock(url: string, key: string, code: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(`${url}/api/admin/2fa/unlock`, {
    method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ code }), signal: signal ?? AbortSignal.timeout(20_000),
  });
  const body = await response.json().catch(() => ({})) as { data?: { token?: string }; token?: string };
  if (!response.ok || !String(body.data?.token ?? body.token ?? '')) throw new Error(response.status === 400 ? 'ClikDeploy rejected the authenticator code.' : `ClikDeploy authenticator unlock failed (HTTP ${response.status}).`);
  return String(body.data?.token ?? body.token);
}

async function adminCall(url: string, key: string, token: string | undefined, password: string | undefined, name: string, args: Json, signal?: AbortSignal): Promise<unknown> {
  const headers: Record<string, string> = { authorization: `Bearer ${key}`, ...(token ? { 'x-admin-mfa': token } : {}) };
  const transport = openTransport({ name: 'clikdeploy', transport: 'http', url: `${url}/mcp?toolmode=search`, headers }, {});
  try {
    const options = { timeoutMs: 30_000, ...(signal ? { signal } : {}) };
    const initialized = await transport.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'clikcode', version: '1' } }, options);
    if (typeof initialized.protocolVersion === 'string') transport.setProtocolVersion(initialized.protocolVersion);
    transport.notify('notifications/initialized');
    if (password) headers['x-superadmin-password'] = password;
    return await transport.request('tools/call', { name: 'call_tool', arguments: { name, arguments: { ...args, confirm: true } } }, options);
  } finally { delete headers['x-superadmin-password']; await transport.close(); }
}

export const clikDeployStepUpTool = defineTool<Args>({
  name: 'clikdeploy_step_up', class: 'exec',
  description: 'Privately ask the user for a ClikDeploy authenticator code and unlock admin mutations immediately (action: unlock). For a specific protected admin tool, action: call executes that tool with a private super admin password if required. Never ask the user to paste either credential into chat or a shell command. The password applies only to this one tool call. Use the ordinary ClikDeploy tool first; use call only after it specifically requires step-up.',
  parameters: { type: 'object', additionalProperties: false, required: ['action'], properties: {
    action: { type: 'string', enum: ['unlock', 'call'] },
    tool: { type: 'string', description: 'Exact admin_* tool name to retry after a step-up refusal.' },
    arguments: { type: 'object', description: 'The same non-secret arguments as the refused tool call.' },
    password: { type: 'boolean', description: 'Ask privately for the super admin password for this one call.' },
  } },
  label: args => args.action === 'unlock' ? 'Unlock ClikDeploy admin' : `Run ${args.tool ?? 'ClikDeploy admin tool'} with private step-up`,
  describe: async args => args.action === 'unlock' ? 'Verify a private authenticator code with ClikDeploy and store its admin unlock token.'
    : `Run ClikDeploy ${args.tool ?? 'admin tool'} with fields ${Object.keys(args.arguments ?? {}).join(', ').slice(0, 200)}${args.password ? ' and a privately entered super admin password' : ''}.`,
  async run(args, ctx) {
    try {
      if (!ctx.requestPrivateSecret) throw new Error('This chat cannot show private prompts. Open it in the terminal or VS Code.');
      const { url, key, config, codeConfig } = connection();
      if (args.action === 'unlock') {
        const code = await ctx.requestPrivateSecret('ClikDeploy authenticator', 'Enter the current authenticator code to unlock admin changes.', ctx.signal);
        if (!code) return { output: 'Authenticator unlock cancelled.', isError: true };
        registerSecret(code);
        const token = await unlock(url, key, code, ctx.signal);
        registerSecret(token);
        rememberUnlock(config, codeConfig, url, key, token);
        return { output: 'ClikDeploy admin changes are unlocked. Retry the protected action.' };
      }
      if (!args.tool || !/^admin_[a-z0-9_]+$/.test(args.tool)) throw new Error('Name the exact built-in admin_* tool that requested step-up.');
      const values = args.arguments ?? {};
      if (Object.keys(values).some(key => /password|totp|code|token/i.test(key))) throw new Error('Keep credentials out of tool arguments; this tool asks privately.');
      const action = `${args.tool} ${JSON.stringify(values).slice(0, 300)}`;
      let token = config.get('adminMfaToken') as string | undefined;
      if (!token) {
        const code = await ctx.requestPrivateSecret('ClikDeploy authenticator', `Enter the authenticator code to run ${action}.`, ctx.signal);
        if (!code) return { output: 'ClikDeploy step-up cancelled.', isError: true };
        registerSecret(code);
        token = await unlock(url, key, code, ctx.signal);
        registerSecret(token);
        rememberUnlock(config, codeConfig, url, key, token);
      }
      let password: string | undefined;
      if (args.password) {
        password = await ctx.requestPrivateSecret('ClikDeploy super admin', `Enter the super admin password to run ${action}. It is used for this action only.`, ctx.signal);
        if (!password) return { output: 'ClikDeploy step-up cancelled.', isError: true };
        registerSecret(password);
      }
      const result = await adminCall(url, key, token, password, args.tool, values, ctx.signal);
      const failure = responseError(result);
      if (failure) return { output: scrubSecrets(failure), isError: true };
      return { output: scrubSecrets(JSON.stringify(result).slice(0, 12_000)) };
    } catch (error) { return { output: scrubSecrets(error instanceof Error ? error.message : String(error)), isError: true }; }
  },
});
