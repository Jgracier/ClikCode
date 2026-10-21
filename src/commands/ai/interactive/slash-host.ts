/** The slash dispatcher's view of the window: its host, the conversation board picker, redraw, and the `!` shell line. */
import { shellMessageContent, type ShellNote } from '../shell-run.js';
import Conf from 'conf';
import { runNativeHarnessCommand } from '../../../harness/transport/native/command.js';
import { spawnPortable as spawn } from '../../../harness/transport/spawn.js';
import type { HarnessPrompter } from '../../../harness/prompter.js';
import type { HarnessSession } from '../../../session/model.js';
import { readState } from '../../../session/state/read.js';
import { emitHarnessOutput } from '../../../harness/output.js';
import { TerminalHarnessPrompter } from '../../../tui/prompter.js';
import { newConversation } from '../conversations.js';
import { withSlowWait } from '../../../tui/slow-wait.js';
import { runShellLine } from '../../../tui/slash/handlers.js';
import type { SlashHost } from '../../../tui/slash/dispatch.js';
import { browseSearch, walkTurns } from '../../../tui/slash/search-browse.js';
import { interactiveEnginePicker } from '../../../tui/pickers/engine.js';
import { interactiveEffortPicker } from '../../../tui/pickers/effort.js';
import { interactiveModelPicker } from '../../../tui/pickers/model.js';
import { interactiveSessionPicker } from '../../../tui/pickers/session.js';
import type { InteractiveSlashOutcome } from '../../../tui/slash/interactive-keys.js';
import { BOARD_COMMANDS } from './board.js';

async function showSession(terminal: TerminalHarnessPrompter | undefined, target: string): Promise<void> {
  const shown = await readState({ transcripts: [target] });
  const session = shown.sessions.find((item) => item.id === target);
  if (session) terminal?.render(session, session.accountId ? shown.accounts.find((item) => item.id === session.accountId)?.label : undefined);
}

export async function openConversationPicker(
  { config, rl, terminal, beginBuildReplace }: { config: Conf; rl: HarnessPrompter; terminal: TerminalHarnessPrompter | undefined; beginBuildReplace: () => Promise<void> | undefined },
  id: string,
): Promise<InteractiveSlashOutcome> {
  // The board's `/` sets up the NEXT conversation. A fresh one is
  // made the first time it is used, so choosing its provider never
  // hands off the chat that was open; if nothing is sent it stays
  // blank, and blank chats are not listed or kept.
  let fresh: string | undefined;
  for (;;) {
    const picked = await interactiveSessionPicker(rl, fresh ?? id, BOARD_COMMANDS, {
      // Running rows were on screen and have finished, and the
      // composer is empty. Leave only when a newer build is waiting.
      onSessionsSettled: () => Boolean(beginBuildReplace()),
    });
    if (picked && 'command' in picked) {
      fresh ??= await newConversation(id, { sameModel: true });
      if (picked.command === '/provider') fresh = await interactiveEnginePicker(config, rl, fresh) ?? fresh;
      else if (picked.command === '/model') await interactiveModelPicker(rl, fresh);
      else if (picked.command === '/effort') await interactiveEffortPicker(rl, fresh);
      await showSession(terminal, fresh);
      continue;
    }
    if (picked && 'notice' in picked) {
      if (fresh) await showSession(terminal, id);
      return { id, notice: picked.notice };
    }
    if (picked && 'compose' in picked) return { id: fresh ?? await newConversation(id, { sameModel: true }), prompt: picked.compose, echo: true };
    if (picked && 'new' in picked) return { id: fresh ?? await newConversation(id, { sameModel: true }) };
    if (picked) return { id: picked.id, ...(picked.draft ? { draft: picked.draft } : {}) };
    // Closed: back where it was, including the line that names the
    // provider, which showed the fresh chat's while it was set up.
    if (fresh) await showSession(terminal, id);
    return { id };
  }
}

/** `!<command>` typed in the chat: run it here, and draw the exchange. */
export async function runShellInChat(terminal: TerminalHarnessPrompter | undefined, id: string, command: string, lastSeen: HarnessSession): Promise<void> {
  const controller = new AbortController();
  // The command line is drawn at once, as a sent message is; the band
  // only if it runs long enough to need one.
  // As it is saved (shellMessageContent), so reopening draws the same row.
  terminal?.submitted(`!${command}`);
  terminal?.render(lastSeen, undefined, { running: false });
  let result: ShellNote;
  try {
    result = await withSlowWait(terminal, `! ${command}`, () => runShellLine(id, command, controller.signal), () => controller.abort());
  } finally {
    terminal?.submitted(undefined);
  }
  // The run is a transcript message -- command, output, exit -- which
  // the terminal draws with the conversation; a notice repeating its
  // exit said it twice. Without a terminal nothing draws it.
  if (!terminal) emitHarnessOutput({ panel: 'shell', text: shellMessageContent(result) });
}

/** What the slash dispatcher may do to this window: panels, pickers, turns, the editor and the vendor's own manager commands. */
export function createSlashHost(
  { config, rl, terminal, runTurn, openConversationPicker: openPicker }: {
    config: Conf; rl: HarnessPrompter; terminal: TerminalHarnessPrompter | undefined;
    runTurn: (targetId: string, promptText: string) => Promise<void>;
    openConversationPicker: () => Promise<InteractiveSlashOutcome>;
  },
): SlashHost {
  /** A subprocess the user has to wait for gets the same waiting
   * indicator a turn does -- once it is slow enough to see. */
  const withWaiting = <T>(label: string, work: () => Promise<T>): Promise<T> => withSlowWait(terminal, label, work);
return {
    config, prompter: rl, canPick: Boolean(terminal),
    panel: (kind, title, body, plain) => {
      if (terminal) terminal.panel(title, body);
      else emitHarnessOutput({ panel: kind, text: plain });
    },
    withBusy: withWaiting,
    ask: (label) => rl.question(`${label} › `, undefined, { cancellable: true }).catch((error: unknown) => {
      if ((error as { code?: string }).code === 'ERR_PROMPT_CANCELLED') return undefined;
      throw error;
    }),
    redraw: (target) => showSession(terminal, target),
    runTurn,
    openConversationPicker: openPicker,
    editFile: async (path, cwd) => {
      const editor = process.env.VISUAL || process.env.EDITOR || (process.platform === 'win32' ? 'notepad' : 'vi');
      const [editorBinary = 'vi', ...editorArgs] = editor.split(/\s+/).filter(Boolean);
      await terminal?.suspend();
      try {
        await new Promise<void>((resolveEdit, rejectEdit) => {
          const child = spawn(editorBinary, [...editorArgs, path], { stdio: 'inherit', cwd });
          child.once('error', rejectEdit);
          child.once('exit', () => resolveEdit());
        });
      } finally { terminal?.resume(); }
    },
    ...(terminal ? {
      runManager: async (harness, _label, argv, environment) => {
        await terminal.suspend();
        try { await runNativeHarnessCommand(harness, argv, environment); } finally { terminal.resume(); }
      },
    } satisfies Pick<SlashHost, 'runManager'> : {
      attached: (attachments) => emitHarnessOutput({ panel: 'attachments', attachments }),
    } satisfies Pick<SlashHost, 'attached'>),
    ...(terminal ? {
      browseSearch: (query: string) => browseSearch(terminal, query, withWaiting),
      walkTurns: (turns, start) => walkTurns(terminal, turns, start),
    } satisfies Pick<SlashHost, 'browseSearch' | 'walkTurns'> : {}),
  };
}
