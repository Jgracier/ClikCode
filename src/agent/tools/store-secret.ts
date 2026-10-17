/** Sends a saved secret to a fixed destination. The agent names the secret and
 * where it goes; the worker runs the CLI and reads the value, so the value is
 * never in the command the model writes or in anything it gets back. */
import { spawn } from 'node:child_process';
import { defineTool } from '../tool-contract.js';
import { readNamedSecret } from '../computer/credential-vault.js';
import { registerSecret, scrubSecrets } from '../computer/secret-scrubber.js';

type Args = { secret: string; destination: 'clikdeploy'; key: string; app?: string };

/** Destinations are code, not model input: each says how to hand over a value. */
function clikdeployCall(args: Args, value: string): string[] {
  const body = args.app ? { appId: args.app, key: args.key, value } : { key: args.key, value };
  return ['tools', 'run', args.app ? 'set_secret' : 'admin_platform_set_secret', '--args-json', JSON.stringify(body), '--confirm'];
}

export const storeSecretTool = defineTool<Args>({
  name: 'store_secret', class: 'exec',
  description: 'Send a secret saved with computer_web capture_secret to ClikDeploy, without ever showing you its value. With no app it sets a platform secret (the key must be a ClikDeploy platform secret name such as SALAD_API_KEY); with an app it sets that app\'s secret. Asks the user to approve each use.',
  parameters: { type: 'object', additionalProperties: false, required: ['secret', 'destination', 'key'], properties: {
    secret: { type: 'string', description: 'Name given to capture_secret.' },
    destination: { type: 'string', enum: ['clikdeploy'] },
    key: { type: 'string', description: 'The secret\'s name at the destination, for example SALAD_API_KEY.' },
    app: { type: 'string', description: 'App id, to set an app secret instead of a platform secret.' },
  } },
  label: (args) => `Store secret ${args.secret} as ${args.key}`,
  describe: async (args) => `Send saved secret "${args.secret}" to ClikDeploy ${args.app ? `app ${args.app}` : 'platform'} secret ${args.key}. The value is not shown to the agent.`,
  async run(args, ctx) {
    try {
      if (args.destination !== 'clikdeploy') throw new Error('Unknown destination.');
      if (!/^[A-Z][A-Z0-9_]{1,80}$/.test(args.key)) throw new Error('The destination key is an upper-case name such as SALAD_API_KEY.');
      const value = await readNamedSecret(ctx.stateDir, args.secret);
      registerSecret(value);
      const out = await new Promise<{ code: number | null; text: string; missing: boolean }>(resolve => {
        const child = spawn('clikdeploy', clikdeployCall(args, value), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        let text = '';
        const timer = setTimeout(() => child.kill(), 60_000);
        const stop = (): void => { child.kill(); };
        ctx.signal?.addEventListener('abort', stop, { once: true });
        child.stdout.on('data', chunk => { text = (text + String(chunk)).slice(-20_000); });
        child.stderr.on('data', chunk => { text = (text + String(chunk)).slice(-20_000); });
        child.once('error', error => { clearTimeout(timer); resolve({ code: null, text: '', missing: (error as NodeJS.ErrnoException).code === 'ENOENT' }); });
        child.once('close', code => { clearTimeout(timer); ctx.signal?.removeEventListener('abort', stop); resolve({ code, text, missing: false }); });
      });
      if (out.missing) throw new Error('The clikdeploy command is not installed on this computer.');
      let status = '';
      try {
        const parsed = JSON.parse(out.text) as { status?: string; message?: string; data?: { appliedToWebProcess?: boolean; reloadReason?: string } };
        status = [parsed.status, parsed.message, parsed.data?.appliedToWebProcess !== undefined ? `appliedToWebProcess=${parsed.data.appliedToWebProcess}` : '', parsed.data?.reloadReason].filter(Boolean).join(' · ');
      } catch { status = out.text.trim().split('\n').slice(-3).join(' '); }
      const ok = out.code === 0;
      return { output: scrubSecrets(`${ok ? `Stored "${args.secret}" in ClikDeploy as ${args.key}.` : `ClikDeploy did not store ${args.key}.`} ${status}`.trim()), ...(ok ? {} : { isError: true }) };
    } catch (error) { return { output: scrubSecrets(error instanceof Error ? error.message : String(error)), isError: true }; }
  },
});
