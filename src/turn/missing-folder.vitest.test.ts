/** A turn in a folder this machine does not have stops before anything is started there, and
 * says which folder and which machine -- not `spawn <binary> ENOENT`, which read as a harness
 * that is not installed. Nothing is asked of the account: it is not a spent plan. */
import { mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type Conf from 'conf';
import { writeState } from '../session/state/write';
import type { HarnessSession, HarnessState } from '../session/model';
import { machineName } from '../runtime/machine-folder';
import { runSessionTurn } from './session-turn';

const previousHome = process.env.CLIKCODE_HOME;
beforeEach(() => { process.env.CLIKCODE_HOME = mkdtempSync(join(tmpdir(), 'cc-missing-folder-')); });
afterEach(() => {
  if (previousHome === undefined) delete process.env.CLIKCODE_HOME;
  else process.env.CLIKCODE_HOME = previousHome;
});

it('refuses a turn whose folder is not on this machine, naming both', async () => {
  const missing = '/clikcode-test-no-such-folder/on-the-editor-machine';
  const session = {
    id: 's1', conversationId: 's1', route: 'local', accountId: 'a1', provider: 'vendor', model: 'm', effort: 'high',
    permissionMode: 'auto', nativeHarness: 'claude', messages: [], workspace: missing,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', status: 'active',
  } as unknown as HarnessSession;
  await writeState({ sessions: [session], accounts: [], invocations: [], providerSettings: {}, globalSettings: { effort: 'medium', permissionMode: 'ask' } } as unknown as HarnessState);
  await expect(runSessionTurn({} as Conf, 's1', 'hello')).rejects.toThrow(
    `The folder ${missing} does not exist on ${machineName()}. Open the chat again to continue it in ${homedir()}.`,
  );
});
