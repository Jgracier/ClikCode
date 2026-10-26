/** Keeping a large conversation's prompt cache alive between turns.
 *
 * Claude keeps a conversation's prompt cache for an hour from its last use. Come back after that
 * and the whole history is read again from scratch: measured 2026-10-18 over a day of four large
 * conversations, 22 of 22 turns sent more than an hour after the last reply re-read everything
 * (500k-930k tokens, 30-45 s), while 706 of 714 turns within the hour read from cache. A cache
 * read also resets the hour, and costs a tenth of an input token where rebuilding the cache costs
 * two: so one small request every PING_EVERY_MS keeps it, at about 1/20 of a rebuild each.
 *
 * For KEEP_WARM_FOR_MS after the last Claude Code turn, and only above KEEP_WARM_ABOVE_TOKENS
 * (below it a rebuild is quick and cheap): at most four pings. Each ping runs on a copy under another
 * id -- the cache is keyed by content, not session -- which is removed afterwards, so the
 * conversation itself is untouched and nothing is listed. Claude only: its cache lifetime and
 * refresh-on-read are what this was measured against. */
import { randomUUID } from 'node:crypto';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { diagnostic, lifecycle, quiet } from '../runtime/lifecycle-log.js';
import { readState } from '../session/state/read.js';
import { writeState } from '../session/state/write.js';
import { locateNativeSessionFile } from '../session/discovery/registry.js';
import { sessionHarness } from '../tui/slash/context.js';
import { sessionTurnTransport } from '../harness/transport/select.js';
import { turnEnvironment } from '../turn/turn-environment.js';
import { pingPromptCache } from '../turn/vendor-session-attempt.js';
import { recordInvocation } from '../turn/turn-output.js';
import type { TurnUsage } from '../harness/protocol/turn-usage.js';
import type { HarnessSession } from '../session/model.js';

export const KEEP_WARM_FOR_MS = 4 * 60 * 60 * 1000;
export const PING_EVERY_MS = 55 * 60 * 1000;
export const KEEP_WARM_ABOVE_TOKENS = 100_000;
export const MAX_KEEP_WARM_PINGS = 4;
const PING_TIMEOUT_MS = 2 * 60 * 1000;

/** A refresh is useful only when the vendor says it read most of this chat
 * from cache and wrote less than it read. A successful reply alone does not
 * establish that: a copied Claude thread can answer while rewriting its
 * history on every ping. */
export function cachePingEffective(usage: TurnUsage, contextUsed: number): boolean {
  const read = usage.cacheRead ?? 0;
  return read >= Math.floor(contextUsed / 2) && read > (usage.cacheWrite ?? 0);
}

/** Whether a conversation's cache is worth keeping, by what its harness is and how big it is. */
export function keepsWarm(session: HarnessSession | undefined): boolean {
  if (!session?.nativeSessionId || !session.workspace || !session.accountId) return false;
  const harness = sessionHarness(session);
  if (harness?.command !== 'claude' || sessionTurnTransport(harness, session) !== 'acp') return false;
  return (session.lastUsage?.contextUsed ?? 0) >= KEEP_WARM_ABOVE_TOKENS;
}

export interface KeepWarm {
  /** A turn ended: only a completed Claude Code turn starts four hours. */
  turnEnded(lastHarness: string | undefined): Promise<void>;
  /** Pings are pending: the worker stays up to send them. */
  active(): boolean;
  stop(): void;
}

export function createKeepWarm(deps: {
  sessionId: string; busy: () => boolean; changed: () => void;
  readSession?: () => Promise<HarnessSession | undefined>;
  ping?: (sessionId: string, signal: AbortSignal) => Promise<boolean>;
}): KeepWarm {
  let lastTurnAt: number | undefined;
  let timer: NodeJS.Timeout | undefined;
  let pingController: AbortController | undefined;
  let nextPing = 0;
  let revision = 0;
  const active = (): boolean => lastTurnAt !== undefined && Date.now() - lastTurnAt < KEEP_WARM_FOR_MS;
  const stop = (): void => {
    revision += 1;
    if (timer) clearTimeout(timer);
    timer = undefined;
    pingController?.abort();
    pingController = undefined;
    const was = lastTurnAt !== undefined;
    lastTurnAt = undefined;
    if (was) deps.changed();
  };
  const arm = (): void => {
    if (timer) clearTimeout(timer);
    if (!active()) { stop(); return; }
    // Anchor each slot to the last Claude turn. A slow request skips elapsed
    // slots rather than issuing several paid pings back to back.
    while (nextPing < MAX_KEEP_WARM_PINGS && lastTurnAt! + (nextPing + 1) * PING_EVERY_MS <= Date.now()) nextPing += 1;
    const due = nextPing < MAX_KEEP_WARM_PINGS
      ? lastTurnAt! + (nextPing + 1) * PING_EVERY_MS
      : lastTurnAt! + KEEP_WARM_FOR_MS;
    timer = setTimeout(() => { void fire(); }, Math.max(0, due - Date.now()));
    timer.unref?.();
  };
  const fire = async (): Promise<void> => {
    timer = undefined;
    if (!active()) { stop(); return; }
    if (nextPing >= MAX_KEEP_WARM_PINGS) { stop(); return; }
    const current = revision;
    nextPing += 1;
    // A user turn refreshes the cache itself. It also aborts an in-flight ping.
    if (!deps.busy()) {
      const controller = new AbortController();
      pingController = controller;
      const timeout = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
      timeout.unref?.();
      try {
        const eligible = await (deps.ping ?? ping)(deps.sessionId, controller.signal);
        if (!eligible && current === revision) { stop(); return; }
      } catch (error) {
        if (current === revision) diagnostic('worker.cache-ping', error instanceof Error ? error.message : String(error));
      } finally {
        clearTimeout(timeout);
        if (pingController === controller) pingController = undefined;
      }
    }
    if (current !== revision) return;
    arm();
  };
  return {
    async turnEnded(lastHarness) {
      if (lastHarness !== 'claude') { stop(); return; }
      const current = ++revision;
      const session = await (deps.readSession?.() ?? readState({ transcripts: [] }).then((state) => state.sessions.find((item) => item.id === deps.sessionId))).catch(quiet('worker/cache-keepwarm'));
      if (current !== revision) return;
      if (!keepsWarm(session)) { stop(); return; }
      const starting = lastTurnAt === undefined;
      lastTurnAt = Date.now();
      nextPing = 0;
      arm();
      if (starting) deps.changed();
    },
    active,
    stop,
  };
}

/** One cache read of the conversation as it stands, on a throwaway copy of its thread. */
async function ping(sessionId: string, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false;
  const state = await readState({ transcripts: [] });
  const session = state.sessions.find((item) => item.id === sessionId);
  const account = session?.accountId ? state.accounts.find((item) => item.id === session.accountId) : undefined;
  const harness = sessionHarness(session);
  if (!session || !account || !harness || !keepsWarm(session)) return false;
  const nativeId = session.nativeSessionId!;
  // A maintenance prompt cannot inherit a chat's auto or bypass tool policy.
  // With ask and no approval observer, any tool request is declined.
  const environment = turnEnvironment(harness, account, 'ask');
  const source = await locateNativeSessionFile(harness, nativeId, session.workspace!, environment);
  if (!source || !basename(source.path).includes(nativeId) || signal.aborted) return false;
  const copyId = randomUUID();
  const copy = join(source.path, '..', basename(source.path).replace(nativeId, copyId));
  const started = Date.now();
  let usage: TurnUsage = {};
  try {
    await writeFile(copy, (await readFile(source.path, 'utf8')).replaceAll(nativeId, copyId), { mode: 0o600 });
    if (signal.aborted) return false;
    usage = await pingPromptCache({ harness, account, session, copyId, model: session.model ?? null, effort: session.effort, environment, signal, onUsage: (reported) => { usage = reported; } });
    const effective = cachePingEffective(usage, session.lastUsage?.contextUsed ?? KEEP_WARM_ABOVE_TOKENS);
    lifecycle('worker.cache-ping', { ms: Date.now() - started, effective, ...usage });
    return effective;
  } finally {
    try {
      if ([usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.totalTokens, usage.costUsd].some((value) => (value ?? 0) > 0)) {
        recordInvocation(state, {
          kind: 'maintenance', sessionId, accountId: account.id, provider: harness.provider,
          model: session.model, startedAt: started,
          usage: { ...usage, totalTokens: usage.totalTokens ?? (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0) },
        });
        await writeState(state);
      }
    } finally {
      await rm(copy, { force: true });
      if (account.nativeProfile?.path) await removeNamed(account.nativeProfile.path, copyId, 3);
    }
  }
}

/** What the vendor kept beside the copy (its todos, session state): every entry named after it. */
async function removeNamed(root: string, id: string, depth: number): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    const path = join(root, entry.name);
    if (entry.name.includes(id)) await rm(path, { recursive: true, force: true });
    else if (entry.isDirectory() && depth > 1) await removeNamed(path, id, depth - 1);
  }
}
