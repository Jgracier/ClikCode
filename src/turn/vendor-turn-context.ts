/** The state one vendor turn's attempts share, held in one object. */
import chalk from 'chalk';
import type { HarnessSession, HarnessState } from '../session/model.js';
import type { AiHarnessAccount, AiLocalHarnessDefinition } from '../harness/definition.js';
import { resolveNativeModel } from '../harness/accounts/model-catalog.js';
import { sessionTitleSource, prepareSessionTitle, type StreamingTitle } from '../session/title.js';
import { ensureNativeHarness } from '../harness/transport/native/inspect.js';
import { harnessCanRunTurns, harnessSupportsImages, localHarnessForCommand, localHarnessForProvider } from '../runtime/lazy-bridge.js';
import type { prepareAttachments } from '../session/attachments.js';
import { sessionTranscriptMessages } from './checkpoint.js';
import { turnAccounts, turnBackendForAccount } from './account-routing.js';
import { closePersistentTransport } from './vendor-process.js';
import { startTurnCheckpoint, type DurableTurnCheckpoint } from './turn-journal.js';
import { mcpServerNeedsSignIn, type McpSignInAnswer } from '../harness/mcp-sign-in.js';
import type { McpServerEntry } from '../harness/mcp-registry.js';
import { stateDirectory } from '../session/store/paths.js';
import type { TurnObserver } from './observer.js';
import type { TurnRunOptions } from './session-turn.js';
import { withResourceNotes } from './resource-notes.js';

/** What this turn has already tried: each recovery runs once per turn (or,
 * for a fresh native thread, once per account). */
export interface AttemptState {
  /** Bounded to one attempt: signing in again is a reactive fallback, and
   * retrying more than once would risk a loop if login does not fix it. */
  authRetried: boolean;
  effortRetried: boolean;
  /** Whether this turn opened a standby for its failover account. */
  standbyOpened: boolean;
  /** The account this turn's thread was copied to before its first attempt
   * wrote anything: a failover to it with nothing written needs no copy. */
  threadCopiedTo: string | undefined;
  /** A fresh native thread gets one recovery attempt per account. */
  nativeThreadRetried: boolean;
  transientRetried: boolean;
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
  readonly titleSource: ReturnType<typeof sessionTitleSource>;
  /** What the request carried besides its words. A retry on a fresh thread
   * retells the conversation from ClikCode's copy, which holds only what was
   * typed -- without this the attached files were silently gone from it. (`!`
   * output needs nothing: it is its own message in that copy.) */
  readonly requestContext: string;
  readonly images: string[];
  readonly cliCarriesImages: boolean;
  readonly cliImageNote: string;
  readonly baseMessages: ReturnType<typeof sessionTranscriptMessages>;
  readonly checkMcpSignIn: (entry: McpServerEntry, headersReach: boolean) => Promise<McpSignInAnswer>;
  account: AiHarnessAccount;
  model: string | null;
  turnText: string;
  /** The request this turn was asked, before a retry replaces it. A failover
   * that produced no output sends this again; rebuilding the transcript
   * would repeat the whole conversation on top of a thread that already has it. */
  askedText: string;
  titleStream: StreamingTitle | undefined;
  readonly attempt: AttemptState;
}

export async function createVendorTurnContext(input: {
  state: HarnessState;
  session: HarnessSession;
  account: AiHarnessAccount;
  model: string | null;
  text: string;
  prepared: Awaited<ReturnType<typeof prepareAttachments>>;
  turnText: string;
  startedAt: number;
  signal?: AbortSignal;
  run: TurnRunOptions;
}): Promise<VendorTurnContext> {
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
      done: (message) => prompter.activity(chalk.dim(message)),
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
  // An unnamed chat gets a title from the harness that writes one. Where the
  // harness does not, one turn asks, once the user has said enough to name
  // the chat. The request rides on that turn's text only -- never on what is
  // stored as the user's message -- and only that reply drops the marker.
  const titleSource = sessionTitleSource(harness);
  const titleRequest = titleSource === 'ask' ? prepareSessionTitle(session, turnText) : undefined;
  const titleStream = titleRequest?.stream;
  if (titleRequest) turnText = titleRequest.prompt;
  // Resource notes ClikCode held for this conversation ride the same way (turn/resource-notes.ts).
  turnText = withResourceNotes(session.id, turnText);
  const supportsImages = harnessSupportsImages(harness);
  const images = supportsImages ? prepared.images : [];
  const imageListing = `\n\nImage files available in the workspace:\n${prepared.images.map((path) => `- ${path}`).join('\n')}`;
  const imageNote = prepared.images.length && !supportsImages ? imageListing : '';
  // An ACP agent takes the images as blocks; if it does not advertise them the
  // turn lands on the CLI, which (no attach flag) is told where the files are.
  const cliCarriesImages = Boolean(harness.imageArgvPrefix);
  const cliImageNote = images.length && !cliCarriesImages ? imageListing : '';
  turnText += imageNote;
  const requestContext = `${prepared.textContext}${imageNote}`;
  session.nativeHarness = harness.command;
  session.provider = harness.provider;
  session.workspace ??= process.cwd();
  const baseMessages = sessionTranscriptMessages(session);
  const checkpoint = await startTurnCheckpoint(state, session, text, run);
  const accounts = turnAccounts({
    state, session, prompter, matchesBackend: (item) => turnBackendForAccount(item) === 'vendor',
    persist: () => checkpoint.persistNow(), current: () => context.account, adopt: (to) => { context.account = to; },
    beforeSwitch: () => closePersistentTransport(session.id),
  });
  // A quota refusal can try several accounts in one turn. A remote MCP
  // server that times out otherwise costs its full probe timeout on every
  // attempt, though its answer is the same for this harness and config.
  const signInChecks = new Map<string, Promise<McpSignInAnswer>>();
  const checkMcpSignIn = (entry: McpServerEntry, headersReach: boolean): Promise<McpSignInAnswer> => {
    const key = JSON.stringify([entry.target, entry.headers, headersReach]);
    let check = signInChecks.get(key);
    if (!check) {
      check = mcpServerNeedsSignIn(entry, { stateDir: stateDirectory(), headersReach });
      signInChecks.set(key, check);
    }
    return check;
  };
  const context: VendorTurnContext = {
    state, session, harness, text, startedAt, signal, run, prompter, checkpoint, accounts, titleSource,
    requestContext, images, cliCarriesImages, cliImageNote, baseMessages, checkMcpSignIn,
    account: input.account, model, turnText, askedText: turnText, titleStream,
    attempt: { authRetried: false, effortRetried: false, standbyOpened: false, threadCopiedTo: undefined, nativeThreadRetried: false, transientRetried: false },
  };
  return context;
}

export const effortKey = (ctx: VendorTurnContext): string => `${ctx.harness.command} ${ctx.model ?? ''} ${ctx.session.effort}`;
/** The reasoning level to ask for: the session's, unless the vendor refused it for this model. */
export const turnEffort = (ctx: VendorTurnContext): string | undefined =>
  ctx.session.effort && ctx.session.effortRefused !== effortKey(ctx) ? ctx.session.effort : undefined;
