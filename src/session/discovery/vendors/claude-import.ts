/** Native threads for vendors that IMPORT a Claude Code transcript.
 *
 * Goose (`goose session import <file>`) and Hermes (`hermes sessions import
 * --from claude <file>`) each read a Claude Code session `.jsonl` into their
 * own store and assign it an id of their own. So the writer is the one Claude
 * serializer (claude-thread.ts) to a private temporary file, the vendor's
 * import run with exactly the taking-over account's environment, the new id
 * read back from what the import printed, and the temporary file removed --
 * whatever happened. */

import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureNativeHarnessOutput } from '../../../harness/transport/native/command.js';
import type { CanonicalRecord } from '../../canonical.js';
import type { NativeThreadWriteContext, NativeThreadWriter, NativeThreadWritten } from '../stores.js';
import { claudeThreadJsonl } from './claude-thread.js';
import { testedVersion } from './thread-writer-files.js';

/** The Claude Code build the imported records claim to come from: the one
 * whose layout both importers were verified on. */
export const CLAUDE_THREAD_VERSION = '2.1.288';

const IMPORT_TIMEOUT_MS = 60_000;


export interface ClaudeImportSpec {
  testedVersions: readonly string[];
  /** The import's argv after the binary, given the transcript's path. */
  argv(file: string): string[];
  /** The id the vendor assigned, from what the import printed. */
  parse(output: string): string | undefined;
  /** How calls are written (ClaudeThreadOptions `toolCalls`). */
  toolCalls?: 'blocks' | 'text';
  /** The one transport that resumes an imported thread, when only one does
   *  (NativeThreadWritten `transport`). */
  transport?: NativeThreadWritten['transport'];
}

export async function importClaudeThread(
  record: CanonicalRecord, context: NativeThreadWriteContext, spec: ClaudeImportSpec,
): Promise<NativeThreadWritten | undefined> {
  const sessionId = randomUUID();
  const directory = await mkdtemp(join(tmpdir(), 'clikcode-thread-'));
  try {
    const file = join(directory, `${sessionId}.jsonl`);
    await writeFile(file, claudeThreadJsonl(record, {
      sessionId, cwd: context.workspace, model: null, version: CLAUDE_THREAD_VERSION,
      ...(spec.toolCalls ? { toolCalls: spec.toolCalls } : {}),
    }), { mode: 0o600 });
    const output = await captureNativeHarnessOutput(
      context.harness, spec.argv(file), context.environment, IMPORT_TIMEOUT_MS, context.workspace,
    );
    const nativeId = spec.parse(output);
    return nativeId ? { nativeId, ...(spec.transport ? { transport: spec.transport } : {}) } : undefined;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function claudeImportWriter(spec: ClaudeImportSpec): NativeThreadWriter {
  return {
    testedVersions: spec.testedVersions,
    versionOk: (context) => testedVersion(spec.testedVersions)(context),
    write: (record, context) => importClaudeThread(record, context, spec),
  };
}
