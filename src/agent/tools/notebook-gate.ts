/** notebook_edit is offered only where notebooks are in play: its spec is
 * ~220 tokens on every request, and most workspaces have no .ipynb at all.
 *
 * Two facts decide it, re-evaluated per step:
 *   - the workspace held a notebook when scanned. The scan is bounded and
 *     cached per directory identity (path, device, inode and the listing's
 *     mtime), never a clock: the same directory is walked once per process,
 *     again only when its top level changes.
 *   - the conversation mentions one (".ipynb" in a message, a call's
 *     arguments or a tool's output). That covers a notebook created during
 *     the session (write_file, bash, the user naming one) without walking the
 *     tree again: whatever made it put its name in the conversation.
 * Either is sticky in practice (the mention stays in the conversation), so
 * the tool list changes at most once per session and the prompt prefix
 * holds otherwise. The tool stays callable either way; only its spec is
 * left out. */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { ConversationItem } from '../model-client.js';
import type { ToolDefinition } from '../tool-contract.js';

export const NOTEBOOK_TOOL = 'notebook_edit';

/** Entries visited before giving up. A tree this large is offered the tool:
 * not knowing is treated as the behaviour before the gate. */
const SCAN_ENTRY_LIMIT = 20_000;
const SCAN_DEPTH = 8;
const SKIPPED_DIRS = new Set(['node_modules', '__pycache__']);

const scans = new Map<string, Promise<boolean>>();

async function scan(root: string): Promise<boolean> {
  let visited = 0;
  let level = [root];
  for (let depth = 0; depth <= SCAN_DEPTH && level.length; depth += 1) {
    const next: string[] = [];
    for (const dir of level) {
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        continue; // unreadable directories hold nothing we could edit
      }
      for (const entry of entries) {
        if (++visited > SCAN_ENTRY_LIMIT) return true;
        if (entry.isFile() && entry.name.toLowerCase().endsWith('.ipynb')) return true;
        if (entry.isDirectory() && !entry.name.startsWith('.') && !SKIPPED_DIRS.has(entry.name)) next.push(path.join(dir, entry.name));
      }
    }
    level = next;
  }
  return false;
}

/** Whether any of the directories holds a notebook, cached per directory
 * identity. */
export async function workspaceHasNotebooks(dirs: readonly string[]): Promise<boolean> {
  for (const dir of dirs) {
    let key: string;
    try {
      const stat = await fs.stat(dir);
      key = `${dir}\0${stat.dev}:${stat.ino}:${stat.mtimeMs}`;
    } catch {
      continue;
    }
    let found = scans.get(key);
    if (!found) {
      found = scan(dir);
      scans.set(key, found);
    }
    if (await found) return true;
  }
  return false;
}

const NOTEBOOK_MENTION = /\.ipynb\b/i;

function mentionsNotebook(item: ConversationItem): boolean {
  switch (item.type) {
    case 'text': case 'summary': return NOTEBOOK_MENTION.test(item.text);
    case 'tool_call': return NOTEBOOK_MENTION.test(JSON.stringify(item.args));
    case 'tool_result': return NOTEBOOK_MENTION.test(item.output);
  }
}

/** The tools to advertise this step: without notebook_edit unless the
 * workspace or the conversation has a notebook in it. */
export function gateNotebookTool<T extends Pick<ToolDefinition, 'name'>>(tools: readonly T[], items: readonly ConversationItem[], workspaceHasNotebook: boolean): T[] {
  if (workspaceHasNotebook || !tools.some((tool) => tool.name === NOTEBOOK_TOOL) || items.some(mentionsNotebook)) return [...tools];
  return tools.filter((tool) => tool.name !== NOTEBOOK_TOOL);
}

/** For tests: forget every scan. */
export function resetNotebookScans(): void {
  scans.clear();
}
