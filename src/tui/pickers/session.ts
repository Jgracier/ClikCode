/** Choosing a session to resume, including sessions a vendor CLI started
 * outside ClikCode and that can be adopted. */

import { compactPath } from '../../harness/protocol/labels.js';
import { SLOW_WAIT_MS } from '../../harness/protocol/timings.js';
import { newConversation } from '../../commands/ai/conversations.js';
import { randomUUID } from 'node:crypto';
import { inspectNativeHarness } from '../../harness/transport/native/inspect.js';
import { discoverNativeSessions, lastSeenNativeSessions } from '../../session/discovery/cli-listing.js';
import { ADOPTED_TRANSCRIPT_READERS, FS_SESSION_DISCOVERY } from '../../session/discovery/registry.js';
import { saveDiscoveryCache } from '../../session/discovery/cache.js';
import { acpDiscoveryDirectory } from '../../harness/accounts/acp-query.js';
import { type DiscoveredNativeSession } from '../../session/discovery/discovered-session.js';
import type { AiHarnessAccount, AiLocalHarnessDefinition } from '../../harness/definition.js';
import type { HarnessPrompter, PickerOption } from '../../harness/prompter.js';
import type { HarnessSession, HarnessState } from '../../session/model.js';
import { nativeProfileEnvironment } from '../../harness/transport/profile-environment.js';
import { localHarnessForCommand } from '../../runtime/lazy-bridge.js';
import { backfillListFacts } from '../../session/list-backfill.js';

import { readState } from '../../session/state/read.js';
import { resolveDefaultSettings } from '../../session/state/settings.js';
import { writeState } from '../../session/state/write.js';
import { allLocalHarnesses } from '../../runtime/lazy-bridge.js';
import { sessionClaimIsLive } from '../../session/claim.js';
import { livePendingTurns, liveWorkerSessions } from '../../session/liveness.js';
import { watchConversationList } from '../../session/list-watch.js';
import { conversationRows, recencySection, sectionRank, SECTION_TITLES, type ConversationRow, type ConversationSection } from '../../session/conversation-rows.js';
import { activityGlyph, subagentOptions, workingDetail } from './conversation-activity.js';
import { turnPace } from '../../harness/protocol/turn-pace.js';
import { resumeWaitLabel } from '../../turn/usage-exhausted.js';
import { conversationIdFor, conversationOption, isBlankConversation } from '../../session/options.js';
import { aiSessionCommand } from '../slash/handlers.js';
import { chooseOption } from './choose.js';

type AdoptableNativeSession = {
  harness: AiLocalHarnessDefinition;
  item: DiscoveredNativeSession;
  accountId?: string;
};

/** Conversations that exist only inside a vendor's own history — never opened
 * through ClikCode — are otherwise invisible in /resume entirely, which only
 * ever looked at ClikCode's own tracked sessions. Two independent mechanisms
 * feed this, because vendors expose their own history in genuinely different
 * ways: a machine-readable CLI listing via discoverArgv (confirmed live:
 * opencode, Hermes; confirmed only against docs/source, not installed here:
 * Qwen Code, Crush; declared but with an unconfirmed JSON shape: Goose,
 * Kilo Code; a real command with no JSON mode at all, needing its own
 * numbered-list parser: Gemini CLI) — or, for harnesses that publish no
 * listing command whatsoever, reading their own on-disk session files
 * directly (confirmed live: Claude Code, Codex, Cursor Agent; docs-only,
 * unverified against a real install: Pi). GitHub Copilot CLI, Aider, Amp,
 * Factory Droid, Kiro CLI, Cline CLI, and Command Code are deliberately not
 * wired in at all: each either has no local listing mechanism (Aider, Amp's
 * canonical store is server-side), an undocumented on-disk format (Copilot
 * CLI, Factory Droid, Kiro CLI, Cline CLI), or an unresolved identity
 * mismatch between this catalog's entry and the only public docs found for
 * its name (Command Code) — none of these are guessed at.
 *
 * Every one of those spawns a real vendor CLI (up to a 4s timeout each, once
 * per account profile) or walks a vendor's on-disk store, so this is slower
 * than the rest of /resume by orders of magnitude and must never be awaited
 * before the picker is on screen. */
async function discoverAdoptableSessions(
  state: HarnessState, workspace: string,
  /** Called once, early, with the vendor files plus what each CLI listed LAST
   * time -- so the list shows them at once instead of after the slowest CLI
   * (kilo takes 1.5-1.8s here). The real listings then replace them. */
  early?: (found: AdoptableNativeSession[]) => void,
): Promise<AdoptableNativeSession[]> {
  const discoveryProfiles = (harness: AiLocalHarnessDefinition): Array<AiHarnessAccount | undefined> => {
    const accounts = state.accounts.filter((item) => item.provider === harness.provider && item.status === 'ready');
    if (!accounts.length) return [undefined];
    const unique = new Map<string, AiHarnessAccount>();
    for (const account of accounts) unique.set(account.nativeProfile?.path ?? 'default', account);
    return [...unique.values()];
  };
  const discoverable = allLocalHarnesses().filter((harness) => harness.session?.discoverArgv);
  // The session ClikCode reads a model list from is its own, not the user's.
  const discovery = acpDiscoveryDirectory();
  const notAdopted = (found: AdoptableNativeSession[]): AdoptableNativeSession[] => found
    .filter(({ item }) => item.workspace !== discovery)
    .filter(({ harness, item, accountId }) => !state.sessions.some((session) => session.nativeHarness === harness.command
      && session.nativeSessionId === item.nativeId && (!accountId || session.accountId === accountId)));
  const seen = (async () => (await Promise.all(discoverable.map(async (harness) => {
    const profiles = discoveryProfiles(harness);
    if (profiles[0] === undefined) return [];
    return (await Promise.all(profiles.map(async (account) => (await lastSeenNativeSessions(harness, workspace, account?.nativeProfile?.path))
      .map((item) => ({ harness, item, accountId: account?.id }))))).flat();
  }))).flat())().catch(() => [] as AdoptableNativeSession[]);
  const shell = (async () => (await Promise.all(discoverable.map(async (harness) => {
    // Only a vendor the user has signed in to through ClikCode. The listing
    // is a real run of the vendor's CLI, and a signed-out one does not just
    // fail: Kiro CLI's `chat --list-sessions` starts its own login, so every
    // /resume popped a Kiro sign-in for someone who never used Kiro. The
    // file-based discovery below only reads, so it keeps its default profile.
    const profiles = discoveryProfiles(harness);
    if (profiles[0] === undefined) return [];
    return (await Promise.all(profiles.map(async (account) => {
      const environment = nativeProfileEnvironment(account?.nativeProfile);
      const found = await discoverNativeSessions(harness, environment, workspace, account?.nativeProfile?.path);
      return found.map((item) => ({ harness, item, accountId: account?.id }));
    }))).flat();
  }))).flat())();
  const files = (async () => (await Promise.all(Object.entries(FS_SESSION_DISCOVERY).map(async ([command, discover]) => {
    const harness = localHarnessForCommand(command);
    if (!harness) return [];
    const inspection = await inspectNativeHarness(harness, 500);
    if (!inspection.installed) return [];
    return (await Promise.all(discoveryProfiles(harness).map(async (account) => {
      // Every folder, not just this one: a chat started in the vendor's own
      // CLI elsewhere was invisible unless ClikCode opened in that folder.
      // Its folder is on the row, and adopting it opens it there.
      const found = await discover('', nativeProfileEnvironment(account?.nativeProfile)).catch(() => []);
      return found.map((item) => ({ harness, item, accountId: account?.id }));
    }))).flat();
  }))).flat())();
  // The two halves are independent and were awaited one after the other, so
  // the filesystem walk waited on six subprocesses that had nothing to do
  // with it. They run together now, and the cache is flushed once when both
  // are done rather than relying on whichever vendor discoverer happened to
  // save it on the way past.
  if (early) void Promise.all([seen, files]).then(([seenShell, fsDiscovered]) => early(notAdopted([...seenShell, ...fsDiscovered])), () => undefined);
  const [shellDiscovered, fsDiscovered] = await Promise.all([shell, files]);
  await saveDiscoveryCache().catch(() => undefined);
  return notAdopted([...shellDiscovered, ...fsDiscovered]);
}

/** Indirection so tests can hold discovery open and observe the picker while
 * it is still pending. */
const NATIVE_SESSION_DISCOVERY = { run: discoverAdoptableSessions };

let nativeDiscoveryCache: { key: string; result: Promise<AdoptableNativeSession[]> } | undefined;

/** One discovery at a time for the same inputs -- a picker that reopens while
 * the last one is still running shares it rather than starting another.
 *
 * No longer held for a minute afterwards. File facts follow the directory's
 * mtime. A vendor CLI's own list is reused for two minutes (see
 * SEEN_LISTING_TTL_MS), then asked again. */
function cachedAdoptableSessions(
  state: HarnessState, workspace: string, early?: (found: AdoptableNativeSession[]) => void,
): Promise<AdoptableNativeSession[]> {
  const key = [workspace, ...state.accounts.map((item) => `${item.id}:${item.nativeProfile?.path ?? ''}`).sort()].join('\u0000');
  const cached = nativeDiscoveryCache;
  if (cached && cached.key === key) return cached.result;
  const result = NATIVE_SESSION_DISCOVERY.run(state, workspace, early).catch(() => {
    // fail-open-ok: discovery is passive enrichment of a list that is already
    // complete for ClikCode's own conversations. A vendor CLI that fails must
    // not take /resume down with it, and must not be cached as an answer.
    return [] as AdoptableNativeSession[];
  }).finally(() => {
    if (nativeDiscoveryCache?.result === result) nativeDiscoveryCache = undefined;
  });
  nativeDiscoveryCache = { key, result };
  return result;
}

function nativeValue(command: string, nativeId: string, accountId: string | undefined): string {
  return `native:${command}\u0000${nativeId}\u0000${accountId ?? ''}`;
}

/** Selected while discovery is still running: wait for it, then reopen. */
const PENDING_DISCOVERY_VALUE = '__discovering__';
const NEW_CONVERSATION_VALUE = '__new__';
const MANAGE_ACTIONS = [
  { label: 'Rename', value: 'rename' },
  { label: 'Fork', value: 'fork' },
  { label: 'Archive', value: 'archive' },
] as const;

/** One list for finding a conversation and managing it.
 *
 * One list opens, creates, and manages conversations. Row actions also expose
 * provider history, so finding a branch and managing a chat share one screen. */
export async function interactiveSessionPicker(rl: HarnessPrompter, currentId: string): Promise<{ id: string } | { new: true } | undefined>;
export async function interactiveSessionPicker(
  rl: HarnessPrompter, currentId: string, boardCommands: readonly PickerOption<string>[] | undefined,
  hooks?: { onSessionsSettled?: () => boolean },
): Promise<{ id: string } | { new: true } | { compose: string } | { command: string } | undefined>;
export async function interactiveSessionPicker(
  rl: HarnessPrompter, currentId: string,
  /** The commands a board's `/` offers. Given, and the terminal can draw it,
   * the list is the full-page board (tui/conversation-board.ts) instead. */
  boardCommands?: readonly PickerOption<string>[],
  /** The board calls `onSessionsSettled` when running chats finish and the
   * list is idle. A true return leaves the board up until the process exits. */
  hooks?: { onSessionsSettled?: () => boolean },
): Promise<{ id: string } | { new: true } | { compose: string } | { command: string } | undefined> {
  const onBoard = Boolean(boardCommands && rl.board);
  // Titles, previews and dates live on the index. The transcript is read
  // when the chat is opened, not to draw this list.
  const state = await readState({ transcripts: [] });
  const current = state.sessions.find((item) => item.id === currentId);
  // A session with no turns yet has nothing to resume into — showing it here is
  // indistinguishable from a real conversation until you're already inside it,
  // and older empty sessions (from before aiSessionClose started dropping them)
  // otherwise bury every real, titled conversation under identical
  // "Untitled chat" entries. Always keep the current session visible even if
  // it's still empty, so picking "current" back out of the list still works.
  // A set nativeSessionId counts as real content too, even with zero
  // ClikCode-tracked messages: a session adopted from a vendor's own history,
  // or linked to one directly, has a real vendor-side conversation behind it
  // that ClikCode simply never routed a turn through yet.
  // A conversation another terminal is driving right now used to be dropped
  // from this list outright, on the theory that both terminals would then
  // render and steer the same chat. In practice a claim's heartbeat only
  // proves its process is still running, not that anyone is still watching
  // it -- ai.ts ignores SIGHUP for the whole session lifetime so a flaky SSH
  // connection survives it, which means a dropped connection (closing the
  // laptop, a network blip, never sending /exit) leaves an orphaned process
  // heartbeating forever. That silently hid the conversation from every
  // future /resume, indistinguishable from data loss. It is listed and
  // annotated instead below; selecting it takes it over the same way opening
  // any session already does (claimSession is unconditional).
  const sessions = state.sessions
    // On the board the composer is how a chat starts, so the empty one this
    // window just opened is not listed: on a phone that has just connected it
    // sat above the conversation being switched to, under the same name.
    .filter((session) => (session.id === currentId && !onBoard) || !isBlankConversation(session))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const workspace = current?.workspace ?? process.cwd();
  // Whether a worker is behind each chat. Re-checked while the board stays
  // open, so a turn that finishes mid-list drops out of Working.
  let workerIsLive = await liveWorkerSessions();
  // The turn each live-worker chat is generating, from its transcript -- the
  // one record of a turn in flight. Its `updatedAt` is the spinner's pace.
  let pendingById = await livePendingTurns(sessions, workerIsLive);
  const openedAt = Date.now();
  // One row per conversation, in its section (session/conversation-rows.ts,
  // the same rows the editor's history menu draws).
  let rows: ConversationRow[] = [];
  const fillActivity = (): void => {
    rows = conversationRows(sessions, { workerIsLive, pending: pendingById, currentId });
  };
  fillActivity();

  // ClikCode's own conversations are already in hand and are what /resume is
  // almost always for, so the picker opens on them immediately. Vendor
  // discovery folds in when it lands, through the same refresh mechanism the
  // account picker uses for usage. Awaiting it first left the composer cleared
  // and the screen blank for as long as the slowest vendor CLI took to answer.
  let discovered: AdoptableNativeSession[] = [];
  let discovering = true;
  // Two moments the rows change: what is already known (vendor files, and each
  // CLI's last list) within milliseconds, then the CLIs' fresh answers.
  let earlyLanded!: () => void;
  const early = new Promise<void>((resolveEarly) => { earlyLanded = resolveEarly; });
  const discovery = cachedAdoptableSessions(state, workspace, (found) => {
    if (discovering) discovered = found;
    earlyLanded();
  })
    .then((found) => { discovered = found; })
    .finally(() => { discovering = false; earlyLanded(); });
  // The "Looking for chats from other CLIs…" row is for a search worth
  // waiting on. Most finish in milliseconds, and the row flashed in and out.
  let slowDiscovery = false;
  const slow = new Promise<void>((resolveSlow) => { setTimeout(resolveSlow, SLOW_WAIT_MS).unref(); }).then(() => { slowDiscovery = true; });
  const refreshes = [early, discovery, slow];
  let listRevision = 0;
  let built: { discovering: boolean; slow: boolean; discovered: AdoptableNativeSession[]; revision: number; options: PickerOption<string>[] } | undefined;
  /** Re-check workers and the turns they are generating, and have the board
   * draw what changed: a spinner starts, or stops when the turn is over. */
  let activityRefresh: Promise<void> | undefined;
  /** The board's redraw: it draws a changed list without ticking for it. */
  let listChanged: (() => void) | undefined;
  const refreshActivity = (): void => {
    if (activityRefresh) return;
    activityRefresh = (async () => {
      workerIsLive = await liveWorkerSessions();
      pendingById = await livePendingTurns(sessions, workerIsLive);
      fillActivity();
      listRevision += 1;
      built = undefined;
    })().finally(() => { activityRefresh = undefined; listChanged?.(); });
  };
  // Conversations written before the summary existed get one after the list
  // is already up. The redraw copies the new previews onto the rows it holds.
  refreshes.push(backfillListFacts(state).then((fresh) => {
    // Nothing was stored: the list already shows what the index holds.
    if (!fresh) return;
    const byId = new Map(fresh.sessions.map((session) => [session.id, session]));
    for (const session of sessions) {
      const next = byId.get(session.id);
      if (!next) continue;
      if (next.listPreview) session.listPreview = next.listPreview;
      else delete session.listPreview;
      if (next.listMessageCount !== undefined) session.listMessageCount = next.listMessageCount;
      else delete session.listMessageCount;
      if (next.listChecked) session.listChecked = true;
      else delete session.listChecked;
    }
    for (let index = sessions.length - 1; index >= 0; index -= 1) {
      const session = sessions[index]!;
      if ((session.id !== currentId || onBoard) && isBlankConversation(session)) sessions.splice(index, 1);
    }
    fillActivity();
    listRevision += 1;
    built = undefined;
  }).catch(() => undefined));

  const histories = new Map<string, PickerOption<string>[]>();
  const buildFresh = (): PickerOption<string>[] => {
    // Every option gets a single real recency key so the newest conversation is
    // always near the top regardless of which source found it — grouping by
    // source first (every ClikCode session, then every opencode result, then
    // every Hermes result, ...) buried a two-minutes-old live Claude Code
    // session below Hermes entries from June, since each *group* was sorted
    // internally but the groups themselves were never interleaved. A source
    // with no real timestamp (an unparsed vendor display string) sorts last
    // rather than claiming a false position.
    histories.clear();
    type OptionBlock = { sortKey: number; options: PickerOption<string>[]; section: ConversationSection };
    const trackedBlocks = rows.map((row): OptionBlock => {
      const option = conversationOption(row, undefined, openedAt);
      const pending = row.pending;
      // Three cells in front of every title, so they line up: a running turn's
      // spinner (the board animates it) or its dot, otherwise blank.
      if (pending) option.working = turnPace(pending.updatedAt, openedAt);
      option.label = pending ? (onBoard ? option.label : `${activityGlyph('working', option.working)}  ${option.label}`) : `   ${option.label}`;
      if (pending) {
        option.detail = `${workingDetail(pending, openedAt)} ${option.detail ?? ''}`;
        if (pending.subagents?.length) option.inner = { title: 'Subagents', options: subagentOptions(pending, option.value, openedAt) };
      }
      // A turn parked for the quota reset says so, and when.
      else if (row.latest.resumeAt) option.detail = `· ${resumeWaitLabel(row.latest.resumeAt, openedAt)} ${option.detail ?? ''}`;
      if (row.latest.id !== currentId && sessionClaimIsLive(row.latest)) {
        option.detail = `${option.detail ?? ''} · active in another terminal`;
      }
      return { sortKey: row.updatedAtMs, options: [option], section: row.section };
    });
    const optionBlocks: OptionBlock[] = [
      ...trackedBlocks,
      ...discovered.map(({ harness, item, accountId }) => ({
        sortKey: item.updatedAtMs ?? -Infinity,
        section: recencySection(item.updatedAtMs, openedAt),
        options: [{
          label: `   ${harness.displayName} • ${item.title ?? 'Untitled chat'}`,
          detail: `· not yet in ClikCode${ADOPTED_TRANSCRIPT_READERS[harness.command] ? '' : ' · opens without earlier messages'}${item.workspace && item.workspace !== workspace ? ` · ${compactPath(item.workspace)}` : ''}${accountId ? ` · ${state.accounts.find((account) => account.id === accountId)?.label ?? 'linked account'}` : ''}${item.updatedAt ? ` · ${item.updatedAt}` : ''}`,
          // By identity, not position: the list is replaced when the CLIs
          // answer, and a row chosen from the earlier one must still resolve.
          value: nativeValue(harness.command, item.nativeId, accountId),
        }],
      })),
    ];
    optionBlocks.sort((left, right) => sectionRank(left.section) - sectionRank(right.section) || right.sortKey - left.sortKey);
    // Working (generating) first, then Active (last 24 hours), then Past.
    const sizes = new Map<ConversationSection, number>();
    for (const block of optionBlocks) sizes.set(block.section, (sizes.get(block.section) ?? 0) + block.options.length);
    const options: PickerOption<string>[] = optionBlocks.flatMap((block) => block.options.map((option) => ({
      ...option, group: `${SECTION_TITLES[block.section]} ${sizes.get(block.section)}`,
    })));
    for (const option of options) {
      if (option.value.startsWith('native:')) continue;
      const historyAction = option.alternates?.length ? [{ label: 'Provider history', value: 'history' }] : [];
      if (option.alternates?.length) histories.set(option.value, [...option.alternates]);
      delete option.alternates;
      option.actions = [...historyAction, ...MANAGE_ACTIONS];
      option.deleteAction = { label: 'Delete', value: 'delete' };
    }
    // On the board its composer is how a conversation starts.
    if (!onBoard) options.unshift({ label: '+ New conversation', detail: '· same provider and model', value: NEW_CONVERSATION_VALUE });
    if (discovering && slowDiscovery) {
      options.push({
        label: discovered.length ? '  Refreshing chats from other CLIs…' : '  Looking for chats from other CLIs…',
        detail: discovered.length ? '· showing what they listed last time' : '· your ClikCode conversations are listed above',
        value: PENDING_DISCOVERY_VALUE,
      });
    }
    return options;
  };
  // Asked for on every keypress (the list redraws, and a picker re-reads its
  // rows each time). Nothing it reads changes between keys except discovery
  // landing or the watch below, so the rows are rebuilt only then -- not all
  // five hundred of them per arrow press.
  const buildOptions = (): PickerOption<string>[] => {
    if (built && built.discovering === discovering && built.slow === slowDiscovery && built.discovered === discovered && built.revision === listRevision) {
      return built.options;
    }
    built = { discovering, slow: slowDiscovery, discovered, revision: listRevision, options: buildFresh() };
    return built.options;
  };
  // A turn starting or ending, or a worker exiting, writes the state or
  // worker directories: re-check then, instead of polling while a row spins,
  // so the spinner stops when the turn is over (session/list-watch.ts; a
  // slow poll where the directories cannot be watched).
  const listWatch = watchConversationList(refreshActivity);

  /** What a row action did to the chat that is open, so the loop can move off
   * one that no longer exists (deleted) or is put away (archived). */
  let replacement: string | undefined;
  /** After delete/archive, reopen the list instead of landing in a chat. */
  let returnToList = false;
  let actedOn = false;
  const manage = async (targetId: string, action: string): Promise<void> => {
    actedOn = true;
    if (action === 'history') {
      const selectedHistory = await chooseOption(rl, 'Provider history', histories.get(targetId) ?? []);
      if (selectedHistory) replacement = selectedHistory;
      return;
    }
    // Putting away the chat that is open lands on a fresh one with the same
    // setup -- staying in ClikCode, not leaving it. Made BEFORE the action,
    // because a deleted chat has no setup left to copy. The list reopens on
    // that draft so Delete does not drop the user into an empty chat.
    if (targetId === currentId && (action === 'archive' || action === 'delete')) {
      replacement = await newConversation(currentId);
    }
    if (action === 'rename') {
      const name = (await rl.question('Conversation name › ')).trim();
      if (name) await aiSessionCommand(targetId, `/rename ${name}`);
    } else if (action === 'fork') await aiSessionCommand(targetId, '/fork');
    // Archive needs no confirmation -- resuming undoes it. Delete is confirmed
    // by the picker itself before this runs.
    else if (action === 'archive') {
      await aiSessionCommand(targetId, '/archive');
      returnToList = true;
    } else if (action === 'delete') {
      await aiSessionCommand(targetId, '/delete confirm');
      returnToList = true;
    }
  };
  let selected: string | undefined;
  try {
    if (onBoard) {
      // The row for the conversation this window is in: its root, since the row
      // stands for the whole conversation and names its latest chat.
      const currentRoot = current ? conversationIdFor(current) : undefined;
      const initial = buildOptions().find((option) => {
        const listed = sessions.find((session) => session.id === option.value);
        return listed !== undefined && conversationIdFor(listed) === currentRoot;
      })?.value;
      const result = await rl.board!({
        conversations: buildOptions, commands: boardCommands!, refresh: refreshes, onAction: manage,
        listChanged: (redraw) => { listChanged = redraw; },
        ...(initial ? { initial } : {}),
        ...(hooks?.onSessionsSettled ? { onSessionsSettled: hooks.onSessionsSettled } : {}),
      });
      if (result && 'compose' in result) return { compose: result.compose };
      if (result && 'command' in result) return { command: result.command };
      selected = result?.open;
    } else {
      selected = await chooseOption(rl, 'Conversations', buildOptions(),
        (value, action) => manage(value, action),
        { refreshedOptions: buildOptions, refresh: refreshes,
          // Taller than a settings list -- it is the place to look over
          // everything running -- but never more than a small terminal can hold.
          rows: Math.max(8, Math.min(14, (process.stdout.rows ?? 24) - 16)) });
    }
  } finally {
    listWatch.stop();
  }
  // Delete and archive always return to the list. If the open chat was the
  // one removed, the list's "current" is the fresh draft made above.
  if (returnToList) return interactiveSessionPicker(rl, replacement ?? currentId, boardCommands, hooks);
  if (replacement) return { id: replacement };
  // Any other action closes the list on purpose (the picker rebuilds from
  // state rather than show a stale row), so it opens again on what changed.
  if (!selected && actedOn) return interactiveSessionPicker(rl, currentId, boardCommands, hooks);
  if (!selected) return undefined;
  if (selected === NEW_CONVERSATION_VALUE) return { new: true };
  if (selected === PENDING_DISCOVERY_VALUE) {
    await discovery;
    return interactiveSessionPicker(rl, currentId, boardCommands, hooks);
  }
  if (!selected.startsWith('native:')) return { id: selected };
  const match = discovered.find(({ harness, item, accountId }) => nativeValue(harness.command, item.nativeId, accountId) === selected);
  if (!match) return undefined;
  const nativeId = match.item.nativeId;
  const account = match.accountId
    ? state.accounts.find((item) => item.id === match.accountId)
    : state.accounts.find((item) => item.provider === match.harness.provider && item.status === 'ready');
  const defaults = resolveDefaultSettings(state, match.harness.provider);
  const now = new Date().toISOString();
  // The vendor's own thread already has full context regardless — adopting
  // its identity alone is enough for continuation to work correctly the
  // moment a turn is sent. Populating ClikCode's own transcript view too is a
  // separate, best-effort read: only wired for the harnesses with a confirmed
  // way to read a whole conversation back out (see ADOPTED_TRANSCRIPT_READERS
  // above), and never something continuation itself depends on.
  const chatWorkspace = match.item.workspace ?? workspace;
  const transcriptReader = ADOPTED_TRANSCRIPT_READERS[match.harness.command];
  const messages = transcriptReader
    ? await transcriptReader(match.harness, nativeId, chatWorkspace, nativeProfileEnvironment(account?.nativeProfile)).catch(() => [])
    : [];
  const id = randomUUID();
  const adopted: HarnessSession = {
    id, conversationId: id, route: 'local', accountId: account?.id ?? null, provider: match.harness.provider,
    model: null, effort: defaults.effort, permissionMode: defaults.permissionMode, accountFailover: defaults.accountFailover,
    createdAt: now, updatedAt: now, status: 'active',
    nativeHarness: match.harness.command, nativeSessionId: nativeId, nativeStartedAt: now,
    // Named only from a title the harness itself wrote. The resume list also
    // shows the opening of the first message when there is no real title, and
    // writing THAT into `name` is what used to leave every adopted chat called
    // "we need to have scrolling but we need to not have terminal / co…" --
    // a preview that looks like a name forever, because nameSession returns
    // early on any name at all and can never replace it.
    workspace: chatWorkspace, ...(match.item.titleIsGenerated && match.item.title ? { name: match.item.title, nameSource: 'provider' as const } : {}),
    ...(messages.length ? { messages } : {}),
  };
  state.sessions.push(adopted);
  await writeState(state);
  // Picking a specific vendor's own chat by name is an explicit choice to open
  // it as that vendor — forcing it onto whatever provider was already active
  // (the same-conversation /resume behavior below) would immediately discard
  // the native session id just adopted, undoing the entire point of listing it.
  return { id: adopted.id };
}
