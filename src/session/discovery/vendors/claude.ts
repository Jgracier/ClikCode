/** Claude Code's own session history: project directories, and the JSONL
 * transcripts inside them. */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { cachedDirectory, discoveryCache, saveDiscoveryCache } from '../cache.js';
import { newestFiles, readFilePrefix, readFileSuffix } from '../files.js';
import { NativeSessionEnvironment, nativeDataRoot } from '../locations.js';
import { conversationTitle } from '../titles.js';
import { ADOPTED_TRANSCRIPT_LIMIT, extractMessageText, visibleNativeUserText } from '../transcript.js';
import { DiscoveredNativeSession } from '../types.js';

/** Claude Code names a project folder by replacing EVERY non-alphanumeric
 * character of the cwd with `-` -- verified against real folders:
 * `/home/u/.cache/x` is `-home-u--cache-x` and `/w/.claude/worktrees` is
 * `-w--claude-worktrees`. Replacing only `/` (the earlier mapping) missed any
 * workspace with a dot, underscore or space in its path. The earlier mapping
 * is still tried second in case a build of Claude Code used it. */
export function claudeProjectDirectoryNames(workspace: string): string[] {
  return [...new Set([workspace.replace(/[^a-zA-Z0-9]/g, '-'), workspace.replace(/\//g, '-')])];
}

function claudeProjectDirectories(workspace: string, environment: NativeSessionEnvironment): string[] {
  const root = join(nativeDataRoot(environment, 'CLAUDE_CONFIG_DIR', join(homedir(), '.claude')), 'projects');
  return claudeProjectDirectoryNames(workspace).map((name) => join(root, name));
}

/** The chat's name for the resume list, and whether it is a real one.
 *
 * Reads the tail as well as the head: Claude writes its ai-title record a turn
 * or two in, which on real transcripts sat as far as 66KB from the start --
 * past this prefix -- while the newest copy is always near the end. */
async function claudeSessionTitle(path: string): Promise<{ title?: string; generated?: boolean }> {
  const tail = await readFileSuffix(path, 64_000).catch(() => '');
  let generated: string | undefined;
  for (const line of tail.split('\n')) {
    if (!line.includes('ai-title')) continue;
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      if (record.type === 'ai-title' && typeof record.aiTitle === 'string' && record.aiTitle.trim()) generated = record.aiTitle.trim();
    } catch { /* a partial line at the window edge is not a record. */ }
  }
  if (generated) return { title: generated, generated: true };
  const prefix = await readFilePrefix(path, 8_000).catch(() => '');
  let title: string | undefined;
  for (const line of prefix.split('\n')) {
    if (!line.trim()) continue;
    let record: Record<string, unknown>;
    try { record = JSON.parse(line); } catch { continue; }
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
  return { title };
}

export async function discoverClaudeFsSessions(workspace: string, environment: NativeSessionEnvironment = {}): Promise<DiscoveredNativeSession[]> {
  const sessions: DiscoveredNativeSession[] = [];
  for (const dir of claudeProjectDirectories(workspace, environment)) {
    const listing = await cachedDirectory(dir, '.jsonl');
    if (!listing) continue;
    const recent = await newestFiles(Object.keys(listing.files).map((name) => join(dir, name)), 15);
    for (const file of recent) {
      const name = basename(file.path);
      const facts = listing.files[name] ?? {};
      // A title can appear after the first scan (the ai-title record is written
      // once Claude has named the chat), so it is keyed to the file's mtime.
      if (facts.mtimeMs !== file.mtimeMs) {
        const read = await claudeSessionTitle(file.path);
        listing.files[name] = { title: read.title, generated: read.generated, mtimeMs: file.mtimeMs };
        discoveryCache!.dirty = true;
      }
      sessions.push({
        nativeId: name.replace(/\.jsonl$/, ''), title: listing.files[name]!.title,
        ...(listing.files[name]!.generated ? { titleIsGenerated: true } : {}),
        updatedAt: new Date(file.mtimeMs).toISOString(), updatedAtMs: file.mtimeMs,
      });
    }
    if (sessions.length) break;
  }
  await saveDiscoveryCache();
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
