/** Cursor's stored conversations. */

import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { newestFiles } from '../files.js';
import { NativeSessionEnvironment, nativeDataRoot } from '../locations.js';
import { DiscoveredNativeSession } from '../types.js';

/** Cursor Agent's own `ls`/`--resume` are interactive pickers with no JSON
 * mode, but each chat has a real `meta.json` (schemaVersion, title, cwd,
 * updatedAtMs) under `~/.cursor/chats/<project-hash>/<chat-uuid>/` — the
 * chat-uuid directory name is exactly the id its `--resume <chatId>` expects. */
export async function discoverCursorFsSessions(workspace: string, environment: NativeSessionEnvironment = {}): Promise<DiscoveredNativeSession[]> {
  // Cursor Agent has no profile variable of its own; an account isolated by a
  // redirected HOME keeps its chats under that HOME.
  const root = join(nativeDataRoot(environment, 'HOME', homedir()), '.cursor', 'chats');
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
  // Newest first BEFORE the cap. Directory order is arbitrary, so capping first
  // dropped recent chats at random once a user had more than 200.
  const chatIdByPath = new Map(metaFiles.map((item) => [item.path, item.chatId]));
  const recent = await newestFiles(metaFiles.map((item) => item.path), 200);
  const sessions: DiscoveredNativeSession[] = [];
  for (const { path, mtimeMs } of recent) {
    let meta: Record<string, unknown>;
    try { meta = JSON.parse(await readFile(path, 'utf8')); } catch { continue; }
    if (workspace && typeof meta.cwd === 'string' && meta.cwd !== workspace) continue;
    const updatedAtMs = typeof meta.updatedAtMs === 'number' ? meta.updatedAtMs : mtimeMs;
    sessions.push({
      nativeId: chatIdByPath.get(path)!,
      title: typeof meta.title === 'string' ? meta.title : undefined,
      updatedAt: new Date(updatedAtMs).toISOString(),
      updatedAtMs,
    });
  }
  return sessions.sort((left, right) => (right.updatedAtMs ?? 0) - (left.updatedAtMs ?? 0)).slice(0, 15);
}
