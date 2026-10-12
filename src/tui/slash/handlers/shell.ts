/** `!<command>`: running a shell line in the conversation's workspace and recording it. */
import { readState } from '../../../session/state/read.js';
import { writeState } from '../../../session/state/write.js';
import { runShellCommand, shellMessageContent, type ShellNote } from '../../../commands/ai/shell-run.js';

/** `!<command>`: run exactly what was typed in the chat's workspace, and
 * record its output as a transcript message (so the model sees it next turn)
 * and a shell note (so a resumed native-harness thread, which never replays
 * ClikCode's transcript, still does; see shellContextBlock in
 * turn/session-turn.ts). `signal` kills the command's process tree. */
export async function runShellLine(id: string, command: string, signal?: AbortSignal, options: { timeoutMs?: number } = {}): Promise<ShellNote> {
  const workspace = (await readState({ transcripts: [] })).sessions.find((item) => item.id === id)?.workspace ?? process.cwd();
  const result = await runShellCommand(command, workspace, signal, options);
  const note: ShellNote = { command, output: result.output, exitCode: result.exitCode, at: new Date().toISOString() };
  const state = await readState({ transcripts: [id] });
  const session = state.sessions.find((item) => item.id === id);
  if (!session) throw new Error(`AI session "${id}" was not found`);
  session.messages = [...(session.messages ?? []), { role: 'user', content: shellMessageContent(note) }];
  session.shellNotes = [...(session.shellNotes ?? []), note];
  session.updatedAt = new Date().toISOString();
  await writeState(state);
  return note;
}
