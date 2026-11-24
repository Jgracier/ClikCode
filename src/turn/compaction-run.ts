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
import { fullRecordNote, recordReachFor, writeFullRecord } from '../session/full-record.js';
import { wrapResourceNote } from './resource-note-text.js';
import { topicContents } from '../search/topic-contents.js';
import { modelsDevFiles } from '../harness/accounts/goose-discovery.js';
import { compactAt, compactionMechanism, effectiveThreshold, nextCompactionRecord, vendorThresholdPlan, vendorTrigger, type CompactionMechanism, type CompactionRecord } from './compaction.js';
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
    session.compaction = nextCompactionRecord(session.compaction, session.messages?.length ?? 0, { noteRecord: true });
  });
}

/** A harness with no native compaction: its thread is let go, and the next turn takes the
 * conversation up afresh, fitted to half the threshold (vendor-thread-takeup.ts). Nothing of
 * ClikCode's record is removed. */
export async function compactByRewrite(id: string): Promise<void> {
  await leavePersistentTransport(id);
  await updateSession(id, (session) => {
    forgetNativeThread(session);
    session.compaction = nextCompactionRecord(session.compaction, session.messages?.length ?? 0, { rewrite: true });
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
  /** The threshold (tokens) the vendor was set to, when `set`. */
  threshold?: number;
}

const NOTHING: CompactThresholdLaunch = { environment: {}, config: {}, set: false };

/** This launch's threshold for `harness` on `model`, past the floor of `session`'s last compaction
 * (compaction.ts effectiveThreshold). A settings file is named by what it holds, so
 * a changed threshold is a changed launch: a long-lived vendor process is keyed by its
 * environment (vendor-process.ts vendorChildKey, codex-app-server ensureLive) and restarts for it. */
export async function compactThresholdLaunch(
  harness: Pick<AiLocalHarnessDefinition, 'command' | 'compactThreshold'>, state: Pick<HarnessState, 'globalSettings' | 'sessions'>, model: string | null,
  session?: { compaction?: CompactionRecord },
): Promise<CompactThresholdLaunch> {
  const setting = harness.compactThreshold;
  if (!setting) return NOTHING;
  const unit = setting.unit ?? 'tokens';
  const window = unit === 'share' || unit === 'percent'
    ? await targetContextWindow(state.sessions, harness.command, model, modelsDevFiles()).catch(quiet('turn/compaction-run'))
    : undefined;
  const threshold = effectiveThreshold(compactAt(state.globalSettings), session?.compaction);
  const plan = vendorThresholdPlan(setting, threshold, window, session?.compaction);
  if (!plan) return NOTHING;
  const set = { set: true, threshold: vendorTrigger(setting, threshold, session?.compaction) };
  if (plan.kind === 'config') return { environment: {}, config: plan.config, ...set };
  if (plan.kind === 'env') return { environment: plan.env, config: {}, ...set };
  const text = `${JSON.stringify(plan.settings)}\n`;
  const directory = join(stateDirectory(), 'cache');
  const file = join(directory, `${harness.command}-compact-${createHash('sha256').update(text).digest('hex').slice(0, 12)}.json`);
  if (await readFile(file, 'utf8').catch(() => undefined /* fail-open-ok: a missing file is written below */) !== text) {
    await mkdir(directory, { recursive: true });
    await writeFile(file, text);
  }
  return { environment: { [plan.env]: file }, config: {}, ...set };
}

/** The first request after a native compaction names where the whole conversation is
 * (session/full-record.ts): the hindsight tool when the harness has ClikCode's MCP server
 * (`hasHindsight`), else the record file; and its topics by message number
 * (search/topic-contents.ts). The vendor now works from its own summary, and what the summary
 * left out is still within reach. The file is written either way. */
export async function withCompactionNote(session: HarnessSession, turnText: string, hasHindsight: boolean): Promise<string> {
  if (!session.compaction?.noteRecord) return turnText;
  delete session.compaction.noteRecord;
  const reach = recordReachFor(hasHindsight, await writeFullRecord({ ...session, pendingTurn: undefined }, stateDirectory()));
  const contents = await topicContents(session, hasHindsight);
  const note = [reach ? fullRecordNote(reach) : '', contents ?? ''].filter(Boolean).join('\n\n');
  return note ? `${wrapResourceNote(note)}\n\n${turnText}` : turnText;
}
