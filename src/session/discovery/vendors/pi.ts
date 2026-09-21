/** Pi's stored conversations. */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { newestFiles, readFilePrefix, walkFilesRecursive } from '../files.js';
import { NativeSessionEnvironment } from '../locations.js';
import { DiscoveredNativeSession } from '../types.js';

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
export async function discoverPiFsSessions(workspace: string, environment: NativeSessionEnvironment = {}): Promise<DiscoveredNativeSession[]> {
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
