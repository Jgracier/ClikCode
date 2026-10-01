/** One ACP or app-server attempt, with a CLI fallback where the vendor permits it. */
import chalk from 'chalk';
import type { AiHarnessAccount, AiLocalHarnessDefinition } from '../harness/definition.js';
import type { HarnessSession } from '../session/model.js';
import type { HarnessTurnObserver } from '../harness/events/turn-observer.js';
import type { HarnessTurnTransport } from '../harness/transport/select.js';
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
import { closePersistentTransport, persistentTransportFor, vendorChildKey } from './vendor-process.js';

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
  const persistent = run.persistentTransports
    ? persistentTransportFor(session.id, transport, vendorChildKey(harness, account, environment, session.workspace))
    : undefined;
  try {
    if (transport === 'codex-app-server') {
      const overrides = appServerThreadOverrides(declaredOptions, session.harnessOptions);
      if (overrides.unmapped.length) prompter?.activity(chalk.dim(`${harness.displayName} app-server ignores: ${overrides.unmapped.join(', ')}`));
      const codexInput: CodexAppServerTurnInput = {
        binary: harness.binary, prompt: turnText, nativeSessionId: session.nativeSessionId,
        cwd: session.workspace!, model, effort, permissionMode: session.permissionMode ?? 'ask',
        images, environment, signal, onSessionId,
        ...(overrides.configOverrides ? { configOverrides: overrides.configOverrides } : {}),
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
        // Steering is genuinely codex-only: it is the one transport
        // that accepts input mid-turn.
        onSteerReady: (handler) => run.liveInput?.setSteerHandler(handler ? async (steerText, submission) => {
          await handler(steerText);
          // Recorded under the id the composer shows it by, so the
          // durable steer matches its row by identity.
          await checkpoint.steer(submission);
        } : undefined),
      };
      result = persistent ? await (persistent.session as CodexSession).runTurn(codexInput) : await runCodexAppServerTurn(codexInput);
    } else {
      const launch = harnessAcpLaunch(harness, { model, effort, permissionMode: session.permissionMode ?? 'ask' });
      if (!launch) throw new Error(`${harness.displayName} does not declare an ACP launch`);
      const optionArgv = declaredOptionArgv(declaredOptions, session.harnessOptions, Boolean(session.nativeSessionId));
      if (harness.acp?.inheritCliOptions === false && optionArgv.length) {
        throw new Error(`${harness.displayName} ACP does not accept the selected CLI-only options. Clear them before sending.`);
      }
      const acpInput: AcpTurnInput = {
        binary: launch.binary, command: harness.command, prompt: turnText,
        argv: launch.modeArgv, optionPlacement: launch.optionPlacement,
        extraArgv: [...launch.optionArgv, ...optionArgv],
        ...(session.nativeSessionId ? { nativeSessionId: session.nativeSessionId } : {}),
        cwd: session.workspace!, model, effort, permissionMode: session.permissionMode ?? 'ask',
        acp: harness.acp,
        modelProviderSeparator: harness.modelProviderSeparator,
        allowAgentAuth: Boolean(prompter),
        // Claude Code's quota, carried by the turn itself: published like a
        // stream reading, so the composer and the account picker see it.
        onQuotaReading: (reading) => { void recordDerivedUsage(session, reading).catch(() => undefined); },
        environment, signal, images, onSessionId,
        ...sharedObserver,
      };
      // An agent that keeps its usage only in its session file (Cline): the
      // turn's share is what the file's total grew by.
      const usageFile = harness.acp?.usageFile;
      const usageBefore = usageFile && session.nativeSessionId
        ? await readAcpUsageFile(usageFile, session.nativeSessionId, environment) ?? {}
        : {};
      try {
        result = persistent ? await (persistent.session as AcpSession).runTurn(acpInput) : await runAcpTurn(acpInput);
        const usageAfter = usageFile && result.nativeSessionId ? await readAcpUsageFile(usageFile, result.nativeSessionId, environment) : undefined;
        if (usageAfter) sharedObserver.onUsage?.(turnShareOf(usageAfter, usageBefore));
      } catch (error) {
        const unsupported = error as Error & { acpUnsupportedImages?: boolean; acpUnsupportedModel?: boolean; acpUnsupportedEffort?: boolean };
        if (!(unsupported.acpUnsupportedImages || unsupported.acpUnsupportedModel || unsupported.acpUnsupportedEffort) || !harness.turn) throw error;
        // An ACP session id is not guaranteed to identify the same vendor
        // thread in the one-shot CLI. Only a new chat can safely switch
        // transports for this turn.
        if (session.nativeSessionId) throw error;
        session.nativeTransport = harness.turn.output === 'text' ? 'text-cli' : 'structured-cli';
        await checkpoint.persistNow();
        prompter?.phase('using structured CLI fallback');
        try { result = await runCli(); }
        catch (cliError) {
          if (!session.nativeSessionId) delete session.nativeTransport;
          throw cliError;
        }
      }
    }
  } catch (error) {
    // After a failed turn the child's protocol state is unknown.
    if (persistent) await closePersistentTransport(session.id);
    throw error;
  }
  return result;
}
