/** Lists and removes the named secrets in Secrets Manager. Only names cross to
 * the model, never values. Re-capturing a name replaces its value (rotation). */
import { defineTool } from '../tool-contract.js';
import { deleteNamedSecret, namedSecretNames } from '../computer/credential-vault.js';

export const listSecretsTool = defineTool<Record<string, never>>({
  name: 'list_secrets', class: 'read',
  description: 'List the names of secrets saved in ClikCode Secrets Manager. Values are never shown. To rotate a key, capture it again under the same name.',
  parameters: { type: 'object', additionalProperties: false, properties: {} },
  label: () => 'List secrets',
  async run(_args, ctx) {
    try {
      const names = await namedSecretNames(ctx.stateDir);
      return { output: names.length ? `Saved secrets (names only):\n${names.map(name => `- ${name}`).join('\n')}` : 'No secrets are saved.' };
    } catch (error) { return { output: error instanceof Error ? error.message : String(error), isError: true }; }
  },
});

export const deleteSecretTool = defineTool<{ name: string }>({
  name: 'delete_secret', class: 'exec',
  description: 'Delete a secret saved in ClikCode Secrets Manager, by name. Asks the user to approve. It does not touch any copy already stored elsewhere.',
  parameters: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string' } } },
  label: (args) => `Delete secret ${args.name}`,
  describe: async (args) => `Delete saved secret "${args.name}" from ClikCode Secrets Manager.`,
  async run(args, ctx) {
    try { return { output: await deleteNamedSecret(ctx.stateDir, args.name) ? `Deleted secret "${args.name}".` : `No secret named "${args.name}" is saved.` }; }
    catch (error) { return { output: error instanceof Error ? error.message : String(error), isError: true }; }
  },
});
