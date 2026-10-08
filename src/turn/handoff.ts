/** What a conversation carries to another provider, and vendor transcript
 * reconciliation. */
import type { AiHarnessPermissionMode, AiLocalHarnessDefinition } from '../harness/definition.js';
import type { HarnessDefaultSettings, HarnessSession, HarnessState, TranscriptMessage } from '../session/model.js';
import { sessionTranscriptMessages } from './checkpoint.js';
import { boundTurnActivities, readTurnActivities } from './turn-activities.js';
import { ADOPTED_TRANSCRIPT_READERS } from '../session/discovery/registry.js';
import { mergeNativeTranscript } from '../session/discovery/transcript.js';
import { nativeProfileEnvironment } from '../harness/transport/profile-environment.js';
import { allLocalHarnesses, harnessSupportsEffort, harnessSupportsPermissionMode, localHarnessForCommand } from '../runtime/lazy-bridge.js';

/** The settings a conversation keeps when another harness takes it up. The
 * user chose an effort and a permission mode for this conversation, not for
 * a provider: they carry over wherever the target takes them, and fall back
 * to the target's defaults only where it does not. A permission mode carries
 * by meaning (carriedPermissionMode), never to one that allows more. `efforts` is the levels
 * the target offers (effortChoicesFor), when known; unknown, the vendor's own
 * refusal decides (vendor-turn.ts isEffortRefusal). */
export function carriedHandoffSettings(
  source: Pick<HarnessSession, 'effort' | 'permissionMode'> & Partial<Pick<HarnessSession, 'nativeHarness'>>,
  target: AiLocalHarnessDefinition, defaults: HarnessDefaultSettings, efforts?: readonly string[],
): HarnessDefaultSettings {
  const effort = source.effort && harnessSupportsEffort(target) && (!efforts?.length || efforts.includes(source.effort))
    ? source.effort : defaults.effort;
  const from = source.nativeHarness ? localHarnessForCommand(source.nativeHarness) : undefined;
  const permissionMode = source.permissionMode
    ? carriedPermissionMode(from, source.permissionMode, target, defaults.permissionMode)
    : defaults.permissionMode;
  return { ...defaults, effort, permissionMode };
}

/** How much a mode lets the agent do without asking, by its normalized name. */
const PERMISSION_NAME_LEVEL: Record<AiHarnessPermissionMode, number> = { ask: 0, auto: 1, bypass: 2 };

/** What a harness actually passes for a mode (argv and environment);
 * undefined for the unflagged default, which means nothing across vendors. */
function permissionSignature(harness: AiLocalHarnessDefinition, mode: AiHarnessPermissionMode): string | undefined {
  const argv = harness.permissionArgv?.[mode]?.argv ?? [];
  const env = harness.permissionEnv?.[mode] ?? {};
  if (!argv.length && !Object.keys(env).length) return undefined;
  return JSON.stringify({ argv, env: Object.entries(env).sort(([left], [right]) => left.localeCompare(right)) });
}

/** A mode's level by what it does, not what it is called: the highest
 * normalized name any catalog harness gives the same flags. OpenCode calls
 * `--auto` bypass and Kilo (the same program) calls it auto, so Kilo's auto
 * is bypass-level. */
export function permissionLevel(
  harness: AiLocalHarnessDefinition, mode: AiHarnessPermissionMode,
  catalog: readonly AiLocalHarnessDefinition[] = allLocalHarnesses(),
): number {
  let level = PERMISSION_NAME_LEVEL[mode];
  const signature = permissionSignature(harness, mode);
  if (!signature) return level;
  for (const other of catalog) {
    for (const otherMode of other.permissionModes ?? []) {
      if (permissionSignature(other, otherMode) === signature) level = Math.max(level, PERMISSION_NAME_LEVEL[otherMode]);
    }
  }
  return level;
}

/** The target's mode closest in meaning to `mode` on `from` that never lets
 * the agent do more: the one passing the same flags if any, else the most
 * permissive one at or below the source's level (same name on a tie). With
 * none at or below it, `fallback` if that does not exceed it, else the
 * target's least permissive mode. `from` unknown: the mode's name decides. */
export function carriedPermissionMode(
  from: AiLocalHarnessDefinition | undefined, mode: AiHarnessPermissionMode, target: AiLocalHarnessDefinition,
  fallback: AiHarnessPermissionMode,
  catalog: readonly AiLocalHarnessDefinition[] = allLocalHarnesses(),
): AiHarnessPermissionMode {
  const sourceLevel = from ? permissionLevel(from, mode, catalog) : PERMISSION_NAME_LEVEL[mode];
  const sourceSignature = from ? permissionSignature(from, mode) : undefined;
  const offered = (target.permissionModes ?? []).filter((candidate) => harnessSupportsPermissionMode(target, candidate))
    .map((candidate) => ({ mode: candidate, level: permissionLevel(target, candidate, catalog) }));
  const same = sourceSignature ? offered.find((candidate) => permissionSignature(target, candidate.mode) === sourceSignature) : undefined;
  if (same) return same.mode;
  const allowed = offered.filter((candidate) => candidate.level <= sourceLevel)
    .sort((left, right) => right.level - left.level || Number(right.mode === mode) - Number(left.mode === mode));
  if (allowed[0]) return allowed[0].mode;
  if (!offered.length) return fallback;
  const fallbackLevel = offered.find((candidate) => candidate.mode === fallback)?.level;
  if (fallbackLevel !== undefined && fallbackLevel <= sourceLevel) return fallback;
  return [...offered].sort((left, right) => left.level - right.level)[0]!.mode;
}

/** The model a conversation runs on another harness: the one it ran here,
 * when the target offers it too (the same model through another vendor's
 * CLI); otherwise `fallback` -- the target's last-used or default model. */
export function carriedHandoffModel(
  source: Pick<HarnessSession, 'model' | 'reported'>, targetModels: readonly string[], fallback: string | null,
): string | null {
  for (const model of [source.model, source.reported?.model]) {
    if (model && targetModels.includes(model)) return model;
  }
  return fallback;
}

/** Pull turns added directly in a vendor CLI back into an already-linked
 * ClikCode conversation. The native CLI remains the only writer of its own
 * files; this only reconciles ClikCode's cached view after an exact-id resume. */
export async function synchronizeNativeTranscript(state: HarnessState, session: HarnessSession): Promise<boolean> {
  if (!session.nativeHarness || !session.nativeSessionId) return false;
  const harness = localHarnessForCommand(session.nativeHarness);
  const reader = harness ? ADOPTED_TRANSCRIPT_READERS[harness.command] : undefined;
  if (!harness || !reader) return false;
  const account = session.accountId ? state.accounts.find((item) => item.id === session.accountId) : undefined;
  const source = await reader(
    harness, session.nativeSessionId, session.workspace ?? process.cwd(), nativeProfileEnvironment(account?.nativeProfile),
  ).catch(() => []);
  const previousLength = (session.messages ?? []).length;
  const merged = mergeNativeTranscript(session.messages ?? [], source);
  if (merged.length === (session.messages ?? []).length) return false;
  session.messages = merged;
  // If the vendor transcript now contains the prompt that was journaled by a
  // previously interrupted ClikCode process, the vendor copy is authoritative
  // and the separate checkpoint must not render or hand off a duplicate.
  if (session.pendingTurn) {
    const appended = merged.slice(previousLength);
    const promptIndex = appended.findIndex((message) =>
      message.role === 'user' && message.content.trim() === session.pendingTurn!.prompt.trim());
    if (promptIndex >= 0) {
      const answerIndex = appended.findIndex((message, index) => index > promptIndex && message.role === 'assistant');
      if (answerIndex >= 0) {
        // Native transcript readers import prose, not streamed tool frames.
        // Keep the checkpoint's child work on the imported answer before
        // retiring that checkpoint, including when the vendor quit on quota.
        const answer = session.messages[previousLength + answerIndex] as TranscriptMessage;
        const activities = readTurnActivities(session.pendingTurn.activities, session.pendingTurn.response?.length ?? 0);
        if (activities.length) answer.activities = boundTurnActivities([
          ...readTurnActivities(answer.activities, answer.content.length),
          ...activities.map((activity) => ({ ...activity, responseOffset: Math.min(activity.responseOffset, answer.content.length) })),
        ]);
      } else {
        const checkpointAnswer = sessionTranscriptMessages({ ...session, messages: [] })
          .find((message) => message.role === 'assistant');
        if (checkpointAnswer) session.messages.push(checkpointAnswer);
      }
      delete session.pendingTurn;
    }
  }
  session.updatedAt = new Date().toISOString();
  return true;
}
