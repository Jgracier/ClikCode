/** Where the chat's folder is, said to an agent that cannot be started in it
 * (catalog `turn.ownWorkspace`: OpenClaw). Only what the vendor is sent says
 * so; the chat's own record keeps the request as it was typed. */

import type { AiLocalHarnessDefinition } from '../harness/definition.js';

export function withWorkspaceNote(
  harness: Pick<AiLocalHarnessDefinition, 'turn'>, text: string, workspace: string | undefined,
): string {
  if (!harness.turn?.ownWorkspace || !workspace) return text;
  return `${text}\n\n[ClikCode: this chat's folder is ${workspace}. Read, create and change files there, by absolute path, not in your own workspace.]`;
}
