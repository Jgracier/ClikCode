/** Where a person makes an API key at a vendor, as a link anyone can follow: written to the connector's spec (access.keysUrl) the
 * moment a captured key is delivered to ClikDeploy, so the connect form can send the next person straight to that page.
 *
 * The page a key was captured on is often this account's own address (a workspace in the path, a tenant subdomain, an id). Those
 * parts would send everyone else to a page that is not theirs, so they are cut: an account part at the end of the path is dropped
 * (hubspot.com/service-keys/243104553 -> /service-keys); one in the middle, or in the host, leaves no link that works for anyone,
 * so nothing is recorded. */

/** A path segment, or host label, that belongs to one account: an id, a template left in the link, or the person's own name. */
function accountPart(part: string, personal: readonly string[]): boolean {
  const text = decodeURIComponent(part).toLowerCase();
  if (!text) return false;
  if (/^[{<].*[}>]$/.test(text)) return true; // {workspace_id}, <accountId>
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(text)) return true; // a UUID
  if (/^\d{4,}$/.test(text)) return true; // a numeric id
  if (/[0-9a-f]{6,}$/.test(text) && /\d/.test(text) && /[-_]/.test(text)) return true; // default-space-77ef2dde
  if (text.length >= 16 && /\d/.test(text) && /[a-z]/.test(text) && !/[-_.]/.test(text)) return true; // ks78mtvh39kpbabz8ax76x70dd8j80we
  return personal.some(word => word.length >= 4 && text.includes(word));
}

/** The link to record, or undefined when the page is no key page anyone else could open. `personal`: the person's own names and
 * handles (profile names, email local part, company), lower case, which an account's address carries. */
export function publicKeysPage(raw: string, personal: readonly string[]): string | undefined {
  let url: URL;
  try { url = new URL(raw); } catch { return undefined; }
  if (url.protocol !== 'https:' || url.username || url.password) return undefined;
  const host = url.hostname.toLowerCase();
  // A docs page says how to get a key; it is not where one is made.
  if (/^docs?\.|^developers?\.docs\./.test(host) || /\/(?:docs|api-reference|reference)\b/i.test(url.pathname)) return undefined;
  // A tenant host (acme.createsend.com) is this account's alone.
  if (host.split('.').slice(0, -2).some(label => accountPart(label, personal))) return undefined;
  const segments = url.pathname.split('/').filter(Boolean);
  const first = segments.findIndex(segment => accountPart(segment, personal));
  let kept = segments;
  if (first >= 0) {
    // Only a tail can be cut: a page under an account part is that account's page.
    if (segments.slice(first).some(segment => !accountPart(segment, personal))) return undefined;
    kept = segments.slice(0, first);
  }
  // A fragment that names the section (#api-key) helps; anything else (a token, a state) is dropped, as is every query.
  const hash = /^#[a-z][a-z0-9-]{1,40}$/i.test(url.hash) && first < 0 ? url.hash : '';
  return `${url.origin}${kept.length ? `/${kept.join('/')}` : '/'}${hash}`;
}

/** The person's own words an account's address can carry: from the ClikCode profile. Lower case, no short ones. */
export async function personalWords(stateDir: string): Promise<string[]> {
  const words = new Set<string>();
  try {
    const { listProfiles } = await import('./profiles.js');
    for (const profile of await listProfiles(stateDir)) {
      // Only what names the person or their organisation: an address or a job title would match ordinary page words.
      for (const key of ['given_name', 'family_name', 'email', 'sso_email', 'organization', 'website'] as const) {
        const value = profile.fields[key];
        if (typeof value !== 'string') continue;
        const local = value.includes('@') ? value.split('@')[0]! : value.replace(/^https?:\/\//, '').replace(/\.[a-z]+\/?.*$/i, '');
        for (const word of local.toLowerCase().split(/[^a-z0-9]+/)) if (word.length >= 4 && !/^\d+$/.test(word)) words.add(word);
      }
    }
  } catch { /* fail-open-ok: no profile, only the shape rules apply */ }
  return [...words];
}

/** Records where this connector's key is made, after a key from that page reached ClikDeploy: one deterministic write of
 * access.keysUrl, skipped when the spec already says the same. Errors are returned, never thrown: the key is already delivered. */
export async function recordKeysPage(stateDir: string, integration: string, pageUrl: string, deps: { tool?: (name: string, args: Record<string, unknown>) => Promise<unknown> } = {}): Promise<{ recorded?: string; skipped?: string }> {
  const link = publicKeysPage(pageUrl, await personalWords(stateDir));
  if (!link) return { skipped: 'the page is this account\'s own address, not one anyone could open' };
  const tool = deps.tool ?? (async (name: string, args: Record<string, unknown>) => (await import('./connector-runner-live.js')).liveClient().tool(name, args));
  try {
    const current = await tool('connector_spec_get', { id: integration }) as { spec?: { access?: { keysUrl?: string } } };
    if (!current?.spec) return { skipped: `${integration} has no stored spec` };
    if (current.spec.access?.keysUrl === link) return { recorded: link };
    await tool('connector_spec_patch', { id: integration, ops: [{ op: current.spec.access ? 'set' : 'merge', path: current.spec.access ? '/access/keysUrl' : '/', value: current.spec.access ? link : { access: { keysUrl: link } } }] });
    return { recorded: link };
  } catch (error) {
    return { skipped: `could not record it: ${(error instanceof Error ? error.message : String(error)).slice(0, 160)}` };
  }
}
