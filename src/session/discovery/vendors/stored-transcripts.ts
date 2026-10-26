/** Native transcript readers for the one-shot transports. Their formats are
 * the same observed layouts used by the native writers beside this module. */
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as zlib from 'node:zlib';
import type { AiLocalHarnessDefinition } from '../../../harness/definition.js';
import { captureNativeHarnessOutput } from '../../../harness/transport/native/command.js';
import type { NativeSessionEnvironment } from '../stores.js';
import { extractMessageText, type NativeTranscriptMessage } from '../transcript.js';
import { piSessionStore } from './pi-store.js';
import { antigravityConversationsRoot } from './antigravity-writer.js';

type Json = Record<string, any>;
const parsedLines = (text: string): Json[] => text.split('\n').filter((line) => line.trim()).flatMap((line) => {
  try { return [JSON.parse(line) as Json]; } catch { return []; }
});

/** Pi's selected branch, following the last entry's parent chain. Tool results
 * are not assistant messages; sibling branches are not the selected chat. */
export function piTranscript(entries: readonly Json[]): NativeTranscriptMessage[] {
  const byId = new Map(entries.filter((entry) => typeof entry.id === 'string').map((entry) => [entry.id, entry]));
  let last = entries.at(-1);
  const branch: Json[] = [];
  const seen = new Set<string>();
  while (last && typeof last.id === 'string' && !seen.has(last.id)) {
    seen.add(last.id); branch.unshift(last);
    last = typeof last.parentId === 'string' ? byId.get(last.parentId) : undefined;
  }
  return branch.flatMap((entry): NativeTranscriptMessage[] => {
    const role = entry.message?.role;
    if (entry.type !== 'message' || (role !== 'user' && role !== 'assistant')) return [];
    const content = extractMessageText(entry.message.content);
    return content.trim() ? [{ role, content }] : [];
  });
}

export async function readPiTranscript(_harness: AiLocalHarnessDefinition, id: string, workspace: string, environment: NativeSessionEnvironment = {}): Promise<NativeTranscriptMessage[]> {
  const root = piSessionStore.root(environment);
  const found = root && await piSessionStore.locate?.(root, id, workspace, environment);
  return found ? piTranscript(parsedLines(await readFile(found.path, 'utf8'))) : [];
}

export function aiderTranscript(text: string): NativeTranscriptMessage[] {
  const messages: NativeTranscriptMessage[] = [];
  let role: NativeTranscriptMessage['role'] = 'assistant';
  let lines: string[] = [];
  const flush = (): void => { const content = lines.join('\n').trim(); if (content) messages.push({ role, content }); lines = []; };
  for (const line of text.split('\n')) {
    if (line.startsWith('# ') || line.startsWith('> ')) continue;
    const user = line.startsWith('#### ');
    const next: NativeTranscriptMessage['role'] = user ? 'user' : line.trim() ? 'assistant' : role;
    if (next !== role) { flush(); role = next; }
    lines.push(user ? line.slice(5).replace(/ {2}$/, '').replace(/^<blank>$/, '') : line);
  }
  flush();
  return messages;
}

export async function readAiderTranscript(_harness: AiLocalHarnessDefinition, id: string): Promise<NativeTranscriptMessage[]> {
  return aiderTranscript(await readFile(id, 'utf8'));
}

/** Amp's official read-only JSON export, observed with the installed CLI. */
export async function readAmpTranscript(harness: AiLocalHarnessDefinition, id: string, workspace: string, environment: NativeSessionEnvironment = {}): Promise<NativeTranscriptMessage[]> {
  const raw = await captureNativeHarnessOutput(harness, ['threads', 'export', id], environment, undefined, workspace);
  const data = JSON.parse(raw.slice(raw.indexOf('{'))) as Json;
  return (Array.isArray(data.messages) ? data.messages : []).flatMap((message: Json): NativeTranscriptMessage[] => {
    if (message.role !== 'user' && message.role !== 'assistant') return [];
    const content = extractMessageText(message.content);
    return content.trim() ? [{ role: message.role, content }] : [];
  });
}

async function sqliteRows(path: string, query: string, id?: string): Promise<Json[]> {
  if (!await stat(path).then((info) => info.isFile(), () => false)) return [];
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path, { readOnly: true });
  try { return db.prepare(query).all(...(id === undefined ? [] : [id])) as Json[]; } finally { db.close(); }
}

export async function readOpenClawTranscript(_harness: AiLocalHarnessDefinition, id: string, _workspace: string, environment: NativeSessionEnvironment = {}): Promise<NativeTranscriptMessage[]> {
  if (!/^[\w-]+$/.test(id) || environment.OPENCLAW_PROFILE || environment.OPENCLAW_HOME) return [];
  const root = environment.OPENCLAW_STATE_DIR || join(environment.HOME || homedir(), '.openclaw');
  const rows = await sqliteRows(join(root, 'agents', 'main', 'agent', 'openclaw-agent.sqlite'),
    'SELECT * FROM transcript_events WHERE session_id = ? ORDER BY seq', id);
  const entries = rows.map((row): Json => {
    if (typeof row.event_json === 'string') return JSON.parse(row.event_json) as Json;
    const size = row.event_utf8_bytes;
    if (!(row.event_zstd instanceof Uint8Array) || !Number.isSafeInteger(size) || size < 1 || size > 4 * 1024 * 1024 || !zlib.zstdDecompressSync) throw new Error('Unsupported OpenClaw transcript encoding');
    const decoded = zlib.zstdDecompressSync(row.event_zstd, { maxOutputLength: size });
    if (decoded.length !== size) throw new Error('Incomplete OpenClaw transcript');
    return JSON.parse(decoded.toString('utf8')) as Json;
  });
  return piTranscript(entries);
}

/** Length-delimited protobuf fields; other standard wire types are skipped.
 * agy's Step.user_input is field 19; planner_response is field 20. */
function protoFields(bytes: Uint8Array): Map<number, Buffer> {
  const fields = new Map<number, Buffer>();
  let at = 0;
  const number = (): number => {
    let value = 0; let shift = 0;
    while (at < bytes.length && shift < 70) {
      const next = bytes[at++]!;
      value += (next & 127) * 2 ** shift;
      if (!(next & 128)) return value;
      shift += 7;
    }
    throw new Error('Incomplete protobuf field');
  };
  while (at < bytes.length) {
    const tag = number(); const wire = tag % 8;
    if (wire === 2) {
      const size = number();
      if (!Number.isSafeInteger(size) || size < 0 || at + size > bytes.length) throw new Error('Incomplete protobuf body');
      fields.set(Math.floor(tag / 8), Buffer.from(bytes.subarray(at, at + size))); at += size;
    } else if (wire === 0) number();
    else if (wire === 1) at += 8;
    else if (wire === 5) at += 4;
    else throw new Error('Unsupported protobuf field');
    if (at > bytes.length) throw new Error('Incomplete protobuf field');
  }
  return fields;
}

export async function readAntigravityTranscript(_harness: AiLocalHarnessDefinition, id: string, _workspace: string, environment: NativeSessionEnvironment = {}): Promise<NativeTranscriptMessage[]> {
  if (!/^[\w-]+$/.test(id)) return [];
  const rows = await sqliteRows(join(antigravityConversationsRoot(environment), `${id}.db`),
    'SELECT step_type, step_payload FROM steps ORDER BY idx');
  return rows.flatMap((row): NativeTranscriptMessage[] => {
    if (row.step_type !== 14 && row.step_type !== 15) return [];
    const nested = protoFields(row.step_payload as Uint8Array).get(row.step_type === 14 ? 19 : 20);
    if (!nested) return [];
    const fields = protoFields(nested);
    const content = (row.step_type === 14 ? fields.get(2) : fields.get(8) ?? fields.get(1))?.toString('utf8');
    return content?.trim() ? [{ role: row.step_type === 14 ? 'user' : 'assistant', content }] : [];
  });
}
