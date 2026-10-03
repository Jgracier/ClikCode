/** A separate ClikCode process for the concurrency tests: bundled and run by
 * concurrency.ts against the CLIKCODE_HOME it is given. Not shipped. */

import { forceStoreSession, unforceStoreSession } from '../../ephemeral.js';
import type { HarnessSession } from '../../model.js';
import { open, unlink } from 'node:fs/promises';
import { withFileLock } from '../../store/locks.js';
import { readState } from '../read.js';
import { writeState } from '../write.js';

const [scenario, id = '', tag = '', countText = '0'] = process.argv.slice(2);
const count = Number(countText);

async function main(): Promise<void> {
  if (scenario === 'rewrite') {
    // Rewrites the history of `id` (not an append), every write fresh.
    for (let step = 0; step < count; step += 1) {
      const state = await readState();
      const session = state.sessions.find((item) => item.id === id)!;
      session.messages = (session.messages ?? []).map((message, index) => index === 0 ? { ...message, content: `${tag} ${step}` } : message);
      session.updatedAt = new Date().toISOString();
      await writeState(state);
    }
  } else if (scenario === 'append-fresh') {
    // Appends to `id`, reading fresh before every write.
    for (let step = 0; step < count; step += 1) {
      const state = await readState();
      const session = state.sessions.find((item) => item.id === id)!;
      session.messages = [...(session.messages ?? []), { role: 'user', content: `${tag} ${step}` }];
      await writeState(state);
    }
  } else if (scenario === 'append-held') {
    // Appends to `id` from one long-lived snapshot, the way a worker does.
    const state = await readState();
    const session = state.sessions.find((item) => item.id === id)!;
    for (let step = 0; step < count; step += 1) {
      session.messages = [...(session.messages ?? []), { role: 'user', content: `${tag} ${step}` }];
      await writeState(state);
    }
  } else if (scenario === 'store-blank') {
    // Stores an empty chat for another process to use, as a window does for
    // its turn's worker (ensureSessionOnDisk).
    const state = await readState();
    const at = new Date().toISOString();
    state.sessions.push({
      id, route: 'gateway', accountId: null, provider: 'gateway', model: null, effort: 'platform-managed', permissionMode: 'bypass',
      accountFailover: 'never', createdAt: at, updatedAt: at, status: 'active',
    } as HarnessSession);
    forceStoreSession(id);
    try { await writeState(state); } finally { unforceStoreSession(id); }
  } else if (scenario === 'contend') {
    // Takes the lock at `id` (a path) `count` times; inside, proves it is
    // the only holder by creating a marker exclusively.
    for (let step = 0; step < count; step += 1) {
      await withFileLock(id, async () => {
        const marker = await open(`${id}.inside`, 'wx').catch(() => undefined);
        if (!marker) throw new Error('two holders at once');
        await marker.close();
        await new Promise((resolve) => setTimeout(resolve, 1));
        await unlink(`${id}.inside`);
      });
    }
  } else throw new Error(`unknown scenario ${scenario}`);
}

main().then(() => process.exit(0), (error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
