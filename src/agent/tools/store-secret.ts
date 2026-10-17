/** Sends a secret already saved in Secrets Manager to the destinations the agent
 * names: the same `send_to` that `capture_secret` takes. For sending again after a
 * destination failed, or to another place later. The worker reads the value and
 * runs the command, so the value is in nothing the model writes or reads. */
import { defineTool } from '../tool-contract.js';
import { readNamedSecret } from '../computer/credential-vault.js';
import { destinationProblem, sendToDestinations, type Destination } from '../computer/secret-destinations.js';
import { registerSecret, scrubSecrets } from '../computer/secret-scrubber.js';

type Args = { secret: string; send_to: Destination[] };

export const SEND_TO_SCHEMA = {
  type: 'array', minItems: 1,
  items: { type: 'object', additionalProperties: false, required: ['to'], properties: { to: { type: 'string' }, with: { type: 'object' } } },
};

export const SEND_TO_HELP = 'Where the key goes, decided now: [{to, with}]. Destinations: clikdeploy-secret (key) sets a ClikDeploy platform secret; clikdeploy-app-secret (app, key); clikdeploy-compute (provider, field) fills one field of a compute provider card, e.g. {to:"clikdeploy-compute", with:{provider:"GCP", field:"serviceAccountJson"}}; github-secret (repo, key). The user may have added others (an unknown name is answered with the full list).';

export const storeSecretTool = defineTool<Args>({
  name: 'store_secret', class: 'exec',
  description: 'Send a secret saved in ClikCode Secrets Manager on to other places without seeing it. Normally capture_secret does this in one step with the same send_to; use this to send again. ' + SEND_TO_HELP,
  parameters: { type: 'object', additionalProperties: false, required: ['secret', 'send_to'], properties: {
    secret: { type: 'string', description: 'Name the key was saved under.' },
    send_to: SEND_TO_SCHEMA,
  } },
  label: (args) => `Send ${args.secret}`,
  async run(args, ctx) {
    try {
      const problem = await destinationProblem(ctx.stateDir, args.send_to);
      if (problem) throw new Error(problem);
      const value = await readNamedSecret(ctx.stateDir, args.secret);
      registerSecret(value);
      const sent = await sendToDestinations(ctx.stateDir, args.send_to, value, ctx.signal);
      const output = sent.map(delivery => `${delivery.ok ? 'SENT' : 'NOT SENT'} - ${delivery.label}: ${delivery.message}`).join('\n');
      return { output: scrubSecrets(output), ...(sent.every(delivery => delivery.ok) ? {} : { isError: true }) };
    } catch (error) { return { output: scrubSecrets(error instanceof Error ? error.message : String(error)), isError: true }; }
  },
});
