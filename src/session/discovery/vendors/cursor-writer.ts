/** Cursor Agent: a conversation written as Cursor's own ACP session
 * (NativeThreadWriter). REGISTERED BUT DISABLED -- see cursorThreadWriter.
 *
 * The layout is the one cursor-agent 2026.09.26-dd393fe writes itself, read
 * from real stores. An ACP session (`cursor-agent acp`, what ClikCode drives)
 * is a directory `<root>/<agentId>/` holding:
 *
 * - `meta.json` -- `{ schemaVersion: 1, cwd, title }`.
 * - `store.db` -- SQLite with two tables. `meta` row `'0'` is HEX-encoded JSON
 *   `{ agentId, latestRootBlobId, name, mode, isRunEverything, createdAt,
 *   blobEncryptionKey }`. `blobs` maps id -> bytes, content-addressed: the id
 *   is the sha256 of the bytes, and references between blobs are those 32
 *   raw bytes. Blobs are plaintext on disk; `blobEncryptionKey` is only sent
 *   to Cursor's server as a header, so a fresh random one is valid.
 *
 * `<root>` is `$XDG_CONFIG_HOME/cursor/acp-sessions` when XDG_CONFIG_HOME is
 * set (every ClikCode Cursor profile: a redirected HOME with its XDG
 * directories), else `~/.cursor/acp-sessions`. The CLI's own chats
 * (`~/.cursor/chats/<md5(cwd)>/<id>/`) use the same store but are a different
 * directory the ACP agent does not read, so a written thread is ACP-pinned.
 *
 * The root blob (latestRootBlobId) is a protobuf message:
 * - field 1, repeated: the MODEL-VISIBLE conversation, one blob per message,
 *   each JSON in the AI SDK shape (`{ role, content }`; assistant content is
 *   text and `tool-call` parts, a `tool` message holds the `tool-result`).
 *   The client sends exactly these on the next turn, so this is what the
 *   model remembers. Real tool names: Shell, Read, StrReplace, Write, Grep,
 *   Glob.
 * - field 8, repeated: one blob per turn, the structure `session/load`
 *   REPLAYS to the client UI: the request (a blob: 1 text, 2/17 request id,
 *   25/26 time), then step blobs -- `{1: {1: text}}` for answer text,
 *   `{2: {<tool>: {1: args, 2: result}, 57: call id}}` for a call, where
 *   <tool> is 1 Shell, 4 Glob, 5 Grep, 8 Read, 12 edit (StrReplace and Write).
 * - 9 `file://<cwd>`, 21 `{1: cwd}`, 22 `cli`, 26 created ms, 27 time zone.
 * Fields this writer leaves out because ClikCode cannot know them: 5 (token
 * accounting), the request's field 10 (the system prompt and environment
 * snapshot Cursor built for that request), reasoning (signed by the model
 * vendor; cannot be forged).
 *
 * The open question that keeps this disabled: every real store starts its
 * field 1 with Cursor's own system message and a `<user_info>` environment
 * message, whose wording depends on the model and the build. This writer
 * writes neither. Whether the client puts its own in front when the stored
 * history has none has to be seen on a real model turn. */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { CanonicalRecord, CanonicalToolCall } from '../../canonical.js';
import type { NativeSessionEnvironment, NativeSessionFile, NativeSessionStore, NativeThreadWriter, NativeThreadWritten } from '../stores.js';
import { testedVersion } from './thread-writer-files.js';
import {
  absolutePath, assistantSteps, callCommand, callPath, callResultText, inputString, isWriteCall, requestText,
} from './thread-writer-files.js';

/** EMPTY ON PURPOSE: the writer is disabled. A store written here was
 * REPLAYED in full by `session/load` of cursor-agent 2026.09.26-dd393fe
 * (codeword, Shell call, StrReplace edit; cursor-writer.vitest.test.ts has
 * the check), but no model turn could run on it -- every account was out of
 * quota ("Upgrade your plan to continue", reset ~2026-11-01). Enable once ONE
 * ACP model turn on a written store recalls the codeword:
 *
 *   node scripts/verify-thread-writer.mjs cursor --link .config/cursor/auth.json
 *
 * then add the `cursor-agent --version` it printed here. */
export const CURSOR_WRITER_TESTED_VERSIONS: readonly string[] = [];

/** Where `cursor-agent acp` keeps its sessions under `environment`. */
export function cursorAcpSessionsRoot(environment: NativeSessionEnvironment): string {
  const config = environment.XDG_CONFIG_HOME?.trim();
  if (config) return join(config, 'cursor', 'acp-sessions');
  return join(environment.HOME?.trim() || homedir(), '.cursor', 'acp-sessions');
}

// ------------------------------------------------------------ protobuf ----

type PbValue = number | string | Buffer | undefined;

function varint(value: number): Buffer {
  const bytes: number[] = [];
  let rest = BigInt(Math.max(0, Math.floor(value)));
  do {
    const low = Number(rest & 0x7fn);
    rest >>= 7n;
    bytes.push(rest ? low | 0x80 : low);
  } while (rest);
  return Buffer.from(bytes);
}

/** A protobuf message from `[field, value]` pairs, in order: a number is a
 *  varint, a string or Buffer is length-delimited (a nested message is the
 *  Buffer pb made). Undefined values are skipped. */
export function pb(fields: ReadonlyArray<readonly [number, PbValue]>): Buffer {
  const parts: Buffer[] = [];
  for (const [field, value] of fields) {
    if (value === undefined) continue;
    if (typeof value === 'number') {
      parts.push(varint(field * 8), varint(value));
      continue;
    }
    const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
    parts.push(varint(field * 8 + 2), varint(bytes.length), bytes);
  }
  return Buffer.concat(parts);
}

// --------------------------------------------------------------- tools ----

type Json = Record<string, unknown>;

/** A call as Cursor's model makes it: its tool and arguments, the result text
 *  the model reads, and the step its UI replays. */
interface CursorCall {
  name: string;
  args: Json;
  result: string;
  /** The step's tool field (1 Shell, 4 Glob, 5 Grep, 8 Read, 12 edit) and
   *  its `{1: args, 2: result}` message. */
  step: { field: number; body: Buffer };
}

function shellResult(call: CanonicalToolCall): string {
  if (call.status === 'unfinished') return callResultText(call);
  const output = call.output ?? [];
  const omitted = call.outputOmitted ? [`(${call.outputOmitted} ${call.outputTail ? 'earlier' : 'more'} lines not kept)`] : [];
  const lines = call.outputTail ? [...omitted, ...output] : [...output, ...omitted];
  const exit = call.exitCode ?? (call.status === 'done' ? 0 : 1);
  return `Exit code: ${exit}\n\nCommand output:\n\n\`\`\`\n${lines.join('\n')}\n\`\`\``;
}

/** Maps a recorded call, whoever made it, to the Cursor tool that does the
 *  same, or undefined where Cursor has none (it is then told as text). */
export function cursorCallFor(call: CanonicalToolCall, workspace: string, callId: string): CursorCall | undefined {
  const name = call.name.toLowerCase();
  const path = callPath(call);
  const file = path ? absolutePath(workspace, path) : undefined;
  const failed = call.status !== 'done';
  if (call.category === 'run' || (!call.category && /^(bash|shell|exec|exec_command|run_shell_command|shell_command|run_terminal_cmd)$/.test(name))) {
    const command = callCommand(call);
    if (!command) return undefined;
    const description = inputString(call, 'description');
    const output = (call.output ?? []).join('\n');
    const exit = call.exitCode ?? (call.status === 'done' ? 0 : 1);
    const outcome = exit === 0 && !failed
      ? pb([[1, pb([[1, command], [5, output], [10, output]])]])
      : pb([[2, pb([[1, command], [3, exit], [5, output], [9, output]])]]);
    return {
      name: 'Shell', args: { command, ...(description ? { description } : {}) }, result: shellResult(call),
      step: { field: 1, body: pb([[1, pb([[1, command], [4, callId], [15, description]])], [2, outcome], [3, description]]) },
    };
  }
  if (call.category === 'edit' || /^(edit|multiedit|write|write_file|create_file|str_replace|str_replace_based_edit_tool|replace)$/.test(name)) {
    if (!file) return undefined;
    if (isWriteCall(call)) {
      const contents = inputString(call, 'content', 'contents', 'file_text', 'text');
      if (contents === undefined) return undefined;
      const message = `Wrote contents to ${file}`;
      return {
        name: 'Write', args: { path: file, contents }, result: failed ? callResultText(call) : message,
        step: { field: 12, body: pb([[1, pb([[1, file], [6, contents]])], [2, pb([[1, pb([[1, file], [7, contents], [8, message]])]])]]) },
      };
    }
    const oldString = inputString(call, 'old_string', 'oldString', 'old_str', 'oldText');
    const newString = call.input?.new_string ?? call.input?.newString ?? call.input?.new_str ?? call.input?.newText;
    if (oldString === undefined || typeof newString !== 'string') return undefined;
    const message = `The file ${file} has been updated.`;
    return {
      name: 'StrReplace', args: { path: file, old_string: oldString, new_string: newString }, result: failed ? callResultText(call) : message,
      step: { field: 12, body: pb([[1, pb([[1, file], [6, newString]])], [2, pb([[1, pb([[1, file], [8, message]])]])]]) },
    };
  }
  const pattern = inputString(call, 'pattern', 'query', 'glob_pattern') ?? (call.category === 'search' ? call.target : undefined);
  if (/^(glob|find_files|list_files)$/.test(name) && pattern) {
    const directory = inputString(call, 'path', 'target_directory', 'dir_path');
    const target = directory ? absolutePath(workspace, directory) : undefined;
    return {
      name: 'Glob', args: { glob_pattern: pattern, ...(target ? { target_directory: target } : {}) }, result: callResultText(call),
      step: { field: 4, body: pb([[1, pb([[1, target], [2, pattern]])], [2, pb([[1, pb([[2, target ?? workspace]])]])]]) },
    };
  }
  if ((call.category === 'search' || /^(grep|search|search_file_content|rg)$/.test(name)) && pattern) {
    const where = inputString(call, 'path', 'dir_path');
    const glob = inputString(call, 'glob', 'include');
    const target = where ? absolutePath(workspace, where) : undefined;
    return {
      name: 'Grep', args: { pattern, ...(target ? { path: target } : {}), ...(glob ? { glob } : {}) }, result: callResultText(call),
      step: { field: 5, body: pb([[1, pb([[1, pattern], [2, target], [3, glob], [14, callId]])], [2, pb([[1, pb([[1, pattern], [2, target], [3, 'content']])]])]]) },
    };
  }
  if ((call.category === 'read' || /^(read|read_file|view|cat)$/.test(name)) && file) {
    const content = call.output?.join('\n') ?? '';
    return {
      name: 'Read', args: { path: file }, result: callResultText(call),
      step: { field: 8, body: pb([[1, pb([[1, file]])], [2, pb([[1, pb([[1, content], [7, file]])]])]]) },
    };
  }
  return undefined;
}

// --------------------------------------------------------------- store ----

/** What a write needs besides the record; fixed in tests for golden output. */
export interface CursorStoreOptions {
  agentId: string;
  workspace: string;
  /** Epoch ms of the first entry; each later one is a millisecond on. */
  startMs: number;
  /** Request, message and call ids; randomUUID by default. */
  id?: () => string;
  /** The 32-byte key, as hex; random by default. */
  encryptionKey?: string;
  timeZone?: string;
}

export interface CursorStore {
  /** `meta.json` beside the database. */
  metaFile: { schemaVersion: 1; cwd: string; title: string };
  /** `meta` row '0', before it is hex-encoded. */
  meta: Json;
  /** Every blob, in the order it was made. */
  blobs: Array<{ id: string; data: Buffer }>;
  rootId: string;
}

function title(record: CanonicalRecord): string {
  const first = record.turns.find((turn) => turn.user.trim())?.user.trim().split('\n')[0] ?? 'ClikCode conversation';
  return first.length > 60 ? `${first.slice(0, 57)}...` : first;
}

/** The store, as blobs and meta. Pure: everything time- or id-dependent comes
 *  from `options`. */
export function cursorStore(record: CanonicalRecord, options: CursorStoreOptions): CursorStore {
  const id = options.id ?? randomUUID;
  const { workspace } = options;
  const blobs: CursorStore['blobs'] = [];
  const known = new Set<string>();
  const put = (data: Buffer): Buffer => {
    const digest = createHash('sha256').update(data).digest();
    const hex = digest.toString('hex');
    if (!known.has(hex)) { known.add(hex); blobs.push({ id: hex, data }); }
    return digest;
  };
  const json = (value: Json): Buffer => put(Buffer.from(JSON.stringify(value), 'utf8'));
  let ms = options.startMs;
  const tick = (): number => (ms += 1) - 1;

  const messages: Buffer[] = [];
  const turns: Buffer[] = [];
  for (const turn of record.turns) {
    const request = requestText(turn);
    if (!request.trim() && !turn.parts.length) continue;
    const requestId = id();
    const at = tick();
    const text = request.trim() ? request : '(continue)';
    messages.push(json({
      role: 'user', content: [{ type: 'text', text: `<user_query>\n${text}\n</user_query>` }],
      providerOptions: { cursor: { requestId } },
    }));
    const steps: Buffer[] = [];
    const ids = new Map<CanonicalToolCall, string>();
    const mapped = new Map<CanonicalToolCall, CursorCall>();
    const callIds = (): string => `call-${id()}`;
    const plan = assistantSteps(turn, (call) => {
      const callId = callIds();
      const cursor = cursorCallFor(call, workspace, callId);
      if (!cursor) return undefined;
      ids.set(call, callId);
      mapped.set(call, cursor);
      return { name: cursor.name, args: cursor.args };
    }, () => '');
    for (const step of plan) {
      const calls = step.calls.map((entry) => ({ entry, callId: ids.get(entry.call)!, cursor: mapped.get(entry.call)! }));
      messages.push(json({
        role: 'assistant',
        content: [
          ...(step.text ? [{ type: 'text', text: step.text }] : []),
          ...calls.map(({ callId, cursor }) => ({ type: 'tool-call', toolCallId: callId, toolName: cursor.name, args: cursor.args })),
        ],
        id: `msg_${id()}`,
      }));
      if (step.text) steps.push(put(pb([[1, pb([[1, step.text], [2, tick()]])]])));
      for (const { callId, cursor } of calls) {
        messages.push(json({
          role: 'tool',
          content: [{
            type: 'tool-result', toolCallId: callId, toolName: cursor.name, result: cursor.result,
            experimental_content: [{ type: 'text', text: cursor.result }],
          }],
          id: callId,
        }));
        const started = tick();
        steps.push(put(pb([[2, pb([[cursor.step.field, cursor.step.body], [57, callId], [59, started], [60, tick()]])]])));
      }
    }
    const user = put(pb([[1, text], [2, requestId], [4, 1], [17, requestId], [25, at], [26, at]]));
    turns.push(put(pb([[1, pb([[1, user], ...steps.map((step) => [2, step] as const), [3, id()], [5, 0], [10, requestId]])]])));
  }
  const created = options.startMs;
  const timeZone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const root = put(pb([
    ...messages.map((message) => [1, message] as const),
    ...turns.map((turn) => [8, turn] as const),
    [9, `file://${workspace}`], [10, 1], [21, pb([[1, workspace]])], [22, 'cli'], [26, created], [27, timeZone], [39, 0],
  ]));
  const name = title(record);
  return {
    metaFile: { schemaVersion: 1, cwd: workspace, title: name },
    meta: {
      agentId: options.agentId, latestRootBlobId: root.toString('hex'), name, mode: 'default', isRunEverything: false,
      createdAt: created, blobEncryptionKey: options.encryptionKey ?? randomBytes(32).toString('hex'),
    },
    blobs,
    rootId: root.toString('hex'),
  };
}

interface Db {
  exec(sql: string): void;
  prepare(sql: string): { run(...values: unknown[]): unknown };
  close(): void;
}

/** Writes `store` as the session directory `<root>/<agentId>`, through a
 *  temporary sibling and a rename so the agent never finds half a session. */
export async function writeCursorStore(root: string, store: CursorStore): Promise<string> {
  const agentId = String(store.meta.agentId);
  const target = join(root, agentId);
  const staged = join(root, `.${agentId}.${randomBytes(4).toString('hex')}.tmp`);
  await mkdir(staged, { recursive: true, mode: 0o700 });
  try {
    await writeFile(join(staged, 'meta.json'), JSON.stringify(store.metaFile), { mode: 0o600 });
    // Node 22 -- this package's floor -- only has node:sqlite behind a flag,
    // so this import can fail; the caller then transfers instead.
    const sqlite = await import('node:sqlite') as unknown as { DatabaseSync: new (path: string) => Db };
    const db = new sqlite.DatabaseSync(join(staged, 'store.db'));
    try {
      db.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);');
      db.exec('BEGIN');
      const insert = db.prepare('INSERT INTO blobs (id, data) VALUES (?, ?)');
      for (const blob of store.blobs) insert.run(blob.id, blob.data);
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('0', Buffer.from(JSON.stringify(store.meta), 'utf8').toString('hex'));
      db.exec('COMMIT');
    } finally {
      db.close();
    }
    await rename(staged, target);
    return target;
  } catch (error) {
    await rm(staged, { recursive: true, force: true });
    throw error;
  }
}

/** The ACP sessions root of the taking-over account, only when its
 *  environment places one that is not the user's own: an unprofiled write
 *  would land in their own Cursor history. */
function profileRoot(environment: NativeSessionEnvironment): string | undefined {
  if (!environment.XDG_CONFIG_HOME?.trim() && !environment.HOME?.trim()) return undefined;
  const root = resolve(cursorAcpSessionsRoot(environment));
  if (!isAbsolute(root)) return undefined;
  const own = [join(homedir(), '.cursor', 'acp-sessions'), join(homedir(), '.config', 'cursor', 'acp-sessions')].map((path) => resolve(path));
  return own.includes(root) ? undefined : root;
}

export const cursorThreadWriter: NativeThreadWriter = {
  testedVersions: CURSOR_WRITER_TESTED_VERSIONS,
  versionOk: testedVersion(CURSOR_WRITER_TESTED_VERSIONS),
  async write(record, context): Promise<NativeThreadWritten | undefined> {
    const root = profileRoot(context.environment);
    if (!root || !record.turns.length) return undefined;
    const agentId = randomUUID();
    const store = cursorStore(record, { agentId, workspace: context.workspace, startMs: Date.now() });
    if (store.blobs.length < 3) return undefined;
    await writeCursorStore(root, store);
    // Only `cursor-agent acp` reads acp-sessions; the CLI's --resume looks
    // in ~/.cursor/chats.
    return { nativeId: agentId, transport: 'acp' };
  },
};

/** An ACP session is its own directory, `<root>/<agentId>/` (meta.json and
 *  a store.db holding only that session), not rows in a shared database -- so
 *  it carries the way Copilot's does: carry.ts copies the directory, newest
 *  wins. Never a `carry` of rows: copying one session's store.db cannot touch
 *  another's. */
export async function locateCursorSession(root: string, nativeId: string): Promise<NativeSessionFile | undefined> {
  if (!/^[\w-]+$/.test(nativeId)) return undefined;
  const path = join(root, nativeId);
  const [directory, store] = await Promise.all([
    stat(path).then((entry) => entry.isDirectory(), () => false),
    stat(join(path, 'store.db')).then((entry) => entry.isFile(), () => false),
  ]);
  return directory && store ? { path, root } : undefined;
}

/** OFF, with the writer and for the same reason: no Cursor model turn has run
 *  on a session that was not made in its own profile -- every account was
 *  out of quota. `session/load` replays a store written elsewhere (the
 *  writer's check), but whether another ACCOUNT's model turn accepts a
 *  session another account started (its agentId, its blobEncryptionKey) is
 *  unseen. Turn on once one carried session answers a model turn there:
 *  `locateCursorSession` is the whole of what this enables.
 *
 *  Re-tried 2026-10-05 (cursor-agent 2026.09.26-dd393fe, vendor-sandbox, ACP
 *  session/new + "Reply OK."): all 13 accounts, on the default model and on
 *  `auto` and `composer-2.5`, answered "Upgrade your plan to continue". */
export const CURSOR_CARRY_VERIFIED: boolean = false;

/** Until then a failover re-seeds, exactly as before. */
export const cursorSessionStore: NativeSessionStore = {
  root: cursorAcpSessionsRoot,
  ...(CURSOR_CARRY_VERIFIED ? { locate: locateCursorSession } : {}),
  writer: cursorThreadWriter,
};
