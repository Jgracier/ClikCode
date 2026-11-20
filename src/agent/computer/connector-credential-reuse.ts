// Credentials stay inside the vault/destination path. Family reuse is restricted to
// the explicitly named AWS key and signed AWS specs on AWS-owned public origins.
export function credentialNames(id: string, spec: { id?: string; auth?: { signing?: { scheme?: string } }; http?: { baseUrl?: string } }, available: readonly string[]): string[] {
  const names = available.includes(`${id}/key`) ? [`${id}/key`] : [];
  const url = spec.http?.baseUrl?.replace(/\{region\}/g, 'us-east-1');
  let aws = false;
  try { const u = new URL(url ?? ''); aws = u.protocol === 'https:' && /(^|\.)amazonaws\.com(?:\.cn)?$/.test(u.hostname) && !u.username && !u.password; } catch { /* fail-open-ok: an incomplete definition cannot receive a family key */ }
  if (spec.id === id && id.startsWith('amazonaws-') && spec.auth?.signing?.scheme === 'aws-sigv4' && aws && available.includes('aws/clikdeploy-connector-key')) names.push('aws/clikdeploy-connector-key');
  return names;
}

/** Saved names that hold a basic-auth username, in the order they are looked for. */
const USERNAME_NAMES = ['login', 'username', 'user', 'email',
  // A key's own id is the username of vendors that sign with a key id and secret: Twilio (sid, key-sid, api-key-sid), and the client and
  // key ids others use. Saved under these names by agents, they were not looked for, so a saved Twilio key never reached its connector.
  'sid', 'key-sid', 'api-key-sid', 'account-sid', 'key-id', 'client-id', 'app-id'];
/** Where a saved key goes for a basic-auth connector: the basic form with the saved username, or 'no-username' when none is saved.
 * Undefined for any other auth, which keeps the API-key form. */
export function basicDestination(id: string, kind: string | undefined, names: readonly string[]): { to: string; with: Record<string, string> } | 'no-username' | undefined {
  if (kind !== 'basic') return undefined;
  const username = USERNAME_NAMES.map(n => `${id}/${n}`).find(n => names.includes(n));
  return username ? { to: 'clikdeploy-connection-basic', with: { integration: id, username: `secret:${username}` } } : 'no-username';
}

/** Why a saved credential did not connect, as far as the vendor's answer says. `oauth`: the connector is OAuth now, so a saved key is
 * not its credential; `rejected`: the vendor refused the key itself (401/403), so the key is dead and a new one is wanted; `unreachable`:
 * the vendor did not answer, which says nothing about the key; `repair`: anything else (shape, missing values), for an agent. */
export type ReuseCause = 'oauth' | 'rejected' | 'unreachable' | 'repair';
export function reuseCause(problem: string): ReuseCause {
  if (/uses OAuth|oauth\/start/i.test(problem)) return 'oauth';
  if (/rejected this key \(HTTP 40[13]\)|\b(?:invalid|revoked|expired) (?:api )?key\b/i.test(problem)) return 'rejected';
  if (/could not reach|no answer within|timed? ?out|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|HTTP 5\d\d/i.test(problem)) return 'unreachable';
  return 'repair';
}

/** A key the vendor refused is set aside (kept as <name>-rejected, so nothing is lost) and the next capture makes a fresh one. */
export async function setAsideRejectedKey(id: string, stateDir: string): Promise<boolean> {
  const { readNamedSecret, saveNamedSecret, deleteNamedSecret } = await import('./credential-vault.js');
  const value = await readNamedSecret(stateDir, `${id}/key`);
  if (!value) return false;
  await saveNamedSecret(stateDir, `${id}/key-rejected`, value, { vendor: id });
  return deleteNamedSecret(stateDir, `${id}/key`);
}

export async function reuseConnectorCredential(id: string, stateDir: string, signal?: AbortSignal): Promise<boolean | { problem: string; cause: ReuseCause }> {
  const { namedSecretNames, readNamedSecret } = await import('./credential-vault.js');
  const names = await namedSecretNames(stateDir);
  if (!names.includes(`${id}/key`) && !(id.startsWith('amazonaws-') && names.includes('aws/clikdeploy-connector-key'))) return false;
  const { liveClient } = await import('./connector-runner-live.js');
  const data = await liveClient(signal).tool('connector_spec_get', { id }) as { spec?: { id?: string; auth?: { kind?: string; signing?: { scheme?: string } }; http?: { baseUrl?: string }; connectionValues?: Record<string, unknown> } };
  if (!data.spec) return false;
  // An OAuth connector's credential is its consent, not a key: a key saved for it earlier (before the spec moved to OAuth) is never sent.
  const auth = data.spec.auth as { kind?: string; oauth?: { credentialOwner?: string } } | undefined;
  if (auth?.kind === 'oauth' && auth.oauth?.credentialOwner !== 'user') return false;
  const { scrubSecrets } = await import('./secret-scrubber.js');
  const problems: string[] = [];
  const { sendToDestinations } = await import('./secret-destinations.js');
  for (const name of credentialNames(id, data.spec, names)) {
    const value = await readNamedSecret(stateDir, name);
    if (!value) continue;
    const values = name.startsWith('aws/') && data.spec.connectionValues?.region ? { region: 'us-east-1' } : undefined;
    // The form follows the spec's auth. A basic-auth key is the password, and its username is the one saved beside it; without one,
    // nothing is sent (the API-key form was refused for every basic-auth vendor, DataForSEO among them).
    const destination = basicDestination(id, data.spec.auth?.kind, names);
    if (destination === 'no-username') { problems.push(`${id} declares basic auth and no username is saved beside its key: save it as ${id}/login, then onboard again`); continue; }
    const deliveries = await sendToDestinations(stateDir, [destination ?? { to: 'clikdeploy-connection', with: { integration: id }, ...(values ? { connectionValues: values } : {}) }], value, signal);
    if (deliveries.length && deliveries.every(d => d.ok)) return true;
    problems.push(...deliveries.filter(d => !d.ok).map(d => scrubSecrets(d.message).slice(0, 600)));
  }
  if (!problems.length) return false;
  const problem = problems.join('; ');
  return { problem, cause: reuseCause(problem) };
}
