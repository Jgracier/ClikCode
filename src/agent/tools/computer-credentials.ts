/** Private credential collection over the existing encrypted phone relay. */
import { randomBytes } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import Conf from 'conf';
import { defineTool } from '../tool-contract.js';
import { computerPage } from '../computer/browser.js';
import { computerEnabled } from '../computer/settings.js';
import { decryptAction, type EncryptedPacket } from '../computer/handoff-crypto.js';
import { CredentialError, fillCredential, saveCredential } from '../computer/credential-vault.js';
import { gatewayConnection } from '../models/for-session.js';

type Args = { action: 'request' | 'fill'; item_id?: string };
type Envelope<T> = { success?: boolean; data?: T & { error?: string } };
const TEN_MINUTES = 10 * 60_000;

async function api<T>(url: string, key: string, method: 'GET' | 'POST' | 'DELETE', signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { method, headers: { authorization: `Bearer ${key}`, accept: 'application/json',
    ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
    ...(method === 'POST' ? { body: '{}' } : {}),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) });
  const result = await response.json().catch(() => ({})) as Envelope<T>;
  if (!response.ok || !result.success) throw new Error(result.data?.error ?? `Credential request failed (${response.status}).`);
  return result.data as T;
}

export const computerCredentialsTool = defineTool<Args>({
  name: 'computer_credentials', class: 'exec',
  description: 'For a site login, request account ID, email, and password through a private form that saves them in an encrypted local vault. The values never appear in this tool call or result. Later fill the opaque saved login reference into the same HTTPS website. Do not ask for credentials in chat.',
  parameters: { type: 'object', additionalProperties: false, required: ['action'], properties: {
    action: { type: 'string', enum: ['request', 'fill'] },
    item_id: { type: 'string', description: 'Opaque saved login reference returned by request, required for fill.' },
  } },
  label: (args) => args.action === 'request' ? 'Request private login' : 'Fill private login',
  async run(args, ctx) {
    if (!(await computerEnabled(ctx.stateDir))) return { output: 'Computer use is off.', isError: true };
    let sessionId: string | undefined;
    let root: string | undefined;
    let apiKey: string | undefined;
    try {
      const page = await computerPage(ctx.stateDir);
      const site = new URL(page.url());
      if (site.protocol !== 'https:') throw new Error('Private credentials require an HTTPS website.');
      if (args.action !== 'request' && args.action !== 'fill') throw new CredentialError('Unknown credential action.');
      if (args.action === 'fill' && !args.item_id) throw new CredentialError('Fill needs a saved login reference.');
      if (args.action === 'fill') {
        await fillCredential(ctx.stateDir, page, args.item_id!);
        return { output: 'Saved login filled this website. Credentials were not included in the tool result.' };
      }
      const connection = gatewayConnection(new Conf({ projectName: 'clikcode', configFileMode: 0o600 }));
      apiKey = connection.apiKey;
      root = `${new URL(connection.baseUrl).origin}/api/clikcode/v1/computer`;
      const created = await api<{ id: string; expiresAt: number }>(root, apiKey, 'POST', ctx.signal);
      sessionId = created.id;
      const key = randomBytes(32);
      const mode = 'credential';
      const fragment = new URLSearchParams({ key: key.toString('base64url'), mode, site: site.origin });
      const link = `${new URL(connection.baseUrl).origin}/computer/handoff/${sessionId}#${fragment}`;
      ctx.emitOutput?.(`Open this private form to save a login for ${site.origin}: ${link}\n`);
      const deadline = Math.min(created.expiresAt, Date.now() + TEN_MINUTES);
      let lastSeq = 0;
      while (Date.now() < deadline) {
        const next = await api<{ status: 'active' | 'done'; packet: EncryptedPacket | null }>(`${root}/${sessionId}/action`, apiKey, 'GET', ctx.signal);
        if (next.packet && next.packet.seq > lastSeq) {
          lastSeq = next.packet.seq;
          const input = decryptAction(key, sessionId, next.packet);
          if (args.action === 'request' && input.kind === 'credential') {
            const { accountId, email, password } = input;
            const id = await saveCredential(ctx.stateDir, site.origin, { accountId, email, password });
            return { output: `Saved a login for ${site.origin}. Reference: ${id}. Use computer_credentials fill with this reference on the same site.` };
          }
          throw new CredentialError('This form sent an unsupported action.');
        }
        if (next.status === 'done') throw new Error('The private credential form was closed without saving.');
        await pause(900, undefined, { signal: ctx.signal });
      }
      throw new Error('The private credential request expired.');
    } catch (error) { return { output: error instanceof CredentialError ? error.message : 'Credential request failed. Check the website and try again.', isError: true }; }
    finally { if (sessionId && root && apiKey) await api(`${root}/${sessionId}`, apiKey, 'DELETE').catch(() => undefined); }
  },
});
