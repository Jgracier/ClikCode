/** One clerk prompt on another provider, without a ClikCode conversation.
 * The vendor may keep a thread of its own. ClikCode keeps the card. */

import type { AiHarnessAccount, AiHarnessPermissionMode, AiLocalHarnessDefinition } from '../harness/definition.js';
import { parseNativeActivityEventsFromValue } from '../harness/protocol/activity-events.js';
import { parseJsonRecord } from '../harness/protocol/json-lines.js';
import { nativeTurnResult } from '../harness/protocol/turn-result.js';
import type { TurnUsage } from '../harness/protocol/turn-usage.js';
import { captureNativeHarnessTurn } from '../harness/transport/native/turn.js';
import { nativeHarnessTurnArgv } from '../runtime/lazy-bridge.js';
import type { HarnessState } from '../session/model.js';
import { recordClerkTurn } from '../turn/account-outcome.js';
import { classifyAccountFailure } from '../turn/failover.js';
import { turnEnvironment } from '../turn/turn-environment.js';

export async function runProviderPrompt(input: {
  harness: AiLocalHarnessDefinition;
  account: AiHarnessAccount;
  workspace?: string;
  prompt: string;
  permissionMode?: AiHarnessPermissionMode;
  signal?: AbortSignal;
  onStep?: (label: string) => void;
  /** When set, this turn updates what the account has learned about its usage. */
  state?: HarnessState;
  sessionId?: string;
}): Promise<string> {
  if (!input.harness.turn) throw new Error(`${input.harness.displayName} cannot take a headless turn`);
  const startedAt = Date.now();
  let noted = false;
  const note = (outcome: { usage?: TurnUsage; error?: unknown }): void => {
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
  };
  const asked = input.permissionMode;
  const mode = asked && input.harness.permissionModes?.includes(asked)
    && (input.harness.permissionArgv?.[asked] || input.harness.permissionEnv?.[asked])
    ? asked : undefined;
  const argv = nativeHarnessTurnArgv(input.harness, {
    prompt: input.prompt,
    ...(input.workspace ? { workspace: input.workspace } : {}),
    ...(mode ? { permissionMode: mode } : {}),
  });
  const environment = turnEnvironment(input.harness, input.account, mode);
  let output;
  try {
    output = await captureNativeHarnessTurn(input.harness, argv, environment, {
      ...(input.workspace ? { cwd: input.workspace } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.harness.turn.promptInput === 'stdin' ? { stdinText: input.prompt } : {}),
      onStdoutLine: (line) => {
        const record = parseJsonRecord(line);
        if (!record || !input.onStep) return;
        const [event] = parseNativeActivityEventsFromValue(input.harness, record);
        if (event?.kind === 'tool-start' && event.label) input.onStep(event.label);
      },
    });
  } catch (error) {
    note({ error });
    throw error;
  }
  let result;
  try {
    result = nativeTurnResult(input.harness, output.stdout, { exitCode: output.exitCode, stderr: output.stderr });
  } catch (error) {
    note({ error });
    throw error;
  }
  if (result.isError) {
    const error = Object.assign(new Error(result.text || `${input.harness.displayName} failed`), {
      ...(result.statusCode !== undefined ? { statusCode: result.statusCode } : {}),
      ...(result.errorKind ? { errorKind: result.errorKind } : {}),
      ...(result.rateLimitStatus ? { rateLimitStatus: result.rateLimitStatus } : {}),
      ...(output.stderr?.trim() ? { stderrTail: output.stderr.trim().slice(-4000) } : {}),
    });
    note({ ...(result.usage ? { usage: result.usage } : {}), error });
    throw error;
  }
  note({ ...(result.usage ? { usage: result.usage } : {}) });
  return result.text.trim();
}
