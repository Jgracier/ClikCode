/** Antigravity CLI: a conversation written as Antigravity's own thread
 * (NativeThreadWriter).
 *
 * A conversation is one SQLite file, `<HOME>/.gemini/antigravity-cli/
 * conversations/<cascade id>.db` (antigravity-store.ts), and `agy -p ...
 * --conversation <cascade id>` resumes it. Its tables, as agy 1.2.16 creates
 * them: `trajectory_meta` (trajectory id, cascade id, type, source),
 * `trajectory_metadata_blob` (one `main` row), `steps` (one row per step,
 * `step_payload` a protobuf `gemini_coder.Step` and `metadata` a copy of its
 * `CortexStepMetadata`), and `gen_metadata`, `executor_metadata`,
 * `parent_references`, `battle_mode_infos` -- the generator's request log and
 * executor bookkeeping, which resume does not need and this writer leaves
 * empty. The message shapes are the binary's own embedded descriptors
 * (`exa.cortex_pb.*`, `gemini_coder.Step`), the values the ones agy writes.
 *
 * What the model is given on resume is rebuilt from `steps` alone (read from
 * the generator request agy logged for the resumed turn): a USER_INPUT step
 * becomes the user message (wrapped in `<USER_REQUEST>` by agy), a
 * PLANNER_RESPONSE its answer text and function calls (`tool_calls`: id,
 * name, JSON arguments), and a GENERIC step -- `metadata.tool_call` plus the
 * argument map and a result string -- that call's function response,
 * prefixed with a `Created At:` line from the step's timestamp. No thought
 * signatures are written: Gemini's cannot be forged, and agy replays a
 * signature-less call from history without complaint.
 *
 * Calls map onto agy's own tools: a shell call to `run_command`, a read to
 * `view_file`, an edit with its old and new text to `replace_file_content`, a
 * whole-file write to `write_to_file`, a URL fetch to `read_url_content`, a
 * web search to `search_web`. Anything else is told as text in the answer. */

import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CanonicalRecord, CanonicalToolCall } from '../../canonical.js';
import { nativeDataRoot, type NativeSessionEnvironment, type NativeThreadWriter } from '../stores.js';
import {
  absolutePath, assistantSteps, callCommand, callPath, callResultText, inputString, isWriteCall, requestText,
  sequentialIds, testedVersion,
} from './thread-writer-files.js';

/** Where agy keeps its conversations under an environment's HOME. */
export function antigravityConversationsRoot(environment: NativeSessionEnvironment): string {
  return join(nativeDataRoot(environment, 'HOME', homedir()), '.gemini', 'antigravity-cli', 'conversations');
}

/** agy builds whose conversation layout this writer was verified against. */
export const ANTIGRAVITY_WRITER_TESTED_VERSIONS = ['1.2.16'] as const;

// ---- protobuf, encode only ------------------------------------------------

/** One field: number and value. A value of undefined, 0, false or '' is the
 * proto3 default and is left out, as agy's own Go encoder leaves it out. */
export type ProtoField = readonly [number, ProtoValue];
export type ProtoValue = number | boolean | string | Uint8Array | readonly ProtoField[] | undefined;

function varint(value: number, out: number[]): void {
  let rest = value;
  while (rest >= 0x80) { out.push((rest % 0x80) | 0x80); rest = Math.floor(rest / 0x80); }
  out.push(rest);
}

export function encodeProto(fields: readonly ProtoField[]): Buffer {
  const out: number[] = [];
  for (const [number, value] of fields) {
    if (value === undefined || value === 0 || value === false || value === '') continue;
    if (typeof value === 'number' || typeof value === 'boolean') {
      varint(number * 8, out);
      varint(Number(value), out);
      continue;
    }
    const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8')
      : value instanceof Uint8Array ? value : encodeProto(value);
    varint(number * 8 + 2, out);
    varint(bytes.length, out);
    for (const byte of bytes) out.push(byte);
  }
  return Buffer.from(out);
}

const timestamp = (ms: number): ProtoField[] => [[1, Math.floor(ms / 1000)], [2, (ms % 1000) * 1_000_000]];

// ---- the thread -----------------------------------------------------------

/** CortexStepType / CortexStepSource / CortexStepStatus values used here. */
const STEP_USER_INPUT = 14;
const STEP_PLANNER_RESPONSE = 15;
const STEP_GENERIC = 132;
const SOURCE_MODEL = 2;
const SOURCE_USER_EXPLICIT = 4;
const STATUS_DONE = 3;
/** gemini_coder.Step oneof fields for those step types. */
const FIELD_USER_INPUT = 19;
const FIELD_PLANNER_RESPONSE = 20;
const FIELD_GENERIC = 140;
/** CortexTrajectoryType CASCADE, CortexTrajectorySource CLI: what agy -p writes. */
const TRAJECTORY_TYPE_CASCADE = 4;
const TRAJECTORY_SOURCE_CLI = 17;
/** StopReason agy records on a finished response. */
const STOP_REASON_DONE = 2;

/** The tables as agy 1.2.16 creates them, verbatim (sqlite_master). */
const SCHEMA = [
  'CREATE TABLE `trajectory_meta` (`trajectory_id` text,`cascade_id` text,`trajectory_type` integer,`source` integer,PRIMARY KEY (`trajectory_id`))',
  'CREATE TABLE `steps` (`idx` integer,`step_type` integer NOT NULL DEFAULT 0,`status` integer NOT NULL DEFAULT 0,`has_subtrajectory` numeric NOT NULL DEFAULT false,`metadata` blob,`error_details` blob,`permissions` blob,`task_details` blob,`render_info` blob,`step_payload` blob,`step_format` integer NOT NULL DEFAULT 0,PRIMARY KEY (`idx`))',
  'CREATE INDEX `idx_steps_status` ON `steps`(`status`)',
  'CREATE INDEX `idx_steps_step_type` ON `steps`(`step_type`)',
  'CREATE TABLE `gen_metadata` (`idx` integer,`data` blob,`size` integer NOT NULL DEFAULT 0,PRIMARY KEY (`idx`))',
  'CREATE TABLE `executor_metadata` (`idx` integer,`data` blob,PRIMARY KEY (`idx`))',
  'CREATE TABLE `parent_references` (`idx` integer,`data` blob,PRIMARY KEY (`idx`))',
  'CREATE TABLE `trajectory_metadata_blob` (`id` text DEFAULT "main",`data` blob,PRIMARY KEY (`id`))',
  'CREATE TABLE `battle_mode_infos` (`idx` integer,`data` blob,PRIMARY KEY (`idx`))',
] as const;

type Args = Record<string, string | number | boolean>;

/** agy's own tool for a call, with the arguments its schema names. */
function antigravityCall(workspace: string) {
  return (call: CanonicalToolCall): { name: string; args: Args } | undefined => {
    const name = call.name.toLowerCase();
    const path = callPath(call);
    const file = path ? absolutePath(workspace, path) : undefined;
    const about = { toolAction: call.label, toolSummary: call.label };
    if (call.category === 'run' || (!call.category && /^(bash|shell|exec|run_shell_command|shell_command|run_terminal_command|run_command)$/.test(name))) {
      const command = callCommand(call);
      return command ? { name: 'run_command', args: { CommandLine: command, Cwd: workspace, WaitMsBeforeAsync: 5000, ...about } } : undefined;
    }
    if (call.category === 'read' && file) return { name: 'view_file', args: { AbsolutePath: file, ...about } };
    if (call.category === 'edit' && file) {
      if (isWriteCall(call)) {
        const content = inputString(call, 'content', 'file_text', 'text', 'CodeContent');
        return content !== undefined
          ? { name: 'write_to_file', args: { TargetFile: file, Overwrite: true, CodeContent: content, Description: call.label, ...about } } : undefined;
      }
      const oldText = inputString(call, 'old_string', 'oldText', 'old_str', 'TargetContent');
      const newText = inputString(call, 'new_string', 'newText', 'new_str', 'ReplacementContent');
      return oldText !== undefined && newText !== undefined
        ? {
          name: 'replace_file_content',
          args: { TargetFile: file, Instruction: call.label, Description: call.label, AllowMultiple: false, TargetContent: oldText, ReplacementContent: newText, ...about },
        } : undefined;
    }
    if (call.category === 'fetch') {
      const url = inputString(call, 'url', 'uri', 'Url');
      if (url) return { name: 'read_url_content', args: { Url: url, ...about } };
      const query = inputString(call, 'query', 'q') ?? call.target;
      return query ? { name: 'search_web', args: { query, ...about } } : undefined;
    }
    return undefined;
  };
}

/** A shell call's result as agy words its own. */
function resultText(call: CanonicalToolCall, tool: string): string {
  if (tool === 'run_command' && call.status === 'done' && call.output?.length) {
    return `The command exited with code ${call.exitCode ?? 0}.\nOutput:\n${callResultText({ ...call, exitCode: undefined })}\n`;
  }
  return callResultText(call);
}

export interface AntigravityThreadOptions {
  cascadeId: string;
  trajectoryId: string;
  workspace: string;
  /** Epoch ms of the first step; each later one is a second on. */
  startMs: number;
  /** Execution (one per request) and call ids; random by default. */
  executionId?: () => string;
  callId?: () => string;
}

export interface AntigravityStepRow {
  idx: number;
  stepType: number;
  metadata: Buffer;
  payload: Buffer;
}

export interface AntigravityThreadRows {
  trajectoryMeta: { trajectoryId: string; cascadeId: string; type: number; source: number };
  trajectoryMetadata: Buffer;
  steps: AntigravityStepRow[];
}

/** Every row of the conversation database, encoded. */
export function antigravityThreadRows(record: CanonicalRecord, options: AntigravityThreadOptions): AntigravityThreadRows {
  const executionId = options.executionId ?? randomUUID;
  const callId = options.callId ?? sequentialIds('call_clikcode_');
  const map = antigravityCall(options.workspace);
  const steps: AntigravityStepRow[] = [];
  const add = (stepType: number, field: number, body: readonly ProtoField[], source: number, execution: string, toolCall?: readonly ProtoField[]): void => {
    const idx = steps.length;
    const metadata: ProtoField[] = [
      [1, timestamp(options.startMs + idx * 1000)],
      [3, source],
      [4, toolCall],
      [12, execution],
      [20, [[1, options.trajectoryId], [2, idx], [4, options.cascadeId]]],
    ];
    steps.push({
      idx, stepType, metadata: encodeProto(metadata),
      payload: encodeProto([[1, stepType], [4, STATUS_DONE], [5, metadata], [field, body]]),
    });
  };

  let execution = '';
  for (const turn of record.turns) {
    const request = requestText(turn);
    if (request.trim() || !steps.length) {
      execution = executionId();
      const text = request.trim() ? request : '(continue)';
      add(STEP_USER_INPUT, FIELD_USER_INPUT, [[2, text], [3, [[1, text]]]], SOURCE_USER_EXPLICIT, execution);
    }
    for (const step of assistantSteps(turn, map, callId)) {
      const calls = step.calls.map((call) => ({
        call,
        proto: [[1, call.id], [2, call.name], [3, JSON.stringify(call.args)]] as ProtoField[],
      }));
      add(STEP_PLANNER_RESPONSE, FIELD_PLANNER_RESPONSE, [
        [1, step.text], [8, step.text], ...calls.map(({ proto }): ProtoField => [7, proto]), [12, STOP_REASON_DONE],
      ], SOURCE_MODEL, execution);
      for (const { call, proto } of calls) {
        const args = Object.entries(call.args).map(([key, value]): ProtoField => [1, [[1, key], [2, typeof value === 'string' ? value : JSON.stringify(value)]]]);
        add(STEP_GENERIC, FIELD_GENERIC, [...args, [2, [[1, resultText(call.call, call.name)]]]], SOURCE_MODEL, execution, proto);
      }
    }
  }
  const uri = `file://${options.workspace}`;
  return {
    trajectoryMeta: { trajectoryId: options.trajectoryId, cascadeId: options.cascadeId, type: TRAJECTORY_TYPE_CASCADE, source: TRAJECTORY_SOURCE_CLI },
    // CortexTrajectoryMetadata: workspaces, created_at, root_conversation_id,
    // workspace_uris, project_id (agy's default for a CLI conversation).
    trajectoryMetadata: encodeProto([
      [1, [[1, uri], [2, uri]]], [2, timestamp(options.startMs)], [6, options.cascadeId], [7, uri], [18, 'default-cli-project'],
    ]),
    steps,
  };
}

interface Db {
  exec(sql: string): void;
  prepare(sql: string): { run(...values: unknown[]): unknown };
  close(): void;
}

async function writeDatabase(path: string, rows: AntigravityThreadRows): Promise<void> {
  const sqlite = await import('node:sqlite') as { DatabaseSync: new (p: string) => Db };
  const db = new sqlite.DatabaseSync(path);
  try {
    db.exec('BEGIN');
    for (const statement of SCHEMA) db.exec(statement);
    db.prepare('INSERT INTO trajectory_meta (trajectory_id, cascade_id, trajectory_type, source) VALUES (?, ?, ?, ?)')
      .run(rows.trajectoryMeta.trajectoryId, rows.trajectoryMeta.cascadeId, rows.trajectoryMeta.type, rows.trajectoryMeta.source);
    db.prepare("INSERT INTO trajectory_metadata_blob (id, data) VALUES ('main', ?)").run(rows.trajectoryMetadata);
    const step = db.prepare('INSERT INTO steps (idx, step_type, status, metadata, step_payload) VALUES (?, ?, ?, ?, ?)');
    for (const row of rows.steps) step.run(row.idx, row.stepType, STATUS_DONE, row.metadata, row.payload);
    db.exec('COMMIT');
  } finally {
    db.close();
  }
}

/** Verified against agy 1.2.16 (2026-10-04, vendor-sandbox, Gemini 3.6 Flash
 *  Low): a conversation written this way -- a codeword, a Codex shell call
 *  as run_command, a Claude Edit as replace_file_content -- resumed with
 *  `agy -p ... --conversation <id>` continued at step 8 and answered
 *  "1. Codeword: HERON-58 / 2. notes.txt content: launch window: Thursday /
 *  3. Change made to src/app.ts: Replaced `cosnt x = 1;` with
 *  `const x = 1;`"; the request agy logged (gen_metadata) carried the calls
 *  as function calls with agy's own skip-signature marker. */
export const antigravityThreadWriter: NativeThreadWriter = {
  testedVersions: ANTIGRAVITY_WRITER_TESTED_VERSIONS,
  versionOk: testedVersion(ANTIGRAVITY_WRITER_TESTED_VERSIONS),
  async write(record, context) {
    if (!record.turns.length) return undefined;
    const root = antigravityConversationsRoot(context.environment);
    const cascadeId = randomUUID();
    // Steps are a second apart and the last one is not in the future.
    const stepBound = record.turns.reduce((count, turn) => count + 1 + 2 * turn.parts.length, 1);
    const rows = antigravityThreadRows(record, {
      cascadeId, trajectoryId: randomUUID(), workspace: context.workspace, startMs: Date.now() - 1000 * stepBound,
    });
    if (!rows.steps.length) return undefined;
    const path = join(root, `${cascadeId}.db`);
    if (await stat(path).then(() => true, () => false)) return undefined;
    await mkdir(root, { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      await writeDatabase(temporary, rows);
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
    return { nativeId: cascadeId };
  },
};
