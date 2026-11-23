/** Running ClikCode's compaction (turn/compaction.ts) on a conversation: which mechanism its
 * harness has, and what the conversation keeps of it. */
import { declaredHarnessCommands } from '../harness/declared-commands.js';
import type { AiLocalHarnessDefinition } from '../harness/definition.js';
import type { HarnessSession, HarnessState } from '../session/model.js';
import { forgetNativeThread } from '../session/native-thread.js';
import { readState } from '../session/state/read.js';
import { writeState } from '../session/state/write.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stateDirectory } from '../session/store/paths.js';
import { modelsDevFiles } from '../harness/accounts/goose-discovery.js';
import { compactAt, compactionMechanism, type CompactionMechanism } from './compaction.js';
import { targetContextWindow } from './transfer.js';
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

/** What tells a vendor that compacts at a threshold of its own (catalog `compactThreshold`) to do
 * so at ClikCode's: the threshold in tokens, or a settings file of the vendor's lowest precedence
 * holding it as a share of the model's window (Gemini's `model.compressionThreshold`). Nothing
 * where the window is not known: the vendor keeps its own default. */
export async function compactThresholdEnvironment(
  harness: Pick<AiLocalHarnessDefinition, 'command' | 'compactThreshold'>, state: Pick<HarnessState, 'globalSettings' | 'sessions'>, model: string | null,
): Promise<Record<string, string>> {
  const setting = harness.compactThreshold;
  if (!setting) return {};
  const tokens = compactAt(state.globalSettings);
  if (!setting.settingsKey) return { [setting.env]: String(tokens) };
  const window = await targetContextWindow(state.sessions, harness.command, model, modelsDevFiles()).catch(() => undefined);
  if (!window) return {};
  const share = Math.round(Math.min(0.95, tokens / window) * 1000) / 1000;
  const settings: Record<string, unknown> = {};
  const keys = setting.settingsKey.split('.');
  let node = settings;
  for (const key of keys.slice(0, -1)) node = (node[key] = {}) as Record<string, unknown>;
  node[keys.at(-1)!] = share;
  const directory = join(stateDirectory(), 'cache');
  const file = join(directory, `${harness.command}-compact-defaults.json`);
  const text = `${JSON.stringify(settings)}\n`;
  if (await readFile(file, 'utf8').catch(() => undefined) !== text) {
    await mkdir(directory, { recursive: true });
    await writeFile(file, text);
  }
  return { [setting.env]: file };
}
