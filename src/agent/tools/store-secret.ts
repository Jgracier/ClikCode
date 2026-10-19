/** Sends a secret already saved in Secrets Manager to the destinations the agent
 * names: the same `send_to` that `capture_secret` takes. For sending again after a
 * destination failed, or to another place later. The worker reads the value and
 * runs the command, so the value is in nothing the model writes or reads. */
import { defineTool } from '../tool-contract.js';
import { readNamedSecret } from '../computer/credential-vault.js';
import { destinationProblem, normalizeSendTo, sendToDestinations, type Destination } from '../computer/secret-destinations.js';
import { registerSecret, scrubSecrets } from '../computer/secret-scrubber.js';

type Args = { secret: string; to?: string; with?: Record<string, string> | string; send_to?: Destination[] | Destination | string };

const DESTINATION = { type: 'object', additionalProperties: false, required: ['to'], properties: { to: { type: 'string' }, with: { type: 'object' } } };
/** One {to, with} or a list of them. */
export const SEND_TO_SCHEMA = { type: ['array', 'object', 'string'], items: DESTINATION, additionalProperties: false, properties: DESTINATION.properties };

export const SEND_TO_HELP = 'Where the key goes, decided now: {to, with} or a list of them, e.g. {to:"clikdeploy-secret", with:{key:"SALAD_API_KEY"}}. Destinations: clikdeploy-secret (key) sets a ClikDeploy platform secret; clikdeploy-app-secret (app, key); clikdeploy-compute (provider, field) fills one field of a compute provider card, e.g. {to:"clikdeploy-compute", with:{provider:"GCP", field:"serviceAccountJson"}}; clikdeploy-connector (integration, client_id) registers a connector\'s OAuth app: the key is its client secret, the client id (not a secret) is the slot, e.g. {to:"clikdeploy-connector", with:{integration:"googlesheets", client_id:"1234-abc.apps.googleusercontent.com"}}; github-secret (repo, key). The user may have added others (an unknown name is answered with the full list).';

export const storeSecretTool = defineTool<Args>({
  name: 'store_secret', class: 'exec',
  description: 'Send a secret saved in ClikCode Secrets Manager on to other places without seeing it. Normally capture_secret does this in one step with the same send_to; use this to send again. ' + SEND_TO_HELP,
  parameters: { type: 'object', additionalProperties: false, required: ['secret'], properties: {
    secret: { type: 'string', description: 'Name the key was saved under.' },
    to: { type: 'string', description: 'The destination name, e.g. clikdeploy-secret.' },
    with: { type: ['object', 'string'], description: 'Values for the destination\'s slots, e.g. {key:"SALAD_API_KEY"}.' },
    send_to: { ...SEND_TO_SCHEMA, description: 'Several destinations at once: a list of {to, with}. For one, use to and with.' },
  } },
  label: (args) => `Send ${args.secret}`,
  async run(args, ctx) {
    try {
      const withSlots = typeof args.with === 'string' ? (() => { try { return JSON.parse(args.with) as Record<string, string>; } catch { return undefined; } })() : args.with;
      const plan = normalizeSendTo(args.send_to ?? (args.to ? { to: args.to, ...(withSlots ? { with: withSlots } : {}) } : undefined));
      if (!plan?.length) throw new Error('Say where it goes: to and with, e.g. {"to":"clikdeploy-secret","with":{"key":"SALAD_API_KEY"}}.');
      const problem = await destinationProblem(ctx.stateDir, plan);
      if (problem) throw new Error(problem);
      const value = await readNamedSecret(ctx.stateDir, args.secret);
      registerSecret(value);
      const sent = await sendToDestinations(ctx.stateDir, plan, value, ctx.signal);
      const output = sent.map(delivery => `${delivery.ok ? 'SENT' : 'NOT SENT'} - ${delivery.label}: ${delivery.message}`).join('\n');
      return { output: scrubSecrets(output), ...(sent.every(delivery => delivery.ok) ? {} : { isError: true }) };
    } catch (error) { return { output: scrubSecrets(error instanceof Error ? error.message : String(error)), isError: true }; }
  },
});
