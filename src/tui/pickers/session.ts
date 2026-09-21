/** Choosing a session to resume, including sessions a vendor CLI started
 * outside ClikCode and that can be adopted. */

import { randomUUID } from 'node:crypto';
import { inspectNativeHarness } from '../../harness/transport/native.js';
import { discoverNativeSessions } from '../../session/discovery/cli-listing.js';
import { ADOPTED_TRANSCRIPT_READERS, FS_SESSION_DISCOVERY } from '../../session/discovery/registry.js';
import { type DiscoveredNativeSession } from '../../session/discovery/types.js';
import type { AiHarnessAccount, AiLocalHarnessDefinition, HarnessPrompter, HarnessSession, HarnessState, PickerOption } from '../../harness/types.js';
import { nativeProfileEnvironment } from '../../harness/transport/profile-environment.js';
import { localHarnessForCommand } from '../../runtime/lazy-bridge.js';
import { readState } from '../../session/state/read.js';
import { resolveDefaultSettings } from '../../session/state/settings.js';
import { writeState } from '../../session/state/write.js';
import { allLocalHarnesses } from '../../runtime/lazy-bridge.js';
import { sessionClaimIsLive } from '../../session/claim.js';
import { conversationIdFor, sessionPickerOptions } from '../../session/options.js';
import { sessionTranscriptMessages } from '../../turn/checkpoint.js';
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
async function discoverAdoptableSessions(state: HarnessState, workspace: string): Promise<AdoptableNativeSession[]> {
  const discoveryProfiles = (harness: AiLocalHarnessDefinition): Array<AiHarnessAccount | undefined> => {
    const accounts = state.accounts.filter((item) => item.provider === harness.provider && item.status === 'ready');
    if (!accounts.length) return [undefined];
    const unique = new Map<string, AiHarnessAccount>();
    for (const account of accounts) unique.set(account.nativeProfile?.path ?? 'default', account);
    return [...unique.values()];
  };
  const discoverable = allLocalHarnesses().filter((harness) => harness.session?.discoverArgv);
  const shellDiscovered = (await Promise.all(discoverable.map(async (harness) => {
    return (await Promise.all(discoveryProfiles(harness).map(async (account) => {
      const environment = nativeProfileEnvironment(account?.nativeProfile);
      const found = await discoverNativeSessions(harness, environment, workspace);
      return found.map((item) => ({ harness, item, accountId: account?.id }));
    }))).flat();
  }))).flat();
  const fsDiscovered = (await Promise.all(Object.entries(FS_SESSION_DISCOVERY).map(async ([command, discover]) => {
    const harness = localHarnessForCommand(command);
    if (!harness) return [];
    const inspection = await inspectNativeHarness(harness, 500);
    if (!inspection.installed) return [];
    return (await Promise.all(discoveryProfiles(harness).map(async (account) => {
      const found = await discover(workspace, nativeProfileEnvironment(account?.nativeProfile)).catch(() => []);
      return found.map((item) => ({ harness, item, accountId: account?.id }));
    }))).flat();
  }))).flat();
  return [...shellDiscovered, ...fsDiscovered]
    .filter(({ harness, item, accountId }) => !state.sessions.some((session) => session.nativeHarness === harness.command
      && session.nativeSessionId === item.nativeId && (!accountId || session.accountId === accountId)));
}

/** Indirection so tests can hold discovery open and observe the picker while
 * it is still pending. */
export const NATIVE_SESSION_DISCOVERY = { run: discoverAdoptableSessions };

const NATIVE_DISCOVERY_TTL_MS = 60_000;

let nativeDiscoveryCache: { key: string; at: number; result: Promise<AdoptableNativeSession[]> } | undefined;

export function resetNativeDiscoveryCache(): void {
  nativeDiscoveryCache = undefined;
}

/** Reopening /resume inside one terminal re-spawned every installed vendor CLI
 * from scratch. The listing does not change meaningfully minute to minute, so
 * hold it briefly — keyed on the inputs that would change the answer. */
function cachedAdoptableSessions(state: HarnessState, workspace: string): Promise<AdoptableNativeSession[]> {
  const key = [workspace, ...state.accounts.map((item) => `${item.id}:${item.nativeProfile?.path ?? ''}`).sort()].join('\u0000');
  const cached = nativeDiscoveryCache;
  if (cached && cached.key === key && Date.now() - cached.at < NATIVE_DISCOVERY_TTL_MS) return cached.result;
  const result = NATIVE_SESSION_DISCOVERY.run(state, workspace).catch(() => {
    // fail-open-ok: discovery is passive enrichment of a list that is already
    // complete for ClikCode's own conversations. A vendor CLI that fails must
    // not take /resume down with it, and must not be cached as an answer.
    nativeDiscoveryCache = undefined;
    return [] as AdoptableNativeSession[];
  });
  nativeDiscoveryCache = { key, at: Date.now(), result };
  return result;
}

/** Selected while discovery is still running: wait for it, then reopen. */
const PENDING_DISCOVERY_VALUE = '__discovering__';

export async function interactiveSessionPicker(rl: HarnessPrompter, currentId: string): Promise<{ id: string } | undefined> {
  const state = await readState();
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
    .filter((session) => session.id === currentId || sessionTranscriptMessages(session).length > 0 || Boolean(session.nativeSessionId))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const workspace = current?.workspace ?? process.cwd();

  // ClikCode's own conversations are already in hand and are what /resume is
  // almost always for, so the picker opens on them immediately. Vendor
  // discovery folds in when it lands, through the same refresh mechanism the
  // account picker uses for usage. Awaiting it first left the composer cleared
  // and the screen blank for as long as the slowest vendor CLI took to answer.
  let discovered: AdoptableNativeSession[] = [];
  let discovering = true;
  const discovery = cachedAdoptableSessions(state, workspace)
    .then((found) => { discovered = found; })
    .finally(() => { discovering = false; });

  const buildOptions = (): PickerOption<string>[] => {
    // Every option gets a single real recency key so the newest conversation is
    // always near the top regardless of which source found it — grouping by
    // source first (every ClikCode session, then every opencode result, then
    // every Hermes result, ...) buried a two-minutes-old live Claude Code
    // session below Hermes entries from June, since each *group* was sorted
    // internally but the groups themselves were never interleaved. A source
    // with no real timestamp (an unparsed vendor display string) sorts last
    // rather than claiming a false position.
    const groupedOptions = sessionPickerOptions(sessions, currentId);
    const sessionsById = new Map(sessions.map((session) => [session.id, session]));
    const trackedBlocks = new Map<string, { sortKey: number; options: PickerOption<string>[] }>();
    for (const option of groupedOptions) {
      const session = sessionsById.get(option.value)!;
      if (session.id !== currentId && sessionClaimIsLive(session)) {
        option.detail = `${option.detail ?? ''} · active in another terminal`;
      }
      const root = conversationIdFor(session);
      const updatedAt = Date.parse(session.updatedAt);
      const block = trackedBlocks.get(root) ?? { sortKey: -Infinity, options: [] };
      block.sortKey = Math.max(block.sortKey, Number.isNaN(updatedAt) ? -Infinity : updatedAt);
      block.options.push(option);
      trackedBlocks.set(root, block);
    }
    const optionBlocks = [
      ...trackedBlocks.values(),
      ...discovered.map(({ harness, item, accountId }, index) => ({
        sortKey: item.updatedAtMs ?? -Infinity,
        options: [{
          label: `${harness.displayName} • ${item.title ?? 'Untitled chat'}`,
          detail: `· not yet in ClikCode${accountId ? ` · ${state.accounts.find((account) => account.id === accountId)?.label ?? 'linked account'}` : ''}${item.updatedAt ? ` · ${item.updatedAt}` : ''}`,
          value: `native:${index}`,
        }],
      })),
    ].sort((left, right) => right.sortKey - left.sortKey);
    // Conversation roots and unadopted native sessions share one recency order.
    // Provider hops stay behind each root row's Tab history.
    const options = optionBlocks.flatMap((block) => block.options);
    if (discovering) {
      options.push({
        label: 'Looking for chats from other CLIs…',
        detail: '· your ClikCode conversations are listed above',
        value: PENDING_DISCOVERY_VALUE,
      });
    }
    return options;
  };

  const selected = await chooseOption(rl, 'Resume a session', buildOptions(), undefined,
    { refreshedOptions: buildOptions, refresh: discovery });
  if (!selected) return undefined;
  if (selected === PENDING_DISCOVERY_VALUE) {
    await discovery;
    return interactiveSessionPicker(rl, currentId);
  }
  if (!selected.startsWith('native:')) return { id: selected };
  const match = discovered[Number.parseInt(selected.slice('native:'.length), 10)];
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
  const transcriptReader = ADOPTED_TRANSCRIPT_READERS[match.harness.command];
  const messages = transcriptReader
    ? await transcriptReader(match.harness, nativeId, workspace, nativeProfileEnvironment(account?.nativeProfile)).catch(() => [])
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
    workspace, ...(match.item.titleIsGenerated && match.item.title ? { name: match.item.title, nameSource: 'provider' as const } : {}),
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

export async function interactiveSessionManager(rl: HarnessPrompter, id: string): Promise<'resume' | 'new' | 'exit' | undefined> {
  const action = await chooseOption(rl, 'Conversations', [
    { label: 'Resume another…', value: 'resume' },
    { label: 'Start clean', detail: 'reset provider context', value: 'new' },
    { label: 'Rename', value: 'rename' },
    { label: 'Fork', detail: 'copy transcript into a new conversation', value: 'fork' },
    { label: 'Archive', value: 'archive' },
    { label: 'Delete', detail: 'remove local ClikCode history', value: 'delete' },
  ] as const);
  if (!action) return undefined;
  if (action === 'resume') return 'resume';
  if (action === 'new') return 'new';
  if (action === 'rename') {
    const name = (await rl.question('Conversation name › ')).trim();
    if (name) await aiSessionCommand(id, `/rename ${name}`);
    return undefined;
  }
  if (action === 'fork') { await aiSessionCommand(id, '/fork'); return undefined; }
  if (action === 'archive') {
    const answer = (await rl.question('Archive this conversation? [y/N] › ')).trim().toLowerCase();
    if (answer === 'y' || answer === 'yes') { await aiSessionCommand(id, '/archive'); return 'exit'; }
    return undefined;
  }
  const answer = (await rl.question('Delete this conversation from ClikCode? Type delete › ')).trim().toLowerCase();
  if (answer === 'delete') { await aiSessionCommand(id, '/delete confirm'); return 'exit'; }
  return undefined;
}
