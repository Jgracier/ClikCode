/** One clerk prompt on another provider, without a ClikCode conversation.
 * The vendor may keep a thread of its own. ClikCode keeps the card. */

import type { AiHarnessAccount, AiHarnessPermissionMode, AiLocalHarnessDefinition } from '../harness/definition.js';
import { parseNativeActivityEventsFromValue } from '../harness/protocol/activity-events.js';
import { parseJsonRecord } from '../harness/protocol/json-lines.js';
import { nativeTurnResult } from '../harness/protocol/turn-result.js';
import { captureNativeHarnessTurn } from '../harness/transport/native/turn.js';
import { nativeHarnessTurnArgv } from '../runtime/lazy-bridge.js';
import { turnEnvironment } from '../turn/turn-environment.js';

export async function runProviderPrompt(input: {
  harness: AiLocalHarnessDefinition;
  account: AiHarnessAccount;
  workspace?: string;
  prompt: string;
  permissionMode?: AiHarnessPermissionMode;
  signal?: AbortSignal;
  onStep?: (label: string) => void;
}): Promise<string> {
  if (!input.harness.turn) throw new Error(`${input.harness.displayName} cannot take a headless turn`);
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
  const output = await captureNativeHarnessTurn(input.harness, argv, environment, {
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
  const result = nativeTurnResult(input.harness, output.stdout, { exitCode: output.exitCode, stderr: output.stderr });
  if (result.isError) throw new Error(result.text || `${input.harness.displayName} failed`);
  return result.text.trim();
}
