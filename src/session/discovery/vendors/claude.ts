/** Claude Code's own session history: project directories, and the JSONL
 * transcripts inside them. */

import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { cachedDirectory, discoveryCacheChanged, saveDiscoveryCache } from '../cache.js';
import { newestFiles, readFilePrefix, readFileSuffix } from '../files.js';
import { type NativeSessionEnvironment, nativeDataRoot } from '../stores.js';
import { conversationTitle } from '../conversation-title.js';
import { ADOPTED_TRANSCRIPT_LIMIT, extractMessageText, leadingText, visibleNativeUserText } from '../transcript.js';
import { isClikCodeOpening } from '../../../turn/failover-prompt.js';
import { DiscoveredNativeSession } from '../discovered-session.js';

/** Claude Code names a project folder by replacing EVERY non-alphanumeric
 * character of the cwd with `-` -- verified against real folders:
 * `/home/u/.cache/x` is `-home-u--cache-x` and `/w/.claude/worktrees` is
 * `-w--claude-worktrees`. Replacing only `/` (the earlier mapping) missed any
 * workspace with a dot, underscore or space in its path. The earlier mapping
 * is still tried second in case a build of Claude Code used it. */
export function claudeProjectDirectoryNames(workspace: string): string[] {
  return [...new Set([workspace.replace(/[^a-zA-Z0-9]/g, '-'), workspace.replace(/\//g, '-')])];
}

function claudeProjectRoot(environment: NativeSessionEnvironment): string {
  return join(nativeDataRoot(environment, 'CLAUDE_CONFIG_DIR', join(homedir(), '.claude')), 'projects');
}

function claudeProjectDirectories(workspace: string, environment: NativeSessionEnvironment): string[] {
  return claudeProjectDirectoryNames(workspace).map((name) => join(claudeProjectRoot(environment), name));
}

/** Every project folder, for discovery across all workspaces (`''`). */
async function allClaudeProjectDirectories(environment: NativeSessionEnvironment): Promise<string[]> {
  const root = claudeProjectRoot(environment);
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => join(root, entry.name));
}

/** The folder a chat ran in: every Claude Code record carries `cwd`. */
async function claudeSessionCwd(path: string): Promise<string | undefined> {
  const head = await readFilePrefix(path, 16_000).catch(() => '');
  return /"cwd":"((?:[^"\\]|\\.)+)"/.exec(head)?.[1]?.replace(/\\(.)/g, '$1');
}

/** The chat's name for the resume list, and whether it is a real one.
 *
 * Reads the tail as well as the head: Claude writes its ai-title record a turn
 * or two in, which on real transcripts sat as far as 66KB from the start --
 * past this prefix -- while the newest copy is always near the end. */
async function claudeSessionTitle(path: string): Promise<{ title?: string; generated?: boolean; byClikCode: boolean }> {
  const tail = await readFileSuffix(path, 64_000).catch(() => '');
  let generated: string | undefined;
  for (const line of tail.split('\n')) {
    if (!line.includes('ai-title')) continue;
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      if (record.type === 'ai-title' && typeof record.aiTitle === 'string' && record.aiTitle.trim()) generated = record.aiTitle.trim();
    } catch { /* a partial line at the window edge is not a record. */ }
  }
  const prefix = await readFilePrefix(path, 8_000).catch(() => '');
  // The first user message, for the title; and the first thing sent, whose
  // opening says whose thread this is -- that can be a queued prompt Claude
  // records before the message itself.
  let first: string | undefined;
  let opening: string | undefined;
  for (const line of prefix.split('\n')) {
    if (!line.trim()) continue;
    let text: string;
    let queued = false;
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      queued = record.type === 'queue-operation' && record.operation === 'enqueue';
      if (record.type !== 'user' && !queued) continue;
      text = visibleNativeUserText(queued ? (typeof record.content === 'string' ? record.content : '') : extractMessageText((record.message as { content?: unknown } | undefined)?.content));
    } catch {
      // A transfer prompt is the whole conversation in one line, cut off by
      // the prefix; its opening is still in the cut line.
      queued = /"type"\s*:\s*"queue-operation"/.test(line) && line.includes('"enqueue"');
      if (!queued && !/"type"\s*:\s*"user"|"role"\s*:\s*"user"/.test(line)) continue;
      text = visibleNativeUserText(leadingText(line) ?? '');
    }
    // Claude Code also injects synthetic wrapper turns (e.g. a
    // "<local-command-caveat>" note about a slash command's own output) as
    // literal role:"user" messages — the same reason Codex's fallback
    // skips anything starting with "<".
    if (!text) continue;
    opening ??= text;
    if (!queued) { first = text; break; }
  }
  const byClikCode = !!opening && isClikCodeOpening(opening);
  if (generated) return { title: generated, generated: true, byClikCode };
  return { ...(first ? { title: conversationTitle(first) } : {}), byClikCode };
}

export async function discoverClaudeFsSessions(workspace: string, environment: NativeSessionEnvironment = {}): Promise<DiscoveredNativeSession[]> {
  const sessions: DiscoveredNativeSession[] = [];
  const everywhere = !workspace;
  for (const dir of everywhere ? await allClaudeProjectDirectories(environment) : claudeProjectDirectories(workspace, environment)) {
    const listing = await cachedDirectory(dir, '.jsonl');
    if (!listing) continue;
    const recent = await newestFiles(Object.keys(listing.files).map((name) => join(dir, name)), 15);
    for (const file of recent) {
      const name = basename(file.path);
      const facts = listing.files[name] ?? {};
      // A title can appear after the first scan (the ai-title record is written
      // once Claude has named the chat), so it is keyed to the file's mtime.
      if (facts.mtimeMs !== file.mtimeMs || (everywhere && facts.cwd === undefined) || facts.byClikCode === undefined) {
        const read = await claudeSessionTitle(file.path);
        const cwd = everywhere ? await claudeSessionCwd(file.path) : facts.cwd;
        listing.files[name] = { title: read.title, generated: read.generated, byClikCode: read.byClikCode, mtimeMs: file.mtimeMs, ...(cwd ? { cwd } : {}) };
        discoveryCacheChanged();
      }
      const known = listing.files[name]!;
      sessions.push({
        nativeId: name.replace(/\.jsonl$/, ''), title: known.title,
        ...(known.generated ? { titleIsGenerated: true } : {}),
        ...(known.byClikCode ? { byClikCode: true } : {}),
        updatedAt: new Date(file.mtimeMs).toISOString(), updatedAtMs: file.mtimeMs,
        ...(known.cwd ? { workspace: known.cwd } : {}),
      });
    }
    if (sessions.length && !everywhere) break;
  }
  await saveDiscoveryCache();
  // Across every folder, the newest few overall -- not fifteen per folder.
  return everywhere ? sessions.sort((left, right) => (right.updatedAtMs ?? 0) - (left.updatedAtMs ?? 0)).slice(0, 30) : sessions;
}

/** Reads every user/assistant turn from a Claude Code session's own jsonl file
 * (not just the prefix scanned for a title) and maps it onto ClikCode's own
 * {role, content} message shape, so adopting a Claude Code chat shows its
 * real prior conversation instead of starting the ClikCode view blank while
 * only the native thread underneath actually remembers anything. Capped to
 * the most recent messages:
 * an adoption is a one-time read, not something that should scale with a
 * session's total lifetime size. */
export async function readClaudeFsTranscript(nativeId: string, workspace: string, environment: NativeSessionEnvironment = {}): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
  let raw: string | undefined;
  for (const dir of claudeProjectDirectories(workspace, environment)) {
    // fail-open-ok: an optional native transcript that disappeared during discovery contributes no messages.
    raw = await readFile(join(dir, `${nativeId}.jsonl`), 'utf8').catch(() => undefined);
    if (raw !== undefined) break;
  }
  if (raw === undefined) return [];
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
