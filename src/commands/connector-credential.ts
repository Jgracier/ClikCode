/** `clikcode connectors credential prepare|status|forget`: the connector loop's own ClikDeploy key (connector-loop-key.ts).
 * Nothing here prints the key: `prepare` prints only its SHA-256, which is what ClikDeploy is given. */
import { callWithLoopKey, connectorLoopKey, forgetConnectorLoopKey, prepareConnectorLoopKey, CONNECTOR_LOOP_SECRET, DEFAULT_PLATFORM } from '../agent/computer/connector-loop-key.js';
import { unwrapTool } from '../agent/computer/connector-runner-live.js';

const say = (text: string): void => void process.stdout.write(`${text}\n`);

export async function connectorCredentialPrepare(flags: { platform?: string }): Promise<void> {
  const platform = (flags.platform ?? DEFAULT_PLATFORM).replace(/\/+$/, '');
  if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(platform)) throw new Error('--platform must be an https origin, e.g. https://clikdeploy.com');
  const { keyHash } = await prepareConnectorLoopKey(undefined, platform);
  say(`A new connector-loop key is saved in the ClikCode vault as ${CONNECTOR_LOOP_SECRET} (for ${platform}).`);
  say(`Its SHA-256 (give ClikDeploy this, never the key): ${keyHash}`);
  say('Register it as a person, with the authenticator and the super-admin password: ClikDeploy tool admin_connector_loop_credential_issue {"keyHash":"<the hash above>"}');
  say('Until it is registered the loop\'s connector calls are refused; `clikcode connectors credential forget` goes back to the CLI key.');
}

export async function connectorCredentialStatus(): Promise<void> {
  const loop = await connectorLoopKey();
  if (!loop) { say('No connector-loop key is saved: the loop uses the person\'s clikdeploy CLI key (held on writes without a live authenticator unlock).'); return; }
  let check: string;
  try {
    const data = unwrapTool(await callWithLoopKey(loop, 'connector_work_overview', { limit: 1 }, { timeoutMs: 25_000 })) as { total?: number };
    check = `accepted (the queue holds ${data.total ?? '?'} items)`;
  } catch (error) { check = `refused: ${(error instanceof Error ? error.message : String(error)).slice(0, 240)}`; }
  say(`The connector loop uses its own key (${CONNECTOR_LOOP_SECRET}) at ${loop.platform}: ${check}.`);
}

export async function connectorCredentialForget(): Promise<void> {
  const removed = await forgetConnectorLoopKey();
  say(removed ? `Removed ${CONNECTOR_LOOP_SECRET}: the loop goes back to the person's CLI key. Revoke it at ClikDeploy too (admin_connector_loop_credential_revoke).` : 'No connector-loop key was saved.');
}
