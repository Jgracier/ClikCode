/** The state one vendor turn's attempts share, held in one object. */
import { diagnostic } from '../runtime/lifecycle-log.js';
import type { HarnessSession, HarnessState } from '../session/model.js';
import type { AiHarnessAccount, AiLocalHarnessDefinition } from '../harness/definition.js';
import { resolveNativeModel } from '../harness/accounts/model-catalog.js';
import { ensureNativeHarness } from '../harness/transport/native/inspect.js';
import { harnessCanRunTurns, harnessSupportsImages, localHarnessForCommand, localHarnessForProvider } from '../runtime/lazy-bridge.js';
import { sessionTranscriptMessages } from './checkpoint.js';
import { turnAccounts, turnBackendForAccount } from './account-routing.js';
import { leavePersistentTransport } from './vendor-process.js';
import { startTurnCheckpoint, type DurableTurnCheckpoint } from './turn-journal.js';
import type { TurnObserver } from './observer.js';
import type { AccountTurnInput, TurnRunOptions } from './session-turn.js';
import { withResourceNotes } from './resource-notes.js';

/** What this turn has already tried: each recovery runs once per turn (or,
 * for a fresh native thread, once per account). */
export interface AttemptState {
  /** Bounded to one attempt: signing in again is a reactive fallback, and
   * retrying more than once would risk a loop if login does not fix it. */
  authRetried: boolean;
  /** Whether this turn opened a standby for its failover account. */
  standbyOpened: boolean;
  /** A fresh native thread gets one recovery attempt per account. */
  nativeThreadRetried: boolean;
}

export interface VendorTurnContext {
  readonly state: HarnessState;
  readonly session: HarnessSession;
  readonly harness: AiLocalHarnessDefinition;
  readonly text: string;
  readonly startedAt: number;
  readonly signal: AbortSignal | undefined;
  readonly run: TurnRunOptions;
  readonly prompter: TurnObserver | undefined;
  readonly checkpoint: DurableTurnCheckpoint;
  readonly accounts: ReturnType<typeof turnAccounts>;
  /** What the request carried besides its words. A retry on a fresh thread
   * retells the conversation from ClikCode's copy, which holds only what was
   * typed -- without this the attached files were silently gone from it. (`!`
   * output needs nothing: it is its own message in that copy.) */
  readonly requestContext: string;
  readonly images: string[];
  readonly cliCarriesImages: boolean;
  readonly baseMessages: ReturnType<typeof sessionTranscriptMessages>;
  account: AiHarnessAccount;
  model: string | null;
  turnText: string;
  /** The original request with attachments, before any handoff framing.
   * Fresh-thread recovery must never retell a prepared transfer as a request. */
  readonly askedText: string;
  readonly attempt: AttemptState;
}

export async function createVendorTurnContext(input: AccountTurnInput): Promise<VendorTurnContext> {
  const { state, session, text, prepared, startedAt, signal, run } = input;
  let { model, turnText } = input;
  const prompter = run.prompter;
  const harness = session.nativeHarness
    ? localHarnessForCommand(session.nativeHarness)
    : localHarnessForProvider(input.account.provider);
  if (!harness) throw new Error(`no native harness is registered for provider ${input.account.provider}`);
  if (!harnessCanRunTurns(harness)) throw new Error(`${harness.displayName} cannot execute centralized non-interactive turns`);
  if (harness.provider !== input.account.provider) throw new Error(`session provider ${harness.displayName} does not match account "${input.account.label}"`);
  // Installed before anything spawns it: model discovery below, then
  // whichever transport runs the turn -- the app-server and ACP ones too,
  // which spawn the binary themselves. A chat whose harness this machine
  // does not have (chosen elsewhere, or uninstalled since) installs it here
  // instead of failing "not found".
  await ensureNativeHarness(harness, prompter ? {
    reporter: {
      start: (label) => prompter.phase(label),
      done: (message) => diagnostic('vendor.installed', message),
      failed: () => undefined,
    },
  } : {});
  // Resolve a real model here too, not only when a session is OPENED.
  // A headless send -- `sessions send`, and every member of a fan-out --
  // never goes through the interactive open path, so it recorded no model
  // at all: the invocation landed with the field absent and usage could
  // not be attributed to anything. Cheap to call (the catalog is cached,
  // and an ACP session keeps it current) and persisted, so the next turn
  // on this session finds it already there.
  if (!model) {
    model = await resolveNativeModel(harness, input.account) ?? null;
    if (model) session.model = model;
  }
  // A vendor that takes no images is sent none, and nothing about them in
  // words: the user is told, and the files stay attached.
  if (prepared.images.length && !harnessSupportsImages(harness)) {
    throw new Error(`Image attachments are not available for ${harness.displayName}. Clear them with /attachments clear.`);
  }
  const images = prepared.images;
  const cliCarriesImages = Boolean(harness.imageArgvPrefix);
  session.nativeHarness = harness.command;
  session.provider = harness.provider;
  session.workspace ??= process.cwd();
  const baseMessages = sessionTranscriptMessages(session);
  const checkpoint = await startTurnCheckpoint(state, session, text, run);
  const accounts = turnAccounts({
    state, session, prompter, matchesBackend: (item) => turnBackendForAccount(item) === 'vendor',
    persist: () => checkpoint.persistNow(), current: () => context.account, adopt: (to) => { context.account = to; },
    beforeSwitch: () => leavePersistentTransport(session.id),
  });
  const context: VendorTurnContext = {
    state, session, harness, text, startedAt, signal, run, prompter, checkpoint, accounts,
    requestContext: prepared.textContext, images, cliCarriesImages, baseMessages,
    account: input.account, model, turnText: withResourceNotes(session.id, turnText), askedText: turnText,
    attempt: { authRetried: false, standbyOpened: false, nativeThreadRetried: false },
  };
  return context;
}

/** The reasoning level to ask for: the conversation's, passed to the vendor as set. */
export const turnEffort = (ctx: VendorTurnContext): string | undefined => ctx.session.effort || undefined;
