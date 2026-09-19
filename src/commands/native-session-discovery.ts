/** Vendor-native session discovery and transcript reading for ClikCode's
 * /resume feature: finding chats that exist purely in a harness's own
 * history (never opened through ClikCode) and, where a real per-vendor
 * mechanism exists, reading a whole prior conversation back out. Kept
 * separate from ai.ts's session/account orchestration and terminal UI: this
 * module only ever reads a vendor's own on-disk files or runs a documented,
 * read-only listing/export command — no ClikCode state, no rendering. */

import { open, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { captureNativeHarnessOutput, inspectNativeHarness } from './native-harness.js';
import type { AiLocalHarnessDefinition } from './types.js';

/** A short, single-line title from a chat's first real message — used both
 * here (a discovered session with no explicit title) and by ai.ts itself
 * (naming a session after its own first turn). Lives here, not ai.ts, so
 * ai.ts can depend on this module without this module depending back on it —
 * a real circular import the other way around, not just a style preference. */
export function conversationTitle(prompt: string): string {
  const title = prompt.replace(/\s+/g, ' ').trim();
  return title.length > 64 ? `${title.slice(0, 63).trimEnd()}…` : title;
}

export interface DiscoveredNativeSession {
  nativeId: string;
  title?: string;
  updatedAt?: string;
  /** Real epoch millis when known (every filesystem-based discoverer has the
   * file's own mtime). Shell-table discoverers only have whatever display
   * text the vendor printed ("yesterday", "11:16 AM", a bare date) — parsed
   * into this when the format is unambiguous, left unset otherwise, so an
   * unsortable value is never guessed into a false position. */
  updatedAtMs?: number;
}

export type NativeTranscriptMessage = { role: 'user' | 'assistant'; content: string };

/** Reconcile a cached ClikCode transcript with the vendor-owned source without
 * destroying context carried across providers. Native transcripts are often
 * bounded windows, so replacement is unsafe: find the longest suffix of the
 * cache that occurs in the source window and append only source messages that
 * follow it. With no overlap, retain the cache; with no cache, adopt source. */
export function mergeNativeTranscript(
  cached: readonly NativeTranscriptMessage[], source: readonly NativeTranscriptMessage[],
): NativeTranscriptMessage[] {
  if (!cached.length) return [...source];
  if (!source.length) return [...cached];
  const equal = (left: NativeTranscriptMessage, right: NativeTranscriptMessage): boolean =>
    left.role === right.role && left.content === right.content;
  const maxOverlap = Math.min(cached.length, source.length);
  for (let length = maxOverlap; length > 0; length -= 1) {
    const cachedStart = cached.length - length;
    for (let sourceStart = source.length - length; sourceStart >= 0; sourceStart -= 1) {
      let matches = true;
      for (let offset = 0; offset < length; offset += 1) {
        if (!equal(cached[cachedStart + offset]!, source[sourceStart + offset]!)) { matches = false; break; }
      }
      if (matches) return [...cached, ...source.slice(sourceStart + length)];
    }
  }
  return [...cached];
}

async function readFilePrefix(path: string, maxBytes: number): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.toString('utf8', 0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function walkFilesRecursive(dir: string, maxDepth: number, suffix: string): Promise<string[]> {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch {
    // fail-open-ok: a missing or unreadable optional vendor history directory has no sessions.
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory() && maxDepth > 0) files.push(...await walkFilesRecursive(full, maxDepth - 1, suffix));
    else if (entry.isFile() && entry.name.endsWith(suffix)) files.push(full);
  }
  return files;
}

async function newestFiles(paths: readonly string[], limit: number): Promise<Array<{ path: string; mtimeMs: number }>> {
  const stats = await Promise.all(paths.map(async (path) => {
    const info = await stat(path).catch(() => undefined);
    return info ? { path, mtimeMs: info.mtimeMs } : undefined;
  }));
  return stats.filter((item): item is { path: string; mtimeMs: number } => Boolean(item))
    .sort((left, right) => right.mtimeMs - left.mtimeMs).slice(0, limit);
}

/** Both Claude Code and Codex represent a message's content as either a plain
 * string or a list of content blocks ({type:'text', text:'...'}, possibly
 * mixed with non-text blocks like tool calls) — real API message shapes, not
 * one canonical format. Used for both title extraction (first real message)
 * and full transcript reading (every message), so a session that happens to
 * use the array shape gets the same treatment either way instead of only
 * being fixed for the one caller that was reported broken. */
function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => typeof (part as { text?: unknown })?.text === 'string' ? (part as { text: string }).text : '').join(' ').trim();
}

/** Remove client-owned context envelopes from a native user turn while
 * retaining the actual prompt. Codex records IDE context as part of the user
 * item; importing that wrapper verbatim makes the ClikCode transcript look as
 * if the same request was pasted several times. Unknown content is preserved. */
function visibleNativeUserText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith('<')) return '';
  if (trimmed.startsWith('# Context from my IDE setup:')) {
    const marker = '\n## My request:\n';
    const requestStart = trimmed.indexOf(marker);
    if (requestStart >= 0) return trimmed.slice(requestStart + marker.length).trim();
  }
  return trimmed;
}

// Large enough that an externally continued thread still overlaps ClikCode's
// cached suffix; bounded so opening a years-long vendor history cannot bloat
// the local state file without limit.
const ADOPTED_TRANSCRIPT_LIMIT = 200;

/** Claude Code has no CLI command that lists past sessions (`--resume` with no
 * id opens an interactive TUI picker only), but it writes one real, stable
 * `<uuid>.jsonl` file per session under a project folder named by literalizing
 * the cwd path (`/` becomes `-`) — directly observed on disk, not guessed. The
 * first line is often `{"type":"ai-title","aiTitle":"..."}`; older sessions
 * without one fall back to the first `type":"user"` message's own text. */
export type NativeSessionEnvironment = Readonly<Record<string, string>>;

function nativeDataRoot(environment: NativeSessionEnvironment, variable: string, fallback: string): string {
  return environment[variable]?.trim() || fallback;
}

async function discoverClaudeFsSessions(workspace: string, environment: NativeSessionEnvironment = {}): Promise<DiscoveredNativeSession[]> {
  const dir = join(nativeDataRoot(environment, 'CLAUDE_CONFIG_DIR', join(homedir(), '.claude')), 'projects', workspace.replace(/\//g, '-'));
  const files = await walkFilesRecursive(dir, 0, '.jsonl');
  const recent = await newestFiles(files, 15);
  const sessions: DiscoveredNativeSession[] = [];
  for (const file of recent) {
    const nativeId = file.path.slice(dir.length + 1).replace(/\.jsonl$/, '');
    const prefix = await readFilePrefix(file.path, 8_000).catch(() => '');
    let title: string | undefined;
    for (const line of prefix.split('\n')) {
      if (!line.trim()) continue;
      let record: Record<string, unknown>;
      try { record = JSON.parse(line); } catch { continue; }
      if (record.type === 'ai-title' && typeof record.aiTitle === 'string') { title = record.aiTitle; break; }
      const message = record.message as { content?: unknown } | undefined;
      if (!title && record.type === 'user') {
        const text = visibleNativeUserText(extractMessageText(message?.content));
        // Claude Code also injects synthetic wrapper turns (e.g. a
        // "<local-command-caveat>" note about a slash command's own output) as
        // literal role:"user" messages — the same reason Codex's fallback below
        // skips anything starting with "<".
        if (text) title = conversationTitle(text);
      }
    }
    sessions.push({ nativeId, title, updatedAt: new Date(file.mtimeMs).toISOString(), updatedAtMs: file.mtimeMs });
  }
  return sessions;
}

/** Reads every user/assistant turn from a Claude Code session's own jsonl file
 * (not just the prefix scanned for a title) and maps it onto ClikCode's own
 * {role, content} message shape, so adopting a Claude Code chat shows its
 * real prior conversation instead of starting the ClikCode view blank while
 * only the native thread underneath actually remembers anything. Capped to
 * the most recent messages for the same reason failoverPrompt caps replay:
 * an adoption is a one-time read, not something that should scale with a
 * session's total lifetime size. */
async function readClaudeFsTranscript(nativeId: string, workspace: string, environment: NativeSessionEnvironment = {}): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
  const path = join(nativeDataRoot(environment, 'CLAUDE_CONFIG_DIR', join(homedir(), '.claude')), 'projects', workspace.replace(/\//g, '-'), `${nativeId}.jsonl`);
  let raw: string;
  try { raw = await readFile(path, 'utf8'); } catch {
    // fail-open-ok: an optional native transcript that disappeared during discovery contributes no messages.
    return [];
  }
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let record: Record<string, unknown>;
    try { record = JSON.parse(line); } catch { continue; }
    if (record.type !== 'user' && record.type !== 'assistant') continue;
    const message = record.message as { content?: unknown } | undefined;
    const extracted = extractMessageText(message?.content);
    const text = record.type === 'user' ? visibleNativeUserText(extracted) : extracted;
    if (!text) continue;
    messages.push({ role: record.type, content: text });
  }
  return messages.slice(-ADOPTED_TRANSCRIPT_LIMIT);
}

/** Codex writes one `rollout-<timestamp>-<uuid>.jsonl` file per session under
 * `~/.codex/sessions/<year>/<month>/<day>/`, not scoped by project directory —
 * `session_meta`'s own `cwd` field is what filters to this workspace. There is
 * no title field; the first real user message (skipping synthetic `<...>`
 * wrapper turns Codex injects, like recommended-plugin notices) stands in for
 * one, same convention ClikCode's own conversationTitle already uses. */
async function discoverCodexFsSessions(workspace: string, environment: NativeSessionEnvironment = {}): Promise<DiscoveredNativeSession[]> {
  const root = join(nativeDataRoot(environment, 'CODEX_HOME', join(homedir(), '.codex')), 'sessions');
  const files = await walkFilesRecursive(root, 4, '.jsonl');
  const recent = await newestFiles(files, 25);
  const sessions: DiscoveredNativeSession[] = [];
  for (const file of recent) {
    const prefix = await readFilePrefix(file.path, 64_000).catch(() => '');
    let sessionId: string | undefined;
    let cwd: string | undefined;
    let title: string | undefined;
    for (const line of prefix.split('\n')) {
      if (!line.trim()) continue;
      let record: Record<string, unknown>;
      try { record = JSON.parse(line); } catch { continue; }
      const payload = record.payload as Record<string, unknown> | undefined;
      if (record.type === 'session_meta') {
        sessionId = typeof payload?.session_id === 'string' ? payload.session_id : undefined;
        cwd = typeof payload?.cwd === 'string' ? payload.cwd : undefined;
      } else if (!title && record.type === 'response_item' && payload?.role === 'user') {
        const text = visibleNativeUserText(extractMessageText(payload.content));
        if (text) title = conversationTitle(text);
      }
    }
    if (!sessionId || (workspace && cwd && cwd !== workspace)) continue;
    sessions.push({ nativeId: sessionId, title, updatedAt: new Date(file.mtimeMs).toISOString(), updatedAtMs: file.mtimeMs });
  }
  return sessions;
}

/** Codex's rollout filename ends in the session's own uuid
 * (`rollout-<timestamp>-<uuid>.jsonl`), so the exact file is a direct lookup
 * rather than re-scanning every file's session_meta again. Reads every
 * response_item user/assistant turn from the full file (the discovery pass
 * above only scans a bounded prefix, enough for a title, not a transcript). */
async function readCodexFsTranscript(nativeId: string, workspace: string, environment: NativeSessionEnvironment = {}): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
  const root = join(nativeDataRoot(environment, 'CODEX_HOME', join(homedir(), '.codex')), 'sessions');
  const files = await walkFilesRecursive(root, 4, '.jsonl');
  const path = files.find((file) => file.endsWith(`${nativeId}.jsonl`));
  if (!path) return [];
  let raw: string;
  try { raw = await readFile(path, 'utf8'); } catch {
    // fail-open-ok: an optional native transcript that disappeared during discovery contributes no messages.
    return [];
  }
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let record: Record<string, unknown>;
    try { record = JSON.parse(line); } catch { continue; }
    if (record.type !== 'response_item') continue;
    const payload = record.payload as Record<string, unknown> | undefined;
    const role = payload?.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const extracted = extractMessageText(payload?.content);
    const text = role === 'user' ? visibleNativeUserText(extracted) : extracted;
    if (!text) continue;
    messages.push({ role, content: text });
  }
  void workspace; // Codex sessions aren't project-scoped by path; discovery already filtered by cwd.
  return messages.slice(-ADOPTED_TRANSCRIPT_LIMIT);
}

/** opencode publishes a real export command (`opencode export <sessionID>`,
 * confirmed live) that dumps the full session as JSON: a `messages` array of
 * `{info: {role}, parts: [{type, text}]}` entries. Only `type: "text"` parts
 * are used — tool calls and their results are real parts too but have no
 * plain-text representation in ClikCode's own {role, content: string}
 * message model, the same reason Claude/Codex transcripts above only keep
 * text blocks. */
async function readOpencodeTranscript(harness: AiLocalHarnessDefinition, nativeId: string, workspace: string): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
  let raw: string;
  try { raw = await captureNativeHarnessOutput(harness, ['export', nativeId], {}, 8_000, workspace); } catch {
    // fail-open-ok: session adoption is optional; a failed read-only vendor export has no importable messages.
    return [];
  }
  // `export` prints a human progress line ("Exporting session: <id>") before
  // the JSON body — skip to the first '{' rather than assume a fixed line count.
  const jsonStart = raw.indexOf('{');
  if (jsonStart === -1) return [];
  let parsed: { messages?: Array<{ info?: { role?: string }; parts?: Array<{ type?: string; text?: string }> }> };
  try { parsed = JSON.parse(raw.slice(jsonStart)); } catch {
    // fail-open-ok: malformed optional vendor export output cannot yield a trustworthy transcript.
    return [];
  }
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const message of parsed.messages ?? []) {
    const role = message.info?.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const text = (message.parts ?? []).filter((part) => part.type === 'text').map((part) => part.text ?? '').join(' ').trim();
    if (text) messages.push({ role, content: text });
  }
  return messages.slice(-ADOPTED_TRANSCRIPT_LIMIT);
}

/** Cursor Agent's own `ls`/`--resume` are interactive pickers with no JSON
 * mode, but each chat has a real `meta.json` (schemaVersion, title, cwd,
 * updatedAtMs) under `~/.cursor/chats/<project-hash>/<chat-uuid>/` — the
 * chat-uuid directory name is exactly the id its `--resume <chatId>` expects. */
async function discoverCursorFsSessions(workspace: string): Promise<DiscoveredNativeSession[]> {
  const root = join(homedir(), '.cursor', 'chats');
  let projectDirs;
  try { projectDirs = await readdir(root, { withFileTypes: true }); } catch {
    // fail-open-ok: a missing or unreadable optional vendor history directory has no sessions.
    return [];
  }
  const metaFiles: Array<{ chatId: string; path: string }> = [];
  for (const projectDir of projectDirs) {
    if (!projectDir.isDirectory()) continue;
    const projectPath = join(root, projectDir.name);
    let chatDirs;
    try { chatDirs = await readdir(projectPath, { withFileTypes: true }); } catch { continue; }
    for (const chatDir of chatDirs) {
      if (chatDir.isDirectory()) metaFiles.push({ chatId: chatDir.name, path: join(projectPath, chatDir.name, 'meta.json') });
    }
  }
  const sessions: DiscoveredNativeSession[] = [];
  for (const { chatId, path } of metaFiles.slice(0, 200)) {
    let meta: Record<string, unknown>;
    try { meta = JSON.parse(await readFile(path, 'utf8')); } catch { continue; }
    if (workspace && typeof meta.cwd === 'string' && meta.cwd !== workspace) continue;
    sessions.push({
      nativeId: chatId,
      title: typeof meta.title === 'string' ? meta.title : undefined,
      updatedAt: typeof meta.updatedAtMs === 'number' ? new Date(meta.updatedAtMs).toISOString() : undefined,
      updatedAtMs: typeof meta.updatedAtMs === 'number' ? meta.updatedAtMs : undefined,
    });
  }
  return sessions.sort((left, right) => (right.updatedAt ?? '').localeCompare(left.updatedAt ?? '')).slice(0, 15);
}

/** Pi has no listing command at all (`-r`/`/resume` open an interactive
 * picker only) but its own docs describe one JSONL file per session under
 * `~/.pi/agent/sessions/`, organized by working directory, with a custom name
 * settable via `/name`/`--name`. Unlike Claude/Codex/Cursor above, this is
 * sourced from documentation only — Pi isn't installed on any machine this
 * was verified against — so the exact per-directory naming scheme and the
 * field a custom name is stored under are both unconfirmed. Filtering by a
 * `cwd`-like field when one is present (rather than assuming a specific
 * escaping scheme for the directory itself) and duck-typing the name field
 * keeps a wrong guess a silent no-op instead of a wrong result. */
async function discoverPiFsSessions(workspace: string, environment: NativeSessionEnvironment = {}): Promise<DiscoveredNativeSession[]> {
  const configuredRoot = environment.PI_CODING_AGENT_DIR?.trim();
  const root = configuredRoot ? join(configuredRoot, 'sessions') : join(homedir(), '.pi', 'agent', 'sessions');
  const files = await walkFilesRecursive(root, 3, '.jsonl');
  const recent = await newestFiles(files, 15);
  const sessions: DiscoveredNativeSession[] = [];
  for (const file of recent) {
    const nativeId = file.path.split('/').pop()!.replace(/\.jsonl$/, '');
    const prefix = await readFilePrefix(file.path, 8_000).catch(() => '');
    let title: string | undefined;
    let cwd: string | undefined;
    for (const line of prefix.split('\n')) {
      if (!line.trim()) continue;
      let record: Record<string, unknown>;
      try { record = JSON.parse(line); } catch { continue; }
      if (typeof record.cwd === 'string') cwd = record.cwd;
      if (!title && typeof record.name === 'string') title = record.name;
      else if (!title && typeof record.title === 'string') title = record.title;
    }
    if (workspace && cwd && cwd !== workspace) continue;
    sessions.push({ nativeId, title, updatedAt: new Date(file.mtimeMs).toISOString(), updatedAtMs: file.mtimeMs });
  }
  return sessions;
}

/** Only harnesses genuinely observed to store sessions on disk in a
 * predictable, project-scoped way get an entry here — this is deliberately
 * not a declarative catalog field like discoverArgv, because unlike a shell
 * command's argv, each vendor's own on-disk layout (path, format, title
 * source) is a real, unrelated shape with nothing left to normalize. */
export const FS_SESSION_DISCOVERY: Readonly<Record<string, (workspace: string, environment?: NativeSessionEnvironment) => Promise<DiscoveredNativeSession[]>>> = {
  claude: discoverClaudeFsSessions,
  codex: discoverCodexFsSessions,
  cursor: discoverCursorFsSessions,
  pi: discoverPiFsSessions,
};

/** Only wired for the harnesses with a confirmed, complete way to read a
 * whole past conversation back out (not just enough to title it): Claude
 * Code and Codex's own jsonl files, and opencode's real `export` command.
 * Adopting a chat from any other harness still works — its native identity
 * is real either way, and the underlying vendor thread has its own full
 * memory regardless — it just starts blank in ClikCode's own transcript view
 * until the next turn, the same as it did for every harness before this. */
export const ADOPTED_TRANSCRIPT_READERS: Readonly<Record<string, (harness: AiLocalHarnessDefinition, nativeId: string, workspace: string, environment?: NativeSessionEnvironment) => Promise<Array<{ role: 'user' | 'assistant'; content: string }>>>> = {
  claude: (_harness, nativeId, workspace, environment) => readClaudeFsTranscript(nativeId, workspace, environment),
  codex: (_harness, nativeId, workspace, environment) => readCodexFsTranscript(nativeId, workspace, environment),
  opencode: readOpencodeTranscript,
};

function splitTableColumns(line: string): string[] {
  return line.trim().split(/ {2,}/).map((cell) => cell.trim());
}

/** Covers exactly the display formats actually observed from an installed
 * vendor table (opencode: a bare "11:16 AM" clock time for today; Hermes:
 * "yesterday" or a plain "2026-08-21" date) — not a general relative-date
 * parser. Anything else (a weekday name, "3 days ago", Gemini's "N ago" style)
 * returns undefined rather than a guessed value, since a wrong sort position
 * is worse than an honest "can't tell how recent this is". */
function parseDiscoveredTimestamp(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (lower === 'today') return startOfToday.getTime();
  if (lower === 'yesterday') return startOfToday.getTime() - 24 * 60 * 60 * 1000;
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  const clock = /^(\d{1,2}):(\d{2})\s*(am|pm)$/i.exec(trimmed);
  if (clock) {
    let hour = Number(clock[1]) % 12;
    if (clock[3].toLowerCase() === 'pm') hour += 12;
    return startOfToday.getTime() + hour * 60 * 60 * 1000 + Number(clock[2]) * 60 * 1000;
  }
  return undefined;
}

/** Vendor session-list output is a fixed-width table with vendor-chosen column
 * order (opencode puts the id first, Hermes puts it last) — reading the header
 * row to find each column by keyword instead of a hardcoded position is what
 * lets one parser cover every vendor's own layout without a per-vendor branch. */
function parseDiscoveredSessionsText(raw: string): DiscoveredNativeSession[] {
  const lines = raw.split(/\r?\n/).filter((line) => line.trim() && !/^[-─—\s]+$/.test(line));
  if (lines.length < 2) return [];
  const header = splitTableColumns(lines[0]).map((cell) => cell.toLowerCase());
  const idIndex = header.findIndex((cell) => cell === 'id' || cell.endsWith(' id'));
  if (idIndex === -1) return [];
  const titleIndex = header.findIndex((cell) => cell.includes('title') || cell.includes('name'));
  const updatedIndex = header.findIndex((cell) => cell.includes('updated') || cell.includes('active') || cell.includes('modified'));
  const sessions: DiscoveredNativeSession[] = [];
  for (const line of lines.slice(1)) {
    const cells = splitTableColumns(line);
    const nativeId = cells[idIndex];
    if (!nativeId || nativeId === '—' || nativeId === '-') continue;
    const updatedAt = updatedIndex >= 0 ? cells[updatedIndex] : undefined;
    sessions.push({
      nativeId,
      title: titleIndex >= 0 ? cells[titleIndex] : undefined,
      updatedAt,
      updatedAtMs: parseDiscoveredTimestamp(updatedAt),
    });
  }
  return sessions;
}

/** Field names come from two sources of different confidence: Qwen Code's own
 * docs give an exact schema (`sessionId`, `customTitle`, `mtime`/`startTime`)
 * confirmed against its README, and Crush's real Go source gives another
 * (`uuid` as the full resumable id, `id` as a 7-char display hash, `title`,
 * `modified`) confirmed against its repo — both are wired in by name.
 * Everything else here (goose, kilo) is an educated duck-type against common
 * conventions, never confirmed against a live install: a shape that doesn't
 * match one of these names contributes nothing rather than a guessed field. */
function parseDiscoveredSessionsStructured(raw: string, format: 'json' | 'json-lines'): DiscoveredNativeSession[] {
  const records: unknown[] = [];
  try {
    if (format === 'json-lines') {
      for (const line of raw.split(/\r?\n/)) { const trimmed = line.trim(); if (trimmed) records.push(JSON.parse(trimmed)); }
    } else {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) records.push(...parsed);
      else if (parsed && typeof parsed === 'object') {
        const container = Object.values(parsed as Record<string, unknown>).find((value) => Array.isArray(value));
        if (Array.isArray(container)) records.push(...container);
      }
    }
  } catch {
    // fail-open-ok: malformed optional session-list output cannot yield trustworthy resumable ids.
    return [];
  }
  const sessions: DiscoveredNativeSession[] = [];
  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    const item = record as Record<string, unknown>;
    // Crush's own `uuid` (the full resumable id) must win over its `id` (a
    // 7-char display-only hash) when both are present on the same record.
    const nativeId = item.uuid ?? item.id ?? item.sessionId ?? item.session_id ?? item.sessionID;
    if (typeof nativeId !== 'string' || !nativeId) continue;
    const title = item.customTitle ?? item.title ?? item.name ?? item.summary
      ?? (typeof item.prompt === 'string' ? item.prompt : undefined);
    const updatedAt = item.updatedAt ?? item.updated_at ?? item.modified ?? item.mtime ?? item.lastActive ?? item.startTime;
    sessions.push({
      nativeId,
      title: typeof title === 'string' ? title : undefined,
      updatedAt: typeof updatedAt === 'string' ? updatedAt : typeof updatedAt === 'number' ? new Date(updatedAt).toISOString() : undefined,
    });
  }
  return sessions;
}

/** Gemini CLI's `--list-sessions` has no JSON mode — real output is a numbered
 * list, one session per line: "N. Title (relative-time) [uuid-prefix]". The
 * bracketed id is only a shortened prefix (confirmed against Gemini's own
 * docs), not guaranteed to be the full uuid its `--resume` flag can also
 * accept verbatim — the safest resumable value is still whatever the CLI
 * itself printed, so it's used as-is rather than guessed at in full. */
function parseDiscoveredSessionsNumberedList(raw: string): DiscoveredNativeSession[] {
  const sessions: DiscoveredNativeSession[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const match = /^\s*\d+\.\s+(.*?)\s+\(([^)]+)\)\s+\[([a-f0-9-]+)\]\s*$/i.exec(line);
    if (!match) continue;
    const [, title, relativeTime, idFragment] = match;
    sessions.push({ nativeId: idFragment, title: title.trim() || undefined, updatedAt: relativeTime.trim() || undefined });
  }
  return sessions;
}

/** Never installs anything for a passive scan (only harnesses already found on
 * PATH are queried), and never throws — a harness that isn't installed, has
 * no discovery command, or returns something this parser doesn't recognize
 * just contributes zero results instead of failing the whole picker. */
export async function discoverNativeSessions(
  harness: AiLocalHarnessDefinition, environment: Readonly<Record<string, string>>, workspace: string | undefined,
): Promise<DiscoveredNativeSession[]> {
  if (!harness.session?.discoverArgv) return [];
  const inspection = await inspectNativeHarness(harness, 800);
  if (!inspection.installed) return [];
  try {
    const raw = await captureNativeHarnessOutput(harness, harness.session.discoverArgv, environment, 4_000, workspace);
    const format = harness.session.discoverFormat ?? 'json';
    if (format === 'text') return parseDiscoveredSessionsText(raw);
    if (format === 'numbered-list') return parseDiscoveredSessionsNumberedList(raw);
    return parseDiscoveredSessionsStructured(raw, format);
  } catch {
    // fail-open-ok: passive discovery must not break the picker when an optional vendor command fails.
    return [];
  }
}
