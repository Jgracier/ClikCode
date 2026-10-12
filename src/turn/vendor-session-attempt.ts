/** One ACP or app-server attempt, with a CLI fallback where the vendor permits it. */
import { lifecycle } from '../runtime/lifecycle-log.js';
import chalk from 'chalk';
import type { AiHarnessAccount, AiHarnessPermissionMode, AiLocalHarnessDefinition } from '../harness/definition.js';
import type { HarnessSession } from '../session/model.js';
import type { HarnessTurnObserver } from '../harness/events/turn-observer.js';
import { cliThreadTransport, type HarnessTurnTransport } from '../harness/transport/select.js';
import type { NativeTurnResult } from '../harness/protocol/turn-result.js';
import type { DurableTurnCheckpoint } from './turn-journal.js';
import { setPlanMode } from './turn-steps.js';
import type { TurnRunOptions } from './session-turn.js';
import { runCodexAppServerTurn, type CodexAppServerTurnInput, type CodexSession } from '../harness/transport/codex-app-server.js';
import { runAcpTurn, type AcpSession, type AcpTurnInput } from '../harness/transport/acp-client.js';
import { optionIdsForControl } from '../harness/options.js';
import { appServerThreadOverrides, declaredOptionArgv } from '../harness/transport/options.js';
import { recordDerivedUsage } from '../harness/accounts/stream-usage.js';
import { readAcpUsageFile } from '../harness/transport/acp-usage-file.js';
import { turnShareOf } from '../harness/protocol/turn-usage.js';
import { codexRateLimitsReading } from '../harness/accounts/usage-probes.js';
import { harnessAcpLaunch, localHarnessCapabilityManifest } from '../runtime/lazy-bridge.js';
import { swarmIsOn } from '../swarm/policy.js';
import { swarmAcpMcpServers, swarmCodexConfig } from '../swarm/publish.js';
import { closePersistentTransport, openStandby, persistentTransportFor, vendorChildKey } from './vendor-process.js';
import { loadIndex } from '../session/state/index-file.js';
import { isTurnCancelled } from '../agent/cancellation.js';
import { recordLiveModelCatalog } from '../harness/accounts/model-catalog.js';

/** Per chat, the unapplied options last said (see the app-server branch). */
const ignoredOptionsSaid = new Map<string, string>();

/** The conversation's permission mode as the user has it now (/permissions writes the index while a turn runs). */
async function storedPermissionMode(sessionId: string): Promise<AiHarnessPermissionMode | undefined> {
  return (await loadIndex())?.sessions.find((item) => item.id === sessionId)?.permissionMode;
}

export async function runVendorSessionAttempt(input: {
  harness: AiLocalHarnessDefinition;
  account: AiHarnessAccount;
  session: HarnessSession;
  transport: Extract<HarnessTurnTransport, 'acp' | 'codex-app-server'>;
  turnText: string;
  model: string | null;
  environment: Record<string, string>;
  images: string[];
  signal?: AbortSignal;
  run: TurnRunOptions;
  checkpoint: DurableTurnCheckpoint;
  sharedObserver: HarnessTurnObserver;
  effort?: string;
  onSessionId: (id: string) => Promise<void>;
  /** MCP servers to hand an ACP session, beside the swarm's. */
  mcpServers?: readonly Record<string, unknown>[];
  runCli: () => Promise<NativeTurnResult>;
}): Promise<NativeTurnResult> {
  const { harness, account, session, transport, turnText, model, environment, images, signal, run, checkpoint, sharedObserver, effort, onSessionId, runCli } = input;
  const prompter = run.prompter;
  let result: NativeTurnResult;
  // ACP and the app-server own session identity: never hand them an id
  // ClikCode minted for a CLI attempt that the vendor never confirmed.
  if (session.nativeSessionPreallocated) {
    session.nativeSessionId = undefined;
    delete session.nativeSessionPreallocated;
  }
  // Codex steers at once; ACP may hold a message until no tool call is open
  // (acp-client.ts). Recorded under the id the composer shows it by, so the
  // durable steer matches its row by identity.
  const onSteerReady: HarnessTurnObserver['onSteerReady'] = (handler) => run.liveInput?.setSteerHandler(handler ? async (steerText, submission, hold) => {
    let held = false;
    await handler(steerText, (withdraw) => { held = true; return hold(withdraw); });
    // A held message was queued as the fallback: take that copy out in the
    // same write that records the steer, so no snapshot shows it twice.
    if (held) checkpoint.unqueueSoon(submission);
    await checkpoint.steer(submission);
  } : undefined);
  const persistent = run.persistentTransports
    ? persistentTransportFor(session.id, transport, vendorChildKey(harness, account, environment, session.workspace))
    : undefined;
  try {
    if (transport === 'codex-app-server') {
      const launch = codexLaunchInput({ harness, session, model, effort, environment });
      // The user's own option going unapplied is theirs to know -- once per
      // chat and set of options, not as a note on every turn.
      const ignored = launch.unmapped.join(', ');
      if (ignored && ignoredOptionsSaid.get(session.id) !== ignored) {
        ignoredOptionsSaid.set(session.id, ignored);
        prompter?.activity(chalk.dim(`${harness.displayName} app-server ignores: ${ignored}`));
      }
      const codexInput: CodexAppServerTurnInput = {
        ...launch.input, prompt: turnText, images, signal, onSessionId,
        ...sharedObserver,
        onSteerReady,
      };
      result = persistent ? await (persistent.session as CodexSession).runTurn(codexInput) : await runCodexAppServerTurn(codexInput);
    } else {
      const acpInput: AcpTurnInput = {
        ...acpLaunchInput({ harness, account, session, model, effort, environment, mcpServers: input.mcpServers, checkpoint, prompter }),
        prompt: turnText, signal, images, onSessionId,
        ...sharedObserver,
        onSteerReady,
      };
      // An agent that keeps its usage only in its session file (Cline): the
      // turn's share is what the file's total grew by.
      const usageFile = harness.acp?.usageFile;
      const usageBefore = usageFile && session.nativeSessionId
        ? await readAcpUsageFile(usageFile, session.nativeSessionId, environment) ?? {}
        : {};
      try {
        try {
          result = persistent ? await (persistent.session as AcpSession).runTurn(acpInput) : await runAcpTurn(acpInput);
        } finally {
          // A message held for the next pause has been steered in or released
          // to the queue by now; let what follows either land before the
          // journal is completed, so it is one or the other, never both.
          await run.liveInput?.settled();
        }
        const usageAfter = usageFile && result.nativeSessionId ? await readAcpUsageFile(usageFile, result.nativeSessionId, environment) : undefined;
        if (usageAfter) sharedObserver.onUsage?.(turnShareOf(usageAfter, usageBefore));
      } catch (error) {
        const unsupported = error as Error & { acpUnsupportedImages?: boolean; acpUnsupportedModel?: boolean; acpUnsupportedEffort?: boolean };
        if (!(unsupported.acpUnsupportedImages || unsupported.acpUnsupportedModel || unsupported.acpUnsupportedEffort) || !harness.turn) throw error;
        // A model the plan's own list leaves out is the plan's refusal; the
        // CLI would only be refused it too (Kiro). It is this account's, so
        // failover moves the turn to one whose plan has it (Grok 4.7 is not
        // on Grok's free plan) instead of ending it.
        if (unsupported.acpUnsupportedModel && harness.freePlan?.listed) throw Object.assign(unsupported, { errorKind: 'model_not_on_plan' });
        // An ACP session id is not guaranteed to identify the same vendor
        // thread in the one-shot CLI. Only a new chat can safely switch
        // transports for this turn -- unless the two share one store.
        const shared = Boolean(harness.acp?.sharedSessions);
        if (session.nativeSessionId && !shared) throw error;
        // Plan mode is a mode of the ACP session: the CLI would run the turn
        // with every tool, which is what the user turned plan mode on against.
        if (session.planMode && harness.acp?.planModeId) throw error;
        // A thread the CLI starts belongs to the CLI from now on -- unless
        // both share one store, when this turn alone takes the CLI.
        const pinned = cliThreadTransport(harness);
        if (pinned) {
          session.nativeTransport = pinned;
          await checkpoint.persistNow();
        }
        lifecycle('vendor.acp-fallback', { harness: harness.command, reason: unsupported.message.slice(0, 300) });
        prompter?.phase('using structured CLI fallback');
        try { result = await runCli(); }
        catch (cliError) {
          if (!session.nativeSessionId && !shared) delete session.nativeTransport;
          throw cliError;
        }
      }
    }
  } catch (error) {
    // The parent request can fail while an Agent call or shell it started is
    // still running. Keep that child alive so the work and its transcript can
    // finish before the turn retries or moves to another account. A cancel
    // already has its own settle path in PersistentSession.
    if (persistent && !isTurnCancelled(error) && !await persistent.session.backgroundWorkRunning()) await closePersistentTransport(session.id);
    throw error;
  }
  return result;
}

/** Everything an ACP turn is launched and opened with -- what decides
 * whether a live child can be reused (binary, argv, cwd, environment) and
 * what the session is set to. One builder for a turn and for a failover's
 * standby (prepareAcpStandby), so the standby is the child the turn wants. */
function acpLaunchInput(input: {
  harness: AiLocalHarnessDefinition; account: AiHarnessAccount; session: HarnessSession; model: string | null; effort?: string;
  environment: Record<string, string>; mcpServers?: readonly Record<string, unknown>[];
  checkpoint?: DurableTurnCheckpoint; prompter?: TurnRunOptions['prompter'];
}): Omit<AcpTurnInput, 'prompt'> {
  const { harness, account, session, model, effort, environment, checkpoint, prompter } = input;
  const declaredOptions = localHarnessCapabilityManifest(harness).options;
  const launch = harnessAcpLaunch(harness, { model, effort, permissionMode: session.permissionMode ?? 'ask' });
  if (!launch) throw new Error(`${harness.displayName} does not declare an ACP launch`);
  // A harness whose plan mode is an ACP session mode (acp.planModeId) no longer takes it as a launch
  // option: a chat that stored the old option (Droid `spec-mode`, Cline/Command Code `plan`) keeps its
  // plan mode through the session mode instead of failing on a CLI flag its ACP command refuses.
  const planOption = harness.acp?.planModeId ? harness.planMode : undefined;
  const storedPlan = planOption ? session.harnessOptions?.[planOption.option] : undefined;
  const planStored = storedPlan !== undefined && storedPlan !== false && storedPlan !== '' && (planOption!.value === true || storedPlan === planOption!.value);
  const launchOptions = planOption && session.harnessOptions
    ? Object.fromEntries(Object.entries(session.harnessOptions).filter(([id]) => id !== planOption.option))
    : session.harnessOptions;
  // An agent that takes no CLI options (inheritCliOptions: false) gets the /add-dir directories over
  // the protocol (`additionalDirectories` of session/new|load|resume) instead of as argv.
  const protocolDirectories = harness.acp?.inheritCliOptions === false ? optionIdsForControl('/add-dir') : [];
  const additionalDirectories = protocolDirectories.flatMap((id) => {
    const value = launchOptions?.[id];
    return (Array.isArray(value) ? value : typeof value === 'string' && value ? [value] : []).map(String);
  });
  const argvOptions = additionalDirectories.length && launchOptions
    ? Object.fromEntries(Object.entries(launchOptions).filter(([id]) => !protocolDirectories.includes(id)))
    : launchOptions;
  const optionArgv = declaredOptionArgv(declaredOptions, argvOptions, Boolean(session.nativeSessionId));
  if (harness.acp?.inheritCliOptions === false && optionArgv.length) {
    throw new Error(`${harness.displayName} ACP does not accept the selected CLI-only options. Clear them before sending.`);
  }
  const mcpServers = [...input.mcpServers ?? [], ...(swarmIsOn(session) ? swarmAcpMcpServers(session.id) : [])];
  return {
    binary: launch.binary, command: harness.command,
    argv: launch.modeArgv, optionPlacement: launch.optionPlacement,
    extraArgv: [...launch.optionArgv, ...optionArgv],
    ...(session.nativeSessionId ? { nativeSessionId: session.nativeSessionId } : {}),
    cwd: session.workspace!, model, effort, permissionMode: session.permissionMode ?? 'ask',
    currentPermissionMode: () => storedPermissionMode(session.id),
    ...(additionalDirectories.length ? { additionalDirectories } : {}),
    acp: harness.acp,
    // Plan mode as an ACP session mode (catalog acp.planModeId); the
    // agent leaving it -- its plan approved -- turns the chat's off.
    ...((session.planMode || planStored) && harness.acp?.planModeId ? {
      planMode: true,
      onPlanModeExit: () => setPlanMode(session, checkpoint, prompter, false, () => {
        if (planOption && session.harnessOptions) delete session.harnessOptions[planOption.option];
      }),
    } : {}),
    modelProviderSeparator: harness.modelProviderSeparator,
    plansListModels: Boolean(harness.freePlan?.listed),
    // Claude Code's quota, carried by the turn itself: published like a
    // stream reading, so the composer and the account picker see it.
    onQuotaReading: (reading) => { void recordDerivedUsage(session, reading).catch(() => undefined); },
    // The models this session offers are the catalog model discovery
    // would otherwise start a second copy of the agent to read.
    onSessionModels: (answer, fresh) => { void recordLiveModelCatalog(harness, account, answer, fresh).catch(() => undefined); },
    environment: launch.env && Object.keys(launch.env).length ? { ...environment, ...launch.env } : environment,
    ...(mcpServers.length ? { mcpServers } : {}),
  };
}

/** A standby child for `account`, opened by `prepare`: true once it is ready. */
function standbyOf(
  input: { harness: AiLocalHarnessDefinition; account: AiHarnessAccount; session: HarnessSession; environment: Record<string, string> },
  kind: Parameters<typeof openStandby>[2], prepare: Parameters<typeof openStandby>[4],
): Promise<boolean> {
  return openStandby(input.session.id, input.account.id, kind, vendorChildKey(input.harness, input.account, input.environment, input.session.workspace), prepare).ready;
}

/** Open `account`'s ACP session for this conversation up to the prompt, on a
 * standby child, while the current account's turn runs: a failover to it
 * then starts at the prompt. The thread must already be in its profile. */
export function prepareAcpStandby(input: {
  harness: AiLocalHarnessDefinition; account: AiHarnessAccount; session: HarnessSession; model: string | null; effort?: string;
  environment: Record<string, string>; mcpServers?: readonly Record<string, unknown>[];
}): Promise<boolean> {
  const launch = acpLaunchInput(input);
  return standbyOf(input, 'acp', async (child) => { await (child as AcpSession).runTurn({ ...launch, prompt: '', prepareOnly: true }); });
}

/** What a Codex app-server turn is launched and opened with, for a turn and
 * for a failover's standby alike (see acpLaunchInput). `unmapped`: the
 * chat's own options the app-server has no place for. */
function codexLaunchInput(input: {
  harness: AiLocalHarnessDefinition; session: HarnessSession; model: string | null; effort?: string; environment: Record<string, string>;
}): { input: Omit<CodexAppServerTurnInput, 'prompt'>; unmapped: readonly string[] } {
  const { harness, session, model, effort, environment } = input;
  const overrides = appServerThreadOverrides(localHarnessCapabilityManifest(harness).options, session.harnessOptions);
  const configOverrides = {
    ...(overrides.configOverrides ? overrides.configOverrides : {}),
    ...(swarmIsOn(session) ? swarmCodexConfig(session.id) : {}),
  };
  return {
    unmapped: overrides.unmapped,
    input: {
      binary: harness.binary, nativeSessionId: session.nativeSessionId,
      cwd: session.workspace!, model, effort, permissionMode: session.permissionMode ?? 'ask', environment,
      currentPermissionMode: () => storedPermissionMode(session.id),
      ...(Object.keys(configOverrides).length ? { configOverrides } : {}),
      ...(overrides.extraThreadParams ? { extraThreadParams: overrides.extraThreadParams } : {}),
      // Codex reports its own quota on this connection during the turn,
      // which is the same figure codexUsageProbe otherwise spawns a whole
      // second app-server to ask for.
      onRateLimits: (rateLimits) => {
        // The structured reading (not just its label) so the windows'
        // resetsAt survives into account.usage for the reset-time line.
        void recordDerivedUsage(session, codexRateLimitsReading(rateLimits)).catch(() => undefined);
      },
    },
  };
}

/** The Codex counterpart of prepareAcpStandby: the account's thread resumed
 * on a standby app-server, up to turn/start. */
export function prepareCodexStandby(input: {
  harness: AiLocalHarnessDefinition; account: AiHarnessAccount; session: HarnessSession; model: string | null; effort?: string;
  environment: Record<string, string>;
}): Promise<boolean> {
  const launch = codexLaunchInput(input).input;
  return standbyOf(input, 'codex-app-server', async (child) => { await (child as CodexSession).runTurn({ ...launch, prompt: '', prepareOnly: true }); });
}
