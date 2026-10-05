/** The one way a provider takes up a conversation it has no live thread for.
 *
 * Every route there -- a provider switch, switching back to one used before,
 * a fork, "Resume in", an account failover whose thread could not be carried,
 * a thread the vendor no longer knows -- ends here, and one rule decides:
 *
 *   (a) the target harness has a native-thread writer (NativeSessionStore
 *       `writer`) that accepts the installed vendor build: the whole canonical
 *       record is written as the vendor's own thread, in the taking-over
 *       account's profile, and the turn resumes it by id. The vendor then
 *       holds the conversation exactly as if it had been there all along.
 *   (b) otherwise: the transfer prompt (turn/transfer.ts), sized to the model
 *       that receives it.
 *
 * A writer that declines, fails or throws is (b) for that turn: the transfer
 * always works, so nothing here can fail the turn. So is a model route that
 * keeps no history (keepsNoHistory): a written thread would be resumed into
 * a provider that never sees it. */

import type { AiLocalHarnessDefinition } from '../harness/definition.js';
import { markProviderBoundaries, type CanonicalRecord } from '../session/canonical.js';
import type { NativeSessionEnvironment, NativeThreadWriter, NativeThreadWritten } from '../session/discovery/stores.js';
import { modelProvider } from '../runtime/lazy-bridge.js';
import { transferBudget, transferPrompt } from './transfer.js';

/** The model runs behind a provider that keeps no history between one-shot
 * turns (catalog `turn.statelessProviders`: Goose's `claude-code`). Its
 * thread is forgotten after every turn, and no thread is written for it:
 * only the transfer reaches the model. */
export function keepsNoHistory(harness: AiLocalHarnessDefinition, model: string | null): boolean {
  const stateless = harness.turn?.statelessProviders;
  return Boolean(model && stateless?.length && stateless.includes(modelProvider(harness, model) ?? ''));
}

export type ThreadStart =
  /** Resume `written.nativeId`; send `prompt` (the request itself). */
  | { kind: 'native'; written: NativeThreadWritten; prompt: string }
  /** A fresh thread; send `prompt` (the transfer, ending in the request). */
  | { kind: 'transfer'; prompt: string; budget: number };

export interface ThreadStartInput {
  record: CanonicalRecord;
  /** What to answer now: the user's request as the turn would send it, or
   * INTERRUPTED_TURN_REQUEST (+ what the interrupted request carried). */
  request: string;
  /** The record's newest turn was cut off and `request` continues it. */
  interrupted: boolean;
  harness: AiLocalHarnessDefinition;
  workspace: string;
  /** The taking-over account's environment for this harness. */
  environment: NativeSessionEnvironment;
  model: string | null;
  /** The receiving model's context window in tokens, where known. */
  contextWindow?: number;
  /** Bytes a prompt may take when it travels in argv; absent when the turn's
   * transport passes it another way (stdin, ACP, app-server). */
  argvLimit?: number;
  /** The writer for this harness, if any (registry: nativeSessionStore). */
  writer?: NativeThreadWriter;
  /** The installed vendor build (first line of `--version`). */
  version?: () => Promise<string | undefined>;
  displayName?: (harness: string) => string | undefined;
  /** Told why a writer was not used, for the lifecycle log. */
  onFallback?: (reason: string) => void;
}

async function written(input: ThreadStartInput): Promise<NativeThreadWritten | undefined> {
  const writer = input.writer;
  if (!writer || !input.record.turns.length) return undefined;
  if (keepsNoHistory(input.harness, input.model)) {
    input.onFallback?.(`${input.model} keeps no history: a written ${input.harness.command} thread would not reach it`);
    return undefined;
  }
  try {
    const context = {
      harness: input.harness, workspace: input.workspace, environment: input.environment, model: input.model,
      version: await input.version?.().catch(() => undefined),
    };
    if (!await writer.versionOk(context)) {
      input.onFallback?.(`${input.harness.command} ${context.version ?? '(version unknown)'} is not a build its thread writer was verified against (${writer.testedVersions.join(', ') || 'none'})`);
      return undefined;
    }
    // Which provider ran which turns, said once per switch (the transfer
    // says it in its own preamble).
    const result = await writer.write(markProviderBoundaries(input.record, input.harness.command, input.displayName), context);
    if (!result?.nativeId) input.onFallback?.(`${input.harness.command} thread writer declined`);
    return result?.nativeId ? result : undefined;
  } catch (error) {
    // fail-open-ok: a transfer always works; a writer is an improvement on it.
    input.onFallback?.(`${input.harness.command} thread writer failed: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

export async function startConversationThread(input: ThreadStartInput): Promise<ThreadStart> {
  const native = await written(input);
  if (native) return { kind: 'native', written: native, prompt: input.request };
  const budget = transferBudget({
    ...(input.contextWindow ? { contextWindow: input.contextWindow } : {}),
    ...(input.argvLimit ? { argvLimit: input.argvLimit } : {}),
  });
  return {
    kind: 'transfer', budget,
    prompt: transferPrompt(input.record, input.request, {
      maxBytes: budget, interrupted: input.interrupted, ...(input.displayName ? { displayName: input.displayName } : {}),
    }),
  };
}
