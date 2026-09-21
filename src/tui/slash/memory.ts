/** The project memory file: where it is, how it is read, and the prompts
 * that write to it. */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HarnessSession } from '../../session/model.js';
import { sessionHarness } from './context.js';

function memoryFileName(session: HarnessSession): string {
  return sessionHarness(session)?.memoryFile ?? 'AGENTS.md';
}

export function initPrompt(session: HarnessSession): string {
  const file = memoryFileName(session);
  return `Inspect this repository and create or improve ${file} with concise, accurate build, test, architecture, and contribution instructions for coding agents. Verify every command you include.`;
}

export function reviewPrompt(extra: string): string {
  return `Review the uncommitted changes in this workspace. Identify concrete bugs, regressions, security issues, and missing tests. Prioritize findings and cite file paths.${extra ? ` Additional focus: ${extra}` : ''}`;
}

export async function readMemoryFile(session: HarnessSession): Promise<{ path: string; content?: string }> {
  const path = join(session.workspace ?? process.cwd(), memoryFileName(session));
  try {
    return { path, content: (await readFile(path, 'utf8')).slice(0, 256 * 1024) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path };
    throw error;
  }
}
