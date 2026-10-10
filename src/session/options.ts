/**
 * How a session and its harness are described and configured.
 *
 * Pure functions: what a conversation's identity is, what options a harness
 * accepts and how one is applied, and how a conversation
 * becomes a row in a picker. No I/O, no prompter, no turn.
 *
 * It is split out because two callers need exactly this and nothing else --
 * the turn loop and the interactive pickers -- and while it sat inside the
 * turn loop's file the pickers could not be lifted out without the two
 * importing each other. The pickers' rows as data are session/picker-rows.ts.
 */
import { conversationPreview, sessionFromIndex, transcriptWasLoaded } from './list-facts.js';
import { listedSummary, summaryHeadline } from './conversation-summary.js';
import { isConversationChat } from './conversation-rows.js';

export { conversationPreview };
import { isClikCodeAgent } from './route.js';
import chalk from 'chalk';
import { commonControlFor, optionIdsForControl } from '../harness/options.js';
import { harnessTierRank } from '../runtime/lazy-bridge.js';
import { sessionProviderLabel } from '../harness/protocol/labels.js';
import { relativeTime } from '../harness/protocol/format.js';
import { harnessIntegrationLevel, harnessSupportsEffort, harnessSupportsPermissionMode, localHarnessCapabilityManifest } from '../runtime/lazy-bridge.js';
import type { AiHarnessOptionDefinition, AiHarnessPermissionMode, AiLocalHarnessDefinition } from '../harness/definition.js';
import type { PickerOption } from '../harness/prompter.js';
import type { HarnessDefaultSettings, HarnessSession } from './model.js';
import { forgetNativeThread } from './native-thread.js';
import type { ConversationRow } from './conversation-rows.js';
import { conversationState, turnFacts } from './conversation-state.js';
import { parseSendMode } from '../turn/send-mode.js';

/** Effort words every harness understands, narrowed per harness by
 * harnessSupportsEffort. */
export const VALID_EFFORTS = ['off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
export const VALID_PERMISSION_MODES: readonly AiHarnessPermissionMode[] = ['ask', 'bypass', 'auto'];

/** The approval modes a conversation can be set to. On the Gateway and
 * ClikCode Local routes the agent is ClikCode's own, running on this machine,
 * and it implements all three -- the inference supplies the model, never the decision about what may
 * touch the user's files. A local harness offers the ones it carries to a real
 * flag. */
export function sessionPermissionModes(
  session: Pick<HarnessSession, 'route'>, harness: AiLocalHarnessDefinition | undefined,
): readonly AiHarnessPermissionMode[] {
  if (isClikCodeAgent(session)) return VALID_PERMISSION_MODES;
  return harness ? VALID_PERMISSION_MODES.filter((mode) => harnessSupportsPermissionMode(harness, mode)) : [];
}

export function hasConversationContent(session: HarnessSession): boolean {
  return Boolean(session.nativeSessionId || session.pendingTurn || (session.messages ?? []).length > 0);
}

/** Nothing has happened in this conversation: see session/blank.ts, which is
 * where the rule is explained. Defined here, beside hasConversationContent,
 * because the chat list below needs it and blank.ts needs state I/O. */
export function isBlankConversation(session: HarnessSession): boolean {
  // The transcript was not opened. A row in the index is a real chat (its
  // summary may still be on the way). A draft that was never stored is not.
  if (!transcriptWasLoaded(session) && session.messages === undefined && session.pendingTurn === undefined) {
    if (session.listChecked) {
      return !(session.listMessageCount || session.listPreview || session.nativeSessionId
        || session.queuedTurns?.length || session.attachments?.length || session.shellNotes?.length || session.nameSource === 'user');
    }
    if (sessionFromIndex(session)) return false;
  }
  return !hasConversationContent(session)
    && !(session.queuedTurns?.length)
    && !(session.attachments?.length)
    && !(session.shellNotes?.length)
    && session.nameSource !== 'user';
}

/** The one conversation a typed name picks out: an exact name (ignoring
 * case), or else the only name containing it. Two candidates is a real choice
 * and gets the list, never a guess. Blank chats and the current one are not
 * candidates -- there is nothing to go back to in either. */
export function chatNamed(sessions: readonly HarnessSession[], typed: string, currentId: string): string | undefined {
  const query = typed.trim().toLowerCase();
  if (!query) return undefined;
  const chats = sessions.filter((session) => session.id !== currentId && isConversationChat(session) && !isBlankConversation(session));
  const latest = (list: readonly HarnessSession[]): string => [...list].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]!.id;
  // `last`: the most recent chat, whatever it is called.
  if (query === 'last' && chats.length) return latest(chats);
  // An id, or the start of one (what /fork and `sessions list` print), finds
  // an unnamed chat too.
  const byId = query.length >= 4 ? chats.filter((session) => session.id.toLowerCase().startsWith(query)) : [];
  if (byId.length === 1) return byId[0]!.id;
  const named = chats.filter((session) => session.name);
  const exact = named.filter((session) => session.name!.toLowerCase() === query);
  if (exact.length) return latest(exact);
  const partial = named.filter((session) => session.name!.toLowerCase().includes(query));
  return partial.length === 1 ? partial[0]!.id : undefined;
}

/** The chat `clikcode --continue` reopens: the latest in this folder, else
 * the latest anywhere. */
export function latestChat(sessions: readonly HarnessSession[], workspace: string): HarnessSession | undefined {
  const chats = sessions.filter((session) => isConversationChat(session) && !isBlankConversation(session)).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return chats.find((session) => session.workspace === workspace) ?? chats[0];
}

/** A conversation row as a picker option, in three parts: its title, the one
 * state it is in (conversation-state.ts), and the last thing asked; its forks
 * under Branches. Who answered and on which model are not on the row: they
 * are the conversation's settings, shown once it is open. */
export function conversationOption(
  row: ConversationRow,
  providerLabel: ((session: HarnessSession) => string) | undefined = sessionProviderLabel,
  now = Date.now(),
): PickerOption<string> {
  const labelFor = providerLabel ?? sessionProviderLabel;
  const timestamp = (session: HarnessSession): number => {
    const value = Date.parse(session.updatedAt);
    return Number.isNaN(value) ? -Infinity : value;
  };
  const createdTimestamp = (session: HarnessSession): number => {
    const value = Date.parse(session.createdAt);
    return Number.isNaN(value) ? timestamp(session) : value;
  };
  const history = [...row.chats].sort((left, right) => createdTimestamp(left) - createdTimestamp(right));
  const byId = new Map(history.map((session) => [session.id, session]));
  const depthFor = (session: HarnessSession): number => {
    let depth = 0;
    let parentId = session.parentSessionId;
    const seen = new Set<string>();
    while (parentId && byId.has(parentId) && !seen.has(parentId)) {
      seen.add(parentId);
      depth += 1;
      parentId = byId.get(parentId)?.parentSessionId;
    }
    return depth;
  };
  const latest = row.latest;
  const title = latest.name?.replace(/\s+\(from [^)]+\)$/i, '').trim() || 'Untitled chat';
  const preview = conversationPreview(latest);
  const summarized = listedSummary(latest);
  // conversationRows already determined activity via sessionActivity - only pass
  // turn facts when the row is actually working (has a live worker behind it).
  const state = conversationState({
    updatedAt: latest.updatedAt,
    ...(row.activity === 'working' && row.pending ? { turn: turnFacts(row.pending) } : {}),
    ...(row.needsYou ? { needsYou: true } : {}),
    ...(latest.resumeAt ? { resumeAt: latest.resumeAt.at } : {}),
  }, now);
  const activity = state.kind === 'working' || state.kind === 'stalled' || state.kind === 'needs-you' ? state.kind : undefined;
  return {
    label: title,
    detail: [`· ${state.kind === 'stalled' ? chalk.yellow(state.text) : state.text}`, preview, summarized && summaryHeadline(summarized)].filter(Boolean).join(' · '),
    ...(activity ? { activity } : {}),
    value: latest.id,
    alternates: history.length > 1 ? history.map((session) => ({
      label: `${'  '.repeat(depthFor(session))}${labelFor(session)} · ${session.fork ? 'fork' : 'original'}${session.id === latest.id ? ' · latest' : ''} · ${relativeTime(session.updatedAt, now)}`,
      value: session.id,
    })) : undefined,
  };
}

/** An option by id, falling back to the other spellings of whatever control
 * owns that id. `--add-dir` and `--include-directories` are one concept, so
 * asking any harness for `add-dir` must find the one it actually publishes --
 * looking up the literal id is what made /add-dir refuse on Gemini and Qwen. */
export function optionForHarness(harness: AiLocalHarnessDefinition, id: string): AiHarnessOptionDefinition | undefined {
  const options = localHarnessCapabilityManifest(harness).options;
  const exact = options.find((option) => option.id === id);
  if (exact) return exact;
  const control = commonControlFor(id);
  if (!control) return undefined;
  const ids = optionIdsForControl(control);
  return options.find((option) => ids.includes(option.id));
}

/** The option a ClikCode command drives on THIS harness, whatever the vendor
 * spells it. */
export function optionForControl(
  harness: AiLocalHarnessDefinition, control: string,
): AiHarnessOptionDefinition | undefined {
  const ids = optionIdsForControl(control);
  return localHarnessCapabilityManifest(harness).options.find((option) => ids.includes(option.id));
}

export function parseHarnessOption(option: AiHarnessOptionDefinition, raw: string): unknown {
  const value = raw.trim();
  if (option.kind === 'boolean') {
    if (['true', 'on', 'yes', '1', 'enabled'].includes(value.toLowerCase())) return true;
    if (['false', 'off', 'no', '0', 'disabled'].includes(value.toLowerCase())) return false;
    throw new Error(`${option.label} must be on or off`);
  }
  if (option.kind === 'number') {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${option.label} must be a non-negative number`);
    return parsed;
  }
  if (option.kind === 'string-list' || option.kind === 'path-list') {
    const values = value.split(',').map((item) => item.trim()).filter(Boolean);
    if (!values.length) throw new Error(`${option.label} requires at least one value`);
    return values;
  }
  if (option.values?.length && !option.values.includes(value)) throw new Error(`${option.label} must be one of ${option.values.join(', ')}`);
  if (!value) throw new Error(`${option.label} cannot be empty`);
  return value;
}

export function setSessionHarnessOption(
  session: HarnessSession, harness: AiLocalHarnessDefinition, id: string, raw: string,
  /** The values the installed harness itself accepts, where it says -- see
   * harness/accounts/effort-choices.ts. They replace the catalog's list, which
   * is the fallback for harnesses that publish none, not the authority. */
  choices?: readonly string[],
): void {
  const declared = optionForHarness(harness, id);
  if (!declared) throw new Error(`${harness.displayName} does not support option "${id}"`);
  const option = choices?.length && declared.kind === 'enum' ? { ...declared, values: [...choices] } : declared;
  const parsed = parseHarnessOption(option, raw);
  // Keyed by the option the harness actually publishes, never by the id the
  // caller asked for: a value stored under `add-dir` on a harness that spells
  // it `include-directories` is a value no turn ever reads.
  if (option.id === 'model') session.model = String(parsed);
  else if (option.id === 'effort') session.effort = String(parsed);
  else if (option.id === 'workspace') session.workspace = String(parsed);
  else if (option.id === 'permissions') session.permissionMode = String(parsed) as AiHarnessPermissionMode;
  else session.harnessOptions = { ...(session.harnessOptions ?? {}), [option.id]: parsed };
  if (option.requiresNewSession) {
    forgetNativeThread(session);
  }
}

/** 'auto' and 'default' mean "no explicit override" rather than being stored
 * as literal model ids -- no vendor CLI has a model named either word. Every
 * entry point that can set a model (slash commands, `/settings`, and the
 * `sessions create`/`sessions set` CLI flags) routes through this so they
 * can't drift out of sync on which words clear it.
 *
 * Returning null is a request to RESOLVE, not an instruction to store null.
 * Callers must follow it with resolveNativeModel(); a session persisted with
 * a null model is what used to surface in the UI as "automatic", and then as
 * "default" after that word was merely renamed. A session must always name a
 * model its harness really publishes. */
export function normalizeModelWord(value: string): string | null {
  return value === 'auto' || value === 'default' ? null : value;
}

/** Both `/settings global <key> <value>` and `/settings provider <id> <key> <value>`
 * write into the same three fields; this is the one place that validates a value
 * for a given key so the two entry points can't drift out of sync.
 *
 * `harness`, when given (the provider-scoped path only — a global default has
 * no single harness to check against), gates effort and permission mode on
 * what the catalog actually declares that vendor CLI supports. Without this,
 * a provider override could be accepted and then silently do nothing: the
 * turn-argv builder already only applies effort when `effortArgvPrefix` is
 * declared, and only applies permission mode when the harness's declared
 * `permissionModes` includes it. */
export function applyDefaultSetting(target: Partial<HarnessDefaultSettings & { model: string }>, key: string, value: string, harness?: AiLocalHarnessDefinition): void {
  const normalizedKey = key.toLowerCase();
  if (normalizedKey === 'effort') {
    if (harness && !harnessSupportsEffort(harness)) throw new Error(`${harness.displayName} does not publish a configurable reasoning-effort flag; setting one here would silently do nothing.`);
    // A harness's own levels (Hermes's `ultra`, Codex's per-model ones) are
    // its to say; the generic list checks only a default for every harness.
    if (!harness && !VALID_EFFORTS.includes(value as (typeof VALID_EFFORTS)[number])) throw new Error(`effort must be one of ${VALID_EFFORTS.join(', ')}`);
    target.effort = value;
  } else if (normalizedKey === 'permissions' || normalizedKey === 'permissionmode') {
    if (!VALID_PERMISSION_MODES.includes(value as AiHarnessPermissionMode)) throw new Error('permissions must be ask, bypass, or auto');
    if (harness && !harnessSupportsPermissionMode(harness, value as AiHarnessPermissionMode)) throw new Error(`${harness.displayName} does not map ClikCode's permission modes to a real flag; setting one here would silently do nothing.`);
    target.permissionMode = value as AiHarnessPermissionMode;
  } else if (normalizedKey === 'send' && !('model' in target) && !harness) {
    // Global only: how a message typed mid-turn is delivered is the user's
    // habit, not a provider's.
    target.sendMode = parseSendMode(value);
  } else if (normalizedKey === 'model' && 'model' in target) {
    target.model = normalizeModelWord(value) ?? undefined;
  } else {
    throw new Error(`unknown setting "${key}"; choose ${'model' in target ? 'model, effort, or permissions' : 'effort, permissions, or send'}`);
  }
}

export function integrationLabel(harness: AiLocalHarnessDefinition): string {
  return ({
    native: 'full integration',
    structured: 'structured integration',
    compatibility: 'basic compatibility',
  } as const)[harnessIntegrationLevel(harness)];
}

/** The providers listed first, in this order, after the ClikDeploy Gateway
 * and ClikCode Local. The user's own ranking; every other harness follows,
 * installed ones first, then by catalog tier. */
export const PROVIDER_ORDER: readonly string[] = ['claude', 'codex', 'grok', 'cursor', 'cline', 'kiro', 'copilot', 'antigravity', 'opencode', 'hermes', 'openclaw'];

/** One order for every list of providers -- /provider, VS Code's list, the
 * add-account list, the slash menu's harnesses -- so they cannot disagree. */
export function compareProviders(
  left: { harness: AiLocalHarnessDefinition; installed?: boolean },
  right: { harness: AiLocalHarnessDefinition; installed?: boolean },
): number {
  const rank = (harness: AiLocalHarnessDefinition): number => {
    const at = PROVIDER_ORDER.indexOf(harness.command);
    return at < 0 ? PROVIDER_ORDER.length : at;
  };
  return rank(left.harness) - rank(right.harness)
    || Number(Boolean(right.installed)) - Number(Boolean(left.installed))
    || harnessTierRank(left.harness) - harnessTierRank(right.harness);
}
