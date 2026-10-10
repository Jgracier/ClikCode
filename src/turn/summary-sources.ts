/** Where a conversation's summaries are read from (session/conversation-summary.ts):
 * ClikCode's own agent memory, and a vendor thread's transcript, found in the
 * profile of the account that holds it. */
import type { AiHarnessAccount } from '../harness/definition.js';
import type { SummarySources } from '../session/conversation-summary.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { locateNativeSessionFile, nativeSessionRoot } from '../session/discovery/registry.js';
import { stateDirectory } from '../session/store/paths.js';
import { localHarnessForCommand } from '../runtime/lazy-bridge.js';
import { turnEnvironment } from './turn-environment.js';

export function summarySources(accounts: readonly AiHarnessAccount[]): SummarySources {
  return {
    stateDir: stateDirectory(),
    threadFile: async (thread) => {
      const harness = localHarnessForCommand(thread.harness);
      if (!harness) return undefined;
      const account = thread.accountId ? accounts.find((item) => item.id === thread.accountId) : undefined;
      const environment = turnEnvironment(harness, account);
      const located = (await locateNativeSessionFile(harness, thread.id, thread.workspace ?? '', environment))?.path;
      if (located) return located;
      // A store with no lookup by id (Kiro's ACP sessions): `<root>/<id>.jsonl`.
      const root = nativeSessionRoot(harness, environment);
      const file = root ? join(root, `${thread.id}.jsonl`) : undefined;
      return file && existsSync(file) ? file : undefined;
    },
  };
}
