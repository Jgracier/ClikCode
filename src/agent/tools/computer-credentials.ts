/** Save and fill a website login without putting the secret in tool output. */
import { defineTool } from '../tool-contract.js';
import { computerPage } from '../computer/browser.js';
import { computerEnabled } from '../computer/settings.js';
import { CredentialError, fillCredential } from '../computer/credential-vault.js';
import { requestTailcatCredential } from '../computer/tailcat-credentials.js';

type Args = { action: 'request' | 'fill'; item_id?: string };
export const computerCredentialsTool = defineTool<Args>({
  name: 'computer_credentials', class: 'exec',
  description: 'For a site login, ask the user for account ID, email, and password through a private phone form. The values go directly to the local encrypted vault over Tailcat, without ClikDeploy or a Tailscale sign-in. This tool returns only an opaque saved login reference. Fill that reference on the same HTTPS website. Never ask for credentials in chat.',
  parameters: { type: 'object', additionalProperties: false, required: ['action'], properties: {
    action: { type: 'string', enum: ['request', 'fill'] },
    item_id: { type: 'string', description: 'Opaque saved login reference returned by request, required for fill.' },
  } },
  label: args => args.action === 'request' ? 'Request private login' : 'Fill private login',
  async run(args, ctx) {
    if (!(await computerEnabled(ctx.stateDir))) return { output: 'Computer use is off.', isError: true };
    try {
      const page = await computerPage(ctx.stateDir);
      const site = new URL(page.url());
      if (site.protocol !== 'https:') throw new CredentialError('Private credentials require an HTTPS website.');
      if (args.action === 'fill') {
        if (!args.item_id) throw new CredentialError('Fill needs a saved login reference.');
        await fillCredential(ctx.stateDir, page, args.item_id);
        return { output: 'Saved login filled this website. Credentials were not included in the tool result.' };
      }
      if (args.action !== 'request') throw new CredentialError('Unknown credential action.');
      const id = await requestTailcatCredential({ stateDir: ctx.stateDir, site: site.origin, signal: ctx.signal,
        onLink: link => ctx.emitOutput?.(`Open this private login form for ${site.origin}: ${link}\n`) });
      return { output: `Saved a login for ${site.origin}. Reference: ${id}. Use computer_credentials fill with this reference on the same site.` };
    } catch (error) {
      return { output: error instanceof Error ? error.message : 'Private login request failed.', isError: true };
    }
  },
});
