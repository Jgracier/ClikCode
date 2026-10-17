/** Sends a secret already saved in Secrets Manager to the destinations the agent
 * names, the same plan `capture_secret` takes as `send_to`. For sending again
 * after a destination failed, or to another place later. The worker reads the
 * value and runs the command, so the value is in nothing the model writes or reads. */
import { defineTool } from '../tool-contract.js';
import { readNamedSecret } from '../computer/credential-vault.js';
import { describeDestinations, destinationProblem, sendToDestinations, type Destination } from '../computer/secret-destinations.js';
import { registerSecret, scrubSecrets } from '../computer/secret-scrubber.js';

type Args = { secret: string; send_to: Destination[] };

export const SEND_TO_SCHEMA = {
  type: 'array', minItems: 1,
  items: { type: 'object', additionalProperties: false, required: ['type'], properties: {
    type: { type: 'string', enum: ['clikdeploy', 'github'] }, tool: { type: 'string' }, args: { type: 'object' }, repo: { type: 'string' }, name: { type: 'string' },
  } },
};

export const storeSecretTool = defineTool<Args>({
  name: 'store_secret', class: 'exec',
  description: 'Send a secret saved in ClikCode Secrets Manager to other services without showing you its value. send_to lists the destinations: {type:"clikdeploy", tool, args} runs that ClikDeploy CLI tool, with the string {{secret}} inside args marking where the key goes (for example admin_platform_set_secret with {key:"SALAD_API_KEY", value:"{{secret}}"}, or admin_compute_save_credentials with {provider:"GCP", credentials:{serviceAccountJson:"{{secret}}"}}; `clikdeploy tools search` and `tools describe` show what exists); {type:"github", repo:"owner/name", name:"SECRET_NAME"} sets a repository secret. Normally capture_secret takes the same send_to and does this in one step; use this to send again. Asks the user to approve the plan.',
  parameters: { type: 'object', additionalProperties: false, required: ['secret', 'send_to'], properties: {
    secret: { type: 'string', description: 'Name given to capture_secret.' },
    send_to: SEND_TO_SCHEMA,
  } },
  label: (args) => `Send secret ${args.secret}`,
  describe: async (args) => `Send saved secret "${args.secret}" (its value is not shown to the agent) to:\n${describeDestinations(args.send_to ?? [])}`,
  async run(args, ctx) {
    try {
      const problem = destinationProblem(args.send_to);
      if (problem) throw new Error(problem);
      const value = await readNamedSecret(ctx.stateDir, args.secret);
      registerSecret(value);
      const sent = await sendToDestinations(args.send_to, value, ctx.signal);
      const output = sent.map(delivery => `${delivery.ok ? 'Sent' : 'FAILED'} - ${delivery.label}: ${delivery.message}`).join('\n');
      return { output: scrubSecrets(output), ...(sent.every(delivery => delivery.ok) ? {} : { isError: true }) };
    } catch (error) { return { output: scrubSecrets(error instanceof Error ? error.message : String(error)), isError: true }; }
  },
});
