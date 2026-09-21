/** `/export`: the conversation as Markdown, written where the user asked. */

import { stat, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { isJsonDefaultMode } from '../../cli/output-mode.js';
import type { HarnessSession } from '../../harness/types.js';
import { compactPath, sessionProviderLabel } from '../../harness/protocol/labels.js';
import { decodeAttachmentPath, expandHomePath } from '../../session/attachments.js';
import { sessionTranscriptMessages } from '../../turn/checkpoint.js';

function transcriptMarkdown(session: HarnessSession): string {
  const title = session.name ?? `ClikCode conversation ${session.id.slice(0, 8)}`;
  const header = [
    `# ${title}`, '',
    `- Provider: ${sessionProviderLabel(session)}`,
    `- Model: ${session.model ?? 'provider default'}`,
    `- Workspace: ${session.workspace ?? process.cwd()}`,
    `- Exported: ${new Date().toISOString()}`, '',
  ];
  const body = sessionTranscriptMessages(session).flatMap((message) => [`## ${message.role === 'assistant' ? 'Assistant' : 'You'}`, '', message.content.trim(), '']);
  return `${[...header, ...body].join('\n').trimEnd()}\n`;
}

/** Never overwrites silently: `confirmOverwrite` decides (a prompt in the TUI,
 * `--force` headless). */
export async function exportTranscript(session: HarnessSession, target: string, confirmOverwrite: (path: string) => Promise<boolean>): Promise<string> {
  const workspace = session.workspace ?? process.cwd();
  const requested = expandHomePath(decodeAttachmentPath(target.trim() || `clikcode-${session.id.slice(0, 8)}.md`));
  const path = isAbsolute(requested) ? resolve(requested) : resolve(workspace, requested);
  const existing = await stat(path).catch(() => undefined);
  if (existing?.isDirectory()) throw new Error(`${compactPath(path)} is a directory; give a file name.`);
  if (existing && !await confirmOverwrite(path)) throw new Error(`${compactPath(path)} already exists; not overwritten. Choose another path${isJsonDefaultMode() ? ' or pass --force' : ''}.`);
  await writeFile(path, transcriptMarkdown(session), { encoding: 'utf8', mode: 0o600 });
  return path;
}
