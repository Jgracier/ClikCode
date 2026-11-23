/** Running ClikCode's compaction (turn/compaction.ts) on a conversation: which mechanism its
 * harness has, and what the conversation keeps of it. */
import { declaredHarnessCommands } from '../harness/declared-commands.js';
import type { AiLocalHarnessDefinition } from '../harness/definition.js';
import type { HarnessSession, HarnessState } from '../session/model.js';
import { forgetNativeThread } from '../session/native-thread.js';
import { readState } from '../session/state/read.js';
import { writeState } from '../session/state/write.js';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { quiet } from '../runtime/lifecycle-log.js';
import { stateDirectory } from '../session/store/paths.js';
import { fullRecordNote, writeFullRecord } from '../session/full-record.js';
import { wrapResourceNote } from './resource-note-text.js';
import { modelsDevFiles } from '../harness/accounts/goose-discovery.js';
import { compactAt, compactionMechanism, vendorThresholdPlan, type CompactionMechanism } from './compaction.js';
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
    session.compaction = { at: new Date().toISOString(), through: session.messages?.length ?? 0, noteRecord: true };
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

/** What a launch carries so the vendor compacts at ClikCode's threshold itself (compaction.ts
 * vendorThresholdPlan). `set` is false where nothing reaches the vendor (no threshold of its own,
 * or a share of a window not known yet): ClikCode then compacts after the turn. */
export interface CompactThresholdLaunch {
  environment: Record<string, string>;
  /** Keys of the thread's config (Codex app-server). */
  config: Record<string, unknown>;
  set: boolean;
}

const NOTHING: CompactThresholdLaunch = { environment: {}, config: {}, set: false };

/** Deep merge of `extra` into `base` (a copy): the user's own inline settings keep everything ClikCode does not set. */
function mergeSettings(base: Record<string, unknown>, extra: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    const before = merged[key];
    merged[key] = value && typeof value === 'object' && before && typeof before === 'object' && !Array.isArray(before)
      ? mergeSettings(before as Record<string, unknown>, value as Record<string, unknown>) : value;
  }
  return merged;
}

function parsedObject(text: string | undefined): Record<string, unknown> {
  if (!text) return {};
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { return {}; } // fail-open-ok: settings ClikCode cannot read are replaced by its own
}

/** This launch's threshold for `harness` on `model`. A settings file is named by what it holds, so
 * a changed threshold is a changed launch: a long-lived vendor process is keyed by its
 * environment (vendor-process.ts vendorChildKey, codex-app-server ensureLive) and restarts for it. */
export async function compactThresholdLaunch(
  harness: Pick<AiLocalHarnessDefinition, 'command' | 'compactThreshold'>, state: Pick<HarnessState, 'globalSettings' | 'sessions'>, model: string | null,
  inherited: Readonly<Record<string, string | undefined>> = process.env,
): Promise<CompactThresholdLaunch> {
  const setting = harness.compactThreshold;
  if (!setting) return NOTHING;
  const unit = setting.unit ?? 'tokens';
  const window = unit === 'share' || unit === 'percent'
    ? await targetContextWindow(state.sessions, harness.command, model, modelsDevFiles()).catch(quiet('turn/compaction-run'))
    : undefined;
  const plan = vendorThresholdPlan(setting, compactAt(state.globalSettings), window);
  if (!plan) return NOTHING;
  if (plan.kind === 'config') return { environment: {}, config: plan.config, set: true };
  if (plan.kind === 'env') return { environment: plan.env, config: {}, set: true };
  if (plan.via === 'inline') {
    const text = JSON.stringify(mergeSettings(parsedObject(inherited[plan.env]), plan.settings));
    return { environment: { [plan.env]: text }, config: {}, set: true };
  }
  const text = `${JSON.stringify(plan.settings)}\n`;
  const directory = join(stateDirectory(), 'cache');
  const file = join(directory, `${harness.command}-compact-${createHash('sha256').update(text).digest('hex').slice(0, 12)}.json`);
  if (await readFile(file, 'utf8').catch(() => undefined /* fail-open-ok: a missing file is written below */) !== text) {
    await mkdir(directory, { recursive: true });
    await writeFile(file, text);
  }
  return { environment: { [plan.env]: file }, config: {}, set: true };
}

/** The first request after a native compaction names the file that keeps the whole conversation
 * (session/full-record.ts): the vendor now works from its own summary, and what the summary left
 * out is still within reach. */
export async function withCompactionNote(session: HarnessSession, turnText: string): Promise<string> {
  if (!session.compaction?.noteRecord) return turnText;
  delete session.compaction.noteRecord;
  const path = await writeFullRecord({ ...session, pendingTurn: undefined }, stateDirectory());
  return path ? `${wrapResourceNote(fullRecordNote(path))}\n\n${turnText}` : turnText;
}
