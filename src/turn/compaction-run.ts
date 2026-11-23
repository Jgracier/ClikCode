/** Running ClikCode's compaction (turn/compaction.ts) on a conversation: which mechanism its
 * harness has, and what the conversation keeps of it. */
import { declaredHarnessCommands } from '../harness/declared-commands.js';
import type { AiLocalHarnessDefinition } from '../harness/definition.js';
import type { HarnessSession } from '../session/model.js';
import { forgetNativeThread } from '../session/native-thread.js';
import { readState } from '../session/state/read.js';
import { writeState } from '../session/state/write.js';
import { compactionMechanism, type CompactionMechanism } from './compaction.js';
import { knownVendorCommands } from './vendor-commands.js';
import { leavePersistentTransport, nativeAvailableCommands } from './vendor-process.js';

/** How this conversation's harness compacts: from the catalog, and every command it has said it runs. */
export function sessionCompactionMechanism(session: Pick<HarnessSession, 'id'>, harness: AiLocalHarnessDefinition): CompactionMechanism {
  const commands = [
    ...nativeAvailableCommands.get(session.id) ?? [], ...knownVendorCommands(harness.command), ...declaredHarnessCommands(harness.command),
  ].map((command) => command.name);
  return compactionMechanism(harness, commands);
}

/** Whether there is a vendor thread to compact. */
export const hasThreadToCompact = (session: Pick<HarnessSession, 'nativeSessionId' | 'nativeSessionPreallocated' | 'messages'>): boolean =>
  Boolean(session.nativeSessionId && !session.nativeSessionPreallocated && session.messages?.length);

async function updateSession(id: string, change: (session: HarnessSession) => void): Promise<void> {
  const state = await readState({ transcripts: [id] });
  const session = state.sessions.find((item) => item.id === id);
  if (!session) return;
  change(session);
  await writeState(state);
}

/** A native compaction finished: what the conversation keeps of it (the guard's starting point). */
export async function recordCompaction(id: string): Promise<void> {
  await updateSession(id, (session) => {
    session.compaction = { at: new Date().toISOString(), through: session.messages?.length ?? 0 };
  });
}

/** A harness with no native compaction: its thread is let go, and the next turn takes the
 * conversation up afresh, fitted to half the threshold (vendor-thread-takeup.ts). Nothing of
 * ClikCode's record is removed. */
export async function compactByRewrite(id: string): Promise<void> {
  await leavePersistentTransport(id);
  await updateSession(id, (session) => {
    forgetNativeThread(session);
    session.compaction = { at: new Date().toISOString(), through: session.messages?.length ?? 0, rewrite: true };
  });
}
