/** `clikcode remote-info`: what ClikCode Remote reads of an installation it
 * made (install.ts verify): this build's version and commit, and the
 * installation id of this machine's ClikCode state. One JSON line. */
import { CLIKCODE_COMMIT, CLIKCODE_VERSION } from '../version.js';
import { readState } from '../session/state/read.js';

export async function printRemoteInfo(): Promise<void> {
  const installationId = await readState({ transcripts: [] }).then((state) => state.installationId, () => undefined);
  process.stdout.write(`${JSON.stringify({ version: CLIKCODE_VERSION, ...(CLIKCODE_COMMIT ? { commit: CLIKCODE_COMMIT } : {}), ...(installationId ? { installationId } : {}) })}\n`);
}
