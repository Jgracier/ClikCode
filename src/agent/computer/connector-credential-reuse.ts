// Credentials stay inside the vault/destination path. Family reuse is restricted to
// the explicitly named AWS key and signed AWS specs on AWS-owned public origins.
export function credentialNames(id: string, spec: { id?: string; auth?: { signing?: { scheme?: string } }; http?: { baseUrl?: string } }, available: readonly string[]): string[] {
  const names = available.includes(`${id}/key`) ? [`${id}/key`] : [];
  const url = spec.http?.baseUrl?.replace(/\{region\}/g, 'us-east-1');
  let aws = false;
  try { const u = new URL(url ?? ''); aws = u.protocol === 'https:' && /(^|\.)amazonaws\.com(?:\.cn)?$/.test(u.hostname) && !u.username && !u.password; } catch { /* an incomplete definition cannot receive a family key */ }
  if (spec.id === id && id.startsWith('amazonaws-') && spec.auth?.signing?.scheme === 'aws-sigv4' && aws && available.includes('aws/clikdeploy-connector-key')) names.push('aws/clikdeploy-connector-key');
  return names;
}

export async function reuseConnectorCredential(id: string, stateDir: string, signal?: AbortSignal): Promise<boolean | { problem: string }> {
  const { namedSecretNames, readNamedSecret } = await import('./credential-vault.js');
  const names = await namedSecretNames(stateDir);
  if (!names.includes(`${id}/key`) && !(id.startsWith('amazonaws-') && names.includes('aws/clikdeploy-connector-key'))) return false;
  const { liveClient } = await import('./connector-runner-live.js');
  const data = await liveClient(signal).tool('connector_spec_get', { id }) as { spec?: { id?: string; auth?: { signing?: { scheme?: string } }; http?: { baseUrl?: string }; connectionValues?: Record<string, unknown> } };
  if (!data.spec) return false;
  const { scrubSecrets } = await import('./secret-scrubber.js');
  const problems: string[] = [];
  const { sendToDestinations } = await import('./secret-destinations.js');
  for (const name of credentialNames(id, data.spec, names)) {
    const value = await readNamedSecret(stateDir, name);
    if (!value) continue;
    const values = name.startsWith('aws/') && data.spec.connectionValues?.region ? { region: 'us-east-1' } : undefined;
    const deliveries = await sendToDestinations(stateDir, [{ to: 'clikdeploy-connection', with: { integration: id }, ...(values ? { connectionValues: values } : {}) }], value, signal);
    if (deliveries.length && deliveries.every(d => d.ok)) return true;
    problems.push(...deliveries.filter(d => !d.ok).map(d => scrubSecrets(d.message).slice(0, 600)));
  }
  return problems.length ? { problem: problems.join('; ') } : false;
}
