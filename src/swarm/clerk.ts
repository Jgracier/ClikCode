/** One clerk prompt on another provider, without a ClikCode conversation.
 * The vendor may keep a thread of its own. ClikCode keeps the card. */

import type { AiHarnessAccount, AiHarnessPermissionMode, AiLocalHarnessDefinition } from '../harness/definition.js';
import { parseNativeActivityEventsFromValue } from '../harness/protocol/activity-events.js';
import { parseJsonRecord } from '../harness/protocol/json-lines.js';
import { nativeTurnResult } from '../harness/protocol/turn-result.js';
import type { TurnUsage } from '../harness/protocol/turn-usage.js';
import { captureNativeHarnessTurn, createTurnIdleController, createTurnInput } from '../harness/transport/native/turn.js';
import { createBackgroundWait, streamJsonUserMessage } from '../harness/transport/native/background-wait.js';
import { vendorBackgroundEvent } from '../harness/transport/native/background-task.js';
import { harnessAcpLaunch, nativeHarnessTurnArgv } from '../runtime/lazy-bridge.js';
import { runAcpTurn } from '../harness/transport/acp-client.js';
import type { HarnessState } from '../session/model.js';
import { recordClerkTurn } from '../turn/account-outcome.js';
import { writeState } from '../session/state/write.js';
import { classifyAccountFailure } from '../turn/failover.js';
import { turnEnvironment } from '../turn/turn-environment.js';

export async function runProviderPrompt(input: {
  harness: AiLocalHarnessDefinition;
  account: AiHarnessAccount;
  workspace?: string;
  prompt: string;
  /** A model from the account. Absent uses the harness default. */
  model?: string;
  permissionMode?: AiHarnessPermissionMode;
  signal?: AbortSignal;
  onStep?: (label: string) => void;
  /** When set, this turn updates what the account has learned about its usage. */
  state?: HarnessState;
  sessionId?: string;
}): Promise<string> {
  if (!input.harness.turn && !input.harness.acp) throw new Error(`${input.harness.displayName} cannot take a headless turn`);
  const startedAt = Date.now();
  let noted = false;
  const note = async (outcome: { usage?: TurnUsage; error?: unknown }): Promise<void> => {
    if (noted || !input.state || !input.sessionId) return;
    const quota = outcome.error !== undefined && classifyAccountFailure(outcome.error, { isResultError: true }) === 'quota-exhausted';
    // A crash with no usage and no quota refusal teaches nothing.
    if (outcome.error && !quota) return;
    noted = true;
    recordClerkTurn(input.state, input.account, {
      sessionId: input.sessionId, provider: input.harness.provider, startedAt,
      ...(outcome.usage ? { usage: outcome.usage } : {}),
      ...(quota ? { quota: true, failure: outcome.error } : {}),
    });
    await writeState(input.state);
  };
  // Kiro's print stream exposes partial answer chunks as separate `text`
  // records. Its ACP reply is the assembled final message.
  if (!input.harness.turn || (input.harness.command === 'kiro' && input.harness.acp)) return runAcpClerk(input, note);
  const asked = input.permissionMode;
  const mode = asked && input.harness.permissionModes?.includes(asked)
    && (input.harness.permissionArgv?.[asked] || input.harness.permissionEnv?.[asked])
    ? asked : undefined;
  const argv = nativeHarnessTurnArgv(input.harness, {
    prompt: input.prompt,
    ...(input.workspace ? { workspace: input.workspace } : {}),
    ...(mode ? { permissionMode: mode } : {}),
    ...(input.model ? { model: input.model } : {}),
  });
  const environment = turnEnvironment(input.harness, input.account, mode);
  // A clerk's background tasks are its work too: its input stays open until
  // they finish (Claude stops them when its input ends), and each one gives
  // the idle watchdog its tool budget, as a chat's own turn does
  // (vendor-cli-attempt.ts). Nothing here can show a later follow-up, so the
  // clerk's answer waits for them.
  const idle = createTurnIdleController();
  const held = input.harness.turn.promptInput === 'stdin' && input.harness.turn.stdinFormat === 'stream-json' ? createTurnInput() : undefined;
  const background = held ? createBackgroundWait({
    onSettled: () => held.end(),
    onTaskStarted: (id) => idle.toolStarted(`background:${id}`),
    onTaskFinished: (id) => idle.toolFinished(`background:${id}`),
  }) : undefined;
  const inProcess = new Set<string>();
  let output;
  try {
    output = await captureNativeHarnessTurn(input.harness, argv, environment, {
      ...(input.workspace ? { cwd: input.workspace } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      idleController: idle,
      ...(held ? { input: held } : {}),
      ...(input.harness.turn.promptInput === 'stdin' ? { stdinText: input.harness.turn.stdinFormat === 'stream-json' ? streamJsonUserMessage(input.prompt) : input.prompt } : {}),
      onStdoutLine: (line) => {
        const record = parseJsonRecord(line);
        if (record) idle.noteActivity();
        // Answered: if only background work is left when the budget runs
        // out, the clerk's turn ends as answered, not as a hang.
        if (record?.type === 'result') idle.noteResult(record.is_error === true ? 'error' : 'success');
        if (record && background) background.note(record);
        else if (record) {
          // A vendor that waits for its own background work in-process
          // (Cursor) is silent meanwhile: that silence gets the tool budget.
          const event = vendorBackgroundEvent(record);
          if (event?.kind === 'started' && !inProcess.has(event.id)) { inProcess.add(event.id); idle.toolStarted(`background:${event.id}`); }
          else if (event?.kind === 'finished' && inProcess.delete(event.id)) idle.toolFinished(`background:${event.id}`);
        }
        if (!record || !input.onStep) return;
        const [event] = parseNativeActivityEventsFromValue(input.harness, record);
        if (event?.kind === 'tool-start' && event.label) input.onStep(event.label);
      },
    });
  } catch (error) {
    await note({ error });
    throw error;
  } finally {
    background?.dispose();
  }
  let result;
  try {
    result = nativeTurnResult(input.harness, output.stdout, { exitCode: output.exitCode, stderr: output.stderr });
  } catch (error) {
    await note({ error });
    throw error;
  }
  if (result.isError) {
    const error = Object.assign(new Error(result.text || `${input.harness.displayName} failed`), {
      ...(result.statusCode !== undefined ? { statusCode: result.statusCode } : {}),
      ...(result.errorKind ? { errorKind: result.errorKind } : {}),
      ...(result.rateLimitStatus ? { rateLimitStatus: result.rateLimitStatus } : {}),
      ...(output.stderr?.trim() ? { stderrTail: output.stderr.trim().slice(-4000) } : {}),
    });
    await note({ ...(result.usage ? { usage: result.usage } : {}), error });
    throw error;
  }
  await note({ ...(result.usage ? { usage: result.usage } : {}) });
  return result.text.trim();
}

/** A harness with no headless CLI still takes one prompt over ACP. The
 * session it opens stays the vendor's; ClikCode keeps the card. */
async function runAcpClerk(
  input: Parameters<typeof runProviderPrompt>[0],
  note: (outcome: { usage?: TurnUsage; error?: unknown }) => Promise<void>,
): Promise<string> {
  const permissionMode = input.permissionMode && input.harness.permissionModes?.includes(input.permissionMode)
    ? input.permissionMode : 'ask';
  const launch = harnessAcpLaunch(input.harness, { permissionMode, ...(input.model ? { model: input.model } : {}) });
  if (!launch) throw new Error(`${input.harness.displayName} cannot take a headless turn`);
  const environment = turnEnvironment(input.harness, input.account, permissionMode);
  let usage: TurnUsage | undefined;
  try {
    const result = await runAcpTurn({
      binary: launch.binary,
      command: input.harness.command,
      prompt: input.prompt,
      argv: launch.modeArgv,
      optionPlacement: launch.optionPlacement,
      extraArgv: [...launch.optionArgv],
      cwd: input.workspace ?? process.cwd(),
      permissionMode,
      environment,
      acp: input.harness.acp,
      ...(input.signal ? { signal: input.signal } : {}),
      onUsage: (next) => { usage = next; },
      onActivity: (event) => {
        if (event.kind === 'tool-start' && event.label) input.onStep?.(event.label);
      },
    });
    await note({ ...(usage ? { usage } : {}) });
    return result.text.trim();
  } catch (error) {
    await note({ ...(usage ? { usage } : {}), error });
    throw error;
  }
}
