/** ClikCode reads ClikDeploy's proof verdict; it never calculates connector correctness itself. */
import { runCli } from './run-cli.js';
import { saveTask, type SavedTask } from './work-queue.js';

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export type ConnectorProof = {
  id: string;
  ready: boolean;
  specVersion: string;
  testsDigest: string;
  coverage: { total: number; passing: number; writesNotRun?: number; deliveriesNotRun?: number } | null;
  problems: string[];
  /** ClikDeploy's checklist (absent from an older ClikDeploy): what is finished, what is left with a one-line fix each, and the first thing to do. */
  done?: string[];
  missing?: Array<{ area: string; item: string; fix: string }>;
  next?: string | null;
};

export function parseConnectorProof(text: string, id: string): ConnectorProof {
  const envelope = JSON.parse(text) as { status?: string; error?: { message?: string }; data?: { success?: boolean; data?: unknown } };
  if (envelope.status !== 'success' || envelope.data?.success !== true) throw new Error(envelope.error?.message ?? `ClikDeploy could not read proof for ${id}`);
  const proof = envelope.data.data as Partial<ConnectorProof> | undefined;
  if (!proof || proof.id !== id || typeof proof.ready !== 'boolean' || typeof proof.specVersion !== 'string' || typeof proof.testsDigest !== 'string' || !Array.isArray(proof.problems)) {
    throw new Error(`ClikDeploy returned an invalid proof verdict for ${id}`);
  }
  return proof as ConnectorProof;
}

export async function syncConnectorProof(stateDir: string, id: string): Promise<{ proof: ConnectorProof; task: SavedTask }> {
  if (!ID.test(id)) throw new Error('Connector id must be lower-case letters, digits and dashes.');
  const result = await runCli('clikdeploy', ['tools', 'run', 'connector_proof', '--args-json', JSON.stringify({ id })], { timeoutMs: 35_000 });
  if (result.missing) throw new Error('The clikdeploy CLI is not installed.');
  if (result.code !== 0) throw new Error(`ClikDeploy could not read proof for ${id}.`);
  const proof = parseConnectorProof(result.text, id);
  const task = await saveTask(stateDir, {
    vendor: id,
    kind: 'connector-proof',
    status: proof.ready ? 'done' : 'queued',
    connectors: [id],
    note: proof.ready
      ? `ClikDeploy proof ${proof.specVersion} ${proof.testsDigest}: ${proof.coverage?.passing ?? 0}/${proof.coverage?.total ?? 0} live checks`
      : proof.next ?? proof.problems.slice(0, 3).join('; '),
  });
  return { proof, task };
}
