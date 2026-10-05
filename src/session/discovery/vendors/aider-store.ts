/** Aider: the conversation is the markdown chat history file ClikCode hands
 * it, `<ClikCode state>/native/aider/<name>.history.md` -- ClikCode's own
 * file (turn/vendor-cli-attempt.ts mints it, `idKind: 'history-file'`), never
 * the `.aider.chat.history.md` in the user's workspace. The file's path IS
 * the native id: a turn passes `--chat-history-file <id>
 * --restore-chat-history`, and Aider reads the file back as the
 * conversation (utils.split_chat_history_markdown).
 *
 * The file is not per account (Aider has no profile directory), so the root
 * is the same under every environment and a failover never moves it. This
 * store exists for the writer only. */

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { CanonicalRecord, CanonicalToolCall } from '../../canonical.js';
import { stateDirectory } from '../../store/paths.js';
import type { NativeSessionStore, NativeThreadWriter } from '../stores.js';
import { callResultText, requestText, testedVersion, writeFileAtomic } from './thread-writer-files.js';

function aiderRoot(): string {
  return join(stateDirectory(), 'native', 'aider');
}

/** A line Aider would not read back as the assistant's: `# ` lines are
 * skipped, `> ` lines are its own tool notices (dropped), `#### ` lines are
 * the user's. One leading space keeps them the assistant's text. */
function assistantLine(line: string): string {
  return /^(# |> |####)/.test(line) ? ` ${line}` : line;
}

/** Aider has no tool calls: a call is told as text -- its row, then its
 * result indented as a code block, so no line of it can read as a user line
 * or a notice. */
function aiderCallText(call: CanonicalToolCall): string {
  const status = call.status === 'failed' ? ' (failed)' : call.status === 'unfinished' ? ' (unfinished)' : '';
  return `[${call.label}]${status}\n${callResultText(call).split('\n').map((line) => `    ${line}`).join('\n')}`;
}

/** The conversation as Aider 0.86 writes its chat history: a `# aider chat
 * started at` heading, each request as `#### ` lines (each ending in two
 * spaces, as Aider's own user_input writes them), each answer as plain
 * markdown after a blank line (ai_output). */
export function aiderHistoryMarkdown(record: CanonicalRecord, now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  const started = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  let text = `\n# aider chat started at ${started}\n\n`;
  for (const turn of record.turns) {
    const request = requestText(turn);
    if (request.trim()) text += `\n${request.split('\n').map((line) => `#### ${line || '<blank>'}  `).join('\n')}\n`;
    const answer = turn.parts.map((part) => (part.type === 'text' ? part.text.trim() : aiderCallText(part.call)))
      .filter(Boolean).join('\n\n');
    if (answer.trim()) text += `\n${answer.split('\n').map(assistantLine).join('\n')}\n\n`;
  }
  return text;
}

/** Verified against Aider 0.86.2 (2026-10-04, vendor-sandbox): a history
 *  written here, resumed the way ClikCode resumes Aider (`--chat-history-file
 *  <id> --restore-chat-history --message ...`, OpenRouter
 *  gemini-2.5-flash-lite), printed "Restored previous conversation history."
 *  and answered "The codeword was PELICAN-73, and I read notes.txt and
 *  changed src/app.ts." Text only: the calls reach Aider as the answer's
 *  text, which is all its history holds. */
export const aiderThreadWriter: NativeThreadWriter = {
  testedVersions: ['0.86.2'],
  versionOk: testedVersion(['0.86.2']),
  async write(record) {
    if (!record.turns.length) return undefined;
    const path = join(aiderRoot(), `${randomUUID()}.history.md`);
    await writeFileAtomic(path, aiderHistoryMarkdown(record, new Date()));
    return { nativeId: path };
  },
};

export const aiderSessionStore: NativeSessionStore = {
  root: aiderRoot,
  writer: aiderThreadWriter,
};
