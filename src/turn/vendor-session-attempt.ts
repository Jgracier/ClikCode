/** One ACP or app-server attempt, with a CLI fallback where the vendor permits it. */
import chalk from 'chalk';
import type { AiHarnessAccount, AiLocalHarnessDefinition } from '../harness/definition.js';
import type { HarnessSession } from '../session/model.js';
import type { HarnessTurnObserver } from '../harness/events/turn-observer.js';
import { cliThreadTransport, type HarnessTurnTransport } from '../harness/transport/select.js';
import type { NativeTurnResult } from '../harness/protocol/turn-result.js';
import type { DurableTurnCheckpoint } from './turn-journal.js';
import type { TurnRunOptions } from './session-turn.js';
import { runCodexAppServerTurn, type CodexAppServerTurnInput, type CodexSession } from '../harness/transport/codex-app-server.js';
import { runAcpTurn, type AcpSession, type AcpTurnInput } from '../harness/transport/acp-client.js';
import { appServerThreadOverrides, declaredOptionArgv } from '../harness/transport/options.js';
import { recordDerivedUsage } from '../harness/accounts/stream-usage.js';
import { readAcpUsageFile } from '../harness/transport/acp-usage-file.js';
import { turnShareOf } from '../harness/protocol/turn-usage.js';
import { codexRateLimitsReading } from '../harness/accounts/usage-probes.js';
import { harnessAcpLaunch, localHarnessCapabilityManifest } from '../runtime/lazy-bridge.js';
import { swarmIsOn } from '../swarm/policy.js';
import { swarmAcpMcpServers, swarmCodexConfig } from '../swarm/publish.js';
import { closePersistentTransport, persistentTransportFor, vendorChildKey } from './vendor-process.js';
import { isTurnCancelled } from '../agent/cancellation.js';
import { recordLiveModelCatalog } from '../harness/accounts/model-catalog.js';

/** Per chat, the unapplied options last said (see the app-server branch). */
const ignoredOptionsSaid = new Map<string, string>();

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
  const declaredOptions = localHarnessCapabilityManifest(harness).options;
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
      const overrides = appServerThreadOverrides(declaredOptions, session.harnessOptions);
      // The user's own option going unapplied is theirs to know -- once per
      // chat and set of options, not as a note on every turn.
      const ignored = overrides.unmapped.join(', ');
      if (ignored && ignoredOptionsSaid.get(session.id) !== ignored) {
        ignoredOptionsSaid.set(session.id, ignored);
        prompter?.activity(chalk.dim(`${harness.displayName} app-server ignores: ${ignored}`));
      }
      const swarmConfig = swarmIsOn(session) ? swarmCodexConfig(session.id) : {};
      const configOverrides = {
        ...(overrides.configOverrides ? overrides.configOverrides : {}),
        ...swarmConfig,
      };
      const codexInput: CodexAppServerTurnInput = {
        binary: harness.binary, prompt: turnText, nativeSessionId: session.nativeSessionId,
        cwd: session.workspace!, model, effort, permissionMode: session.permissionMode ?? 'ask',
        images, environment, signal, onSessionId,
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
        ...sharedObserver,
        onSteerReady,
      };
      result = persistent ? await (persistent.session as CodexSession).runTurn(codexInput) : await runCodexAppServerTurn(codexInput);
    } else {
      const launch = harnessAcpLaunch(harness, { model, effort, permissionMode: session.permissionMode ?? 'ask' });
      if (!launch) throw new Error(`${harness.displayName} does not declare an ACP launch`);
      const optionArgv = declaredOptionArgv(declaredOptions, session.harnessOptions, Boolean(session.nativeSessionId));
      if (harness.acp?.inheritCliOptions === false && optionArgv.length) {
        throw new Error(`${harness.displayName} ACP does not accept the selected CLI-only options. Clear them before sending.`);
      }
      const mcpServers = [...input.mcpServers ?? [], ...(swarmIsOn(session) ? swarmAcpMcpServers(session.id) : [])];
      const acpInput: AcpTurnInput = {
        binary: launch.binary, command: harness.command, prompt: turnText,
        argv: launch.modeArgv, optionPlacement: launch.optionPlacement,
        extraArgv: [...launch.optionArgv, ...optionArgv],
        ...(session.nativeSessionId ? { nativeSessionId: session.nativeSessionId } : {}),
        cwd: session.workspace!, model, effort, permissionMode: session.permissionMode ?? 'ask',
        acp: harness.acp,
        modelProviderSeparator: harness.modelProviderSeparator,
        plansListModels: Boolean(harness.freePlan?.listed),
        // Claude Code's quota, carried by the turn itself: published like a
        // stream reading, so the composer and the account picker see it.
        onQuotaReading: (reading) => { void recordDerivedUsage(session, reading).catch(() => undefined); },
        // The models this session offers are the catalog model discovery
        // would otherwise start a second copy of the agent to read.
        onSessionModels: (answer, fresh) => { void recordLiveModelCatalog(harness, account, answer, fresh).catch(() => undefined); },
        environment, signal, images, onSessionId,
        ...(mcpServers.length ? { mcpServers } : {}),
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
        // CLI would only be refused it too (Kiro).
        if (unsupported.acpUnsupportedModel && harness.freePlan?.listed) throw error;
        // An ACP session id is not guaranteed to identify the same vendor
        // thread in the one-shot CLI. Only a new chat can safely switch
        // transports for this turn -- unless the two share one store.
        const shared = Boolean(harness.acp?.sharedSessions);
        if (session.nativeSessionId && !shared) throw error;
        // A thread the CLI starts belongs to the CLI from now on -- unless
        // both share one store, when this turn alone takes the CLI.
        const pinned = cliThreadTransport(harness);
        if (pinned) {
          session.nativeTransport = pinned;
          await checkpoint.persistNow();
        }
        prompter?.phase('using structured CLI fallback');
        try { result = await runCli(); }
        catch (cliError) {
          if (!session.nativeSessionId && !shared) delete session.nativeTransport;
          throw cliError;
        }
      }
    }
  } catch (error) {
    // After a failed turn the child's protocol state is unknown. A cancel is
    // not a failure: the transport asked the vendor to stop and either saw it
    // settle (the child stays, resumable) or killed the child itself
    // (persistent-session.ts settleCancel). Closing here as well respawned the
    // vendor and every MCP server it starts on each Esc / stop & send.
    if (persistent && !isTurnCancelled(error)) await closePersistentTransport(session.id);
    throw error;
  }
  return result;
}
