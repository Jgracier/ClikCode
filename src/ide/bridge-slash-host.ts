/** The editor as the screen a slash command runs for, and /search's screen in it. */
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { emitHarnessOutput } from '../harness/output.js';
import { newConversation } from '../commands/ai/conversations.js';
import { interactiveSessionPicker } from '../tui/pickers/session.js';
import { slashExtrasFor } from '../tui/slash/context.js';
import { slashControls, slashHelpText, TERMINAL_ONLY_COMMANDS } from '../tui/slash/registry.js';
import { lastAnswer } from '../tui/slash/handlers.js';
import { browseSearch, walkTurns, type MentionScreen } from '../tui/slash/search-browse.js';
import type { SlashHost } from '../tui/slash/dispatch.js';
import type { BridgeHost } from './bridge-host.js';
import type { BridgeTurns } from './bridge-turns.js';

/** /search's screen in the editor: each mention opens its conversation
 * there (a `search` event says where); the editor's keys come back as
 * `search-key`. */
export function searchScreen(host: BridgeHost): MentionScreen {
  let shown: Promise<void> = Promise.resolve();
  return {
    showMention: (session, focus) => {
      shown = shown.then(async () => {
        if (session.id !== host.sessionId) await host.switchTo(session.id);
        host.channel.send({ type: 'search', focus: {
          sessionId: session.id, messageIndex: focus.messageIndex, occurrence: focus.occurrence, words: [...focus.words], status: focus.status ?? '',
        } });
      });
    },
    mentionKey: async () => {
      await shown;
      if (host.closed) return 'done';
      return new Promise((resolve) => { host.setSearchKey(resolve); });
    },
    endMention: () => {
      host.setSearchKey(undefined);
      host.channel.send({ type: 'search' });
    },
  };
}

/** The editor as the screen a slash command runs for. */
export function createSlashHost(host: BridgeHost, turns: Pick<BridgeTurns, 'withBusy' | 'runTurn'>): SlashHost {
  return {
    config: host.config,
    prompter: host.prompter,
    canPick: true,
    pickProviderBeforeSending: true,
    panel: (_kind, title, body) => host.prompter.panel(title, body),
    withBusy: (label, work) => turns.withBusy(label, work),
    ask: (label) => host.prompter.question(label),
    redraw: () => host.emitSession(),
    runTurn: (targetId, prompt) => turns.runTurn(targetId, prompt, { echo: false }),
    openConversationPicker: async (id) => {
      const picked = await interactiveSessionPicker(host.prompter, id);
      if (picked && 'new' in picked) return { id: await newConversation(id) };
      return { id: picked?.id ?? id };
    },
    editFile: async (path) => {
      if (!existsSync(path)) {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, '', { flag: 'a' });
      }
      host.channel.send({ type: 'open-file', path });
    },
    runManager: (harness, label, argv, environment) =>
      host.runInTerminal({ command: harness.command, mode: 'run', argv }, { environment, name: `${harness.displayName} ${label}` }),
    exported: (path) => host.channel.send({ type: 'open-file', path }),
    // The terminal's walk, where the editor can show it.
    ...(host.features.has('search-walk') ? {
      browseSearch: (query: string) => browseSearch(searchScreen(host), query, (label, work) => turns.withBusy(label, work)),
      walkTurns: (turns, start) => walkTurns(searchScreen(host), turns, start),
    } satisfies Pick<SlashHost, 'browseSearch' | 'walkTurns'> : {}),
    intercept: (route, session, harness) => {
      const name = route.entry.name;
      if (TERMINAL_ONLY_COMMANDS.has(name)) return { notice: `/${name} is for the terminal; the editor has no use for it.` };
      if (name === 'help') {
        emitHarnessOutput({ panel: 'help', helpText: slashHelpText(session, harness, { ...slashExtrasFor(session, harness), omit: TERMINAL_ONLY_COMMANDS }), controls: slashControls() });
        return {};
      }
      // The editor's own clipboard: the bridge's machine may not be the
      // one the user is at (Remote-SSH), and has no terminal for OSC 52.
      if (name === 'copy' && host.features.has('copy')) {
        host.channel.send({ type: 'copy', text: lastAnswer(session) });
        return { notice: 'Last response copied to the clipboard.' };
      }
      return undefined;
    },
  };
}
