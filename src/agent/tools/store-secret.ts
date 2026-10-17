/** Sends a saved secret to a fixed destination. The agent names the secret and
 * where it goes; the worker runs the CLI and reads the value, so the value is
 * never in the command the model writes or in anything it gets back. After a
 * ClikDeploy write it checks the result, so "stored" means "set, and healthy
 * where a health check exists". */
import { spawn } from 'node:child_process';
import { defineTool } from '../tool-contract.js';
import { readNamedSecret } from '../computer/credential-vault.js';
import { registerSecret, scrubSecrets } from '../computer/secret-scrubber.js';

type Args = { secret: string; destination: 'clikdeploy' | 'github'; key: string; app?: string; repo?: string };
type CliResult = { code: number | null; text: string; missing: boolean };

function runCli(command: string, argv: string[], options: { stdin?: string; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<CliResult> {
  return new Promise(resolve => {
    const child = spawn(command, argv, { stdio: [options.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], windowsHide: true });
    let text = '';
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 90_000);
    const stop = (): void => { child.kill(); };
    options.signal?.addEventListener('abort', stop, { once: true });
    child.stdout!.on('data', chunk => { text = (text + String(chunk)).slice(-200_000); });
    child.stderr!.on('data', chunk => { text = (text + String(chunk)).slice(-200_000); });
    if (options.stdin !== undefined) { child.stdin!.on('error', () => undefined); child.stdin!.end(options.stdin); }
    child.once('error', error => { clearTimeout(timer); resolve({ code: null, text: '', missing: (error as NodeJS.ErrnoException).code === 'ENOENT' }); });
    child.once('close', code => { clearTimeout(timer); options.signal?.removeEventListener('abort', stop); resolve({ code, text, missing: false }); });
  });
}

const json = (text: string): unknown => { try { return JSON.parse(text.slice(text.indexOf('{'))); } catch { return undefined; } };

function find<T>(node: unknown, match: (value: Record<string, unknown>) => boolean): T | undefined {
  if (Array.isArray(node)) { for (const item of node) { const hit = find<T>(item, match); if (hit) return hit; } return undefined; }
  if (node && typeof node === 'object') {
    if (match(node as Record<string, unknown>)) return node as T;
    for (const value of Object.values(node)) { const hit = find<T>(value, match); if (hit) return hit; }
  }
  return undefined;
}

/** Did ClikDeploy keep it, and does the provider that uses it say it works? */
async function verifyClikdeploy(key: string, signal?: AbortSignal): Promise<string> {
  const listed = json((await runCli('clikdeploy', ['tools', 'run', 'admin_platform_secrets'], { signal, timeoutMs: 120_000 })).text);
  const entry = find<{ configured?: boolean; updatedAt?: string; category?: string }>(listed, node => node.key === key && 'configured' in node);
  if (!entry) return 'Could not confirm it in ClikDeploy (the secret list was unreadable).';
  const fresh = entry.updatedAt && Date.now() - Date.parse(entry.updatedAt) < 5 * 60_000;
  if (!entry.configured || !fresh) return 'ClikDeploy does not show it as just set. Check it before relying on it.';
  let verdict = 'Confirmed set in ClikDeploy.';
  if (entry.category?.startsWith('compute')) {
    const providers = json((await runCli('clikdeploy', ['tools', 'run', 'admin_compute_gpu_providers'], { signal, timeoutMs: 150_000 })).text);
    const provider = find<{ id?: string; health?: { healthy?: boolean; error?: string } }>(providers, node => Array.isArray(node.credentialKeys) && (node.credentialKeys as unknown[]).includes(key));
    if (provider?.health) verdict += provider.health.healthy ? ` Provider ${provider.id} reports healthy with this credential.` : ` Provider ${provider.id} reports UNHEALTHY with this credential${provider.health.error ? `: ${provider.health.error}` : ''}.`;
    else if (provider) verdict += ` Provider ${provider.id} has no live health check, so it is set but not tested.`;
  } else verdict += ' No live health check exists for this kind of key, so it is set but not tested.';
  return verdict;
}

export const storeSecretTool = defineTool<Args>({
  name: 'store_secret', class: 'exec',
  description: 'Send a secret saved with computer_web capture_secret to a destination without ever showing you its value. destination clikdeploy: with no app it sets a ClikDeploy platform secret (the key must be a platform secret name such as SALAD_API_KEY; `clikdeploy tools run admin_platform_secrets` lists every name with the page where its key is created); with an app it sets that app\'s secret. destination github: sets a repository secret (needs repo as owner/name). A ClikDeploy write is checked afterwards and the result says whether it is set and whether its provider is healthy. Asks the user to approve each use.',
  parameters: { type: 'object', additionalProperties: false, required: ['secret', 'destination', 'key'], properties: {
    secret: { type: 'string', description: 'Name given to capture_secret.' },
    destination: { type: 'string', enum: ['clikdeploy', 'github'] },
    key: { type: 'string', description: 'The secret\'s name at the destination, for example SALAD_API_KEY.' },
    app: { type: 'string', description: 'ClikDeploy app id, to set an app secret instead of a platform secret.' },
    repo: { type: 'string', description: 'For github: owner/name of the repository.' },
  } },
  label: (args) => `Store secret ${args.secret} as ${args.key}`,
  describe: async (args) => `Send saved secret "${args.secret}" to ${args.destination === 'github' ? `GitHub repository ${args.repo ?? '?'} secret` : `ClikDeploy ${args.app ? `app ${args.app}` : 'platform'} secret`} ${args.key}. The value is not shown to the agent.`,
  async run(args, ctx) {
    try {
      if (!/^[A-Z][A-Z0-9_]{1,80}$/.test(args.key)) throw new Error('The destination key is an upper-case name such as SALAD_API_KEY.');
      if (args.destination === 'github' && !/^[\w.-]+\/[\w.-]+$/.test(args.repo ?? '')) throw new Error('github needs repo as owner/name.');
      const value = await readNamedSecret(ctx.stateDir, args.secret);
      registerSecret(value);
      let result: CliResult;
      if (args.destination === 'github') {
        // gh reads the value from stdin, so it is in no command line.
        result = await runCli('gh', ['secret', 'set', args.key, '--repo', args.repo!], { stdin: value, signal: ctx.signal, timeoutMs: 60_000 });
      } else {
        const body = args.app ? { appId: args.app, key: args.key, value } : { key: args.key, value };
        result = await runCli('clikdeploy', ['tools', 'run', args.app ? 'set_secret' : 'admin_platform_set_secret', '--args-json', JSON.stringify(body), '--confirm'], { signal: ctx.signal, timeoutMs: 60_000 });
      }
      if (result.missing) throw new Error(`The ${args.destination === 'github' ? 'gh' : 'clikdeploy'} command is not installed on this computer.`);
      const ok = result.code === 0;
      const parsed = json(result.text) as { message?: string; data?: { appliedToWebProcess?: boolean; reloadReason?: string } } | undefined;
      const detail = parsed
        ? [parsed.message, parsed.data?.appliedToWebProcess !== undefined ? `appliedToWebProcess=${parsed.data.appliedToWebProcess}` : '', parsed.data?.reloadReason].filter(Boolean).join(' · ')
        : result.text.trim().split('\n').slice(-3).join(' ');
      const where = args.destination === 'github' ? `GitHub repository ${args.repo}` : 'ClikDeploy';
      let output = `${ok ? `Stored "${args.secret}" in ${where} as ${args.key}.` : `${where} did not store ${args.key}.`} ${detail}`.trim();
      if (ok && args.destination === 'clikdeploy' && !args.app) output += ` ${await verifyClikdeploy(args.key, ctx.signal)}`;
      return { output: scrubSecrets(output), ...(ok ? {} : { isError: true }) };
    } catch (error) { return { output: scrubSecrets(error instanceof Error ? error.message : String(error)), isError: true }; }
  },
});
