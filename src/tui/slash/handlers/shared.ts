/** What every headless slash handler shares: the context it is called with, the shared helpers that save settings and send a turn. */
import type { HarnessSession, HarnessState } from '../../../session/model.js';
import { writeState } from '../../../session/state/write.js';
import Conf from 'conf';
import { sendScriptedTurn } from '../../../worker/scripted-send.js';
import { emitHarnessOutput } from '../../../harness/output.js';

/** What one slash command did, for a caller that must follow it. */
export interface HeadlessSlashContext {
  id: string; state: HarnessState; session: HarnessSession;
  /** Canonical registry name (aliases already resolved). */
  head: string; args: string; words: string[];
}

/** Resolves with the resulting session id when the command moved the
 * conversation to another session (`/new`, `/fork`), otherwise nothing. */
export type HeadlessSlashHandler = (context: HeadlessSlashContext) => Promise<string | void>;

export const INTERACTIVE_ONLY = (name: string): HeadlessSlashHandler => async () => {
  throw new Error(`/${name} opens a picker and is only available in the interactive ClikCode session.`);
};

/** A turn a slash command sends, through the conversation's worker when one
 * is running -- any route, the Gateway and ClikCode Local included. */
export const sendSessionTurn = (id: string, prompt: string): Promise<void> => (
  sendScriptedTurn(new Conf({ projectName: 'clikcode', configFileMode: 0o600 }), id, prompt)
);

/** A setting changed: stamp the session, store the state, and show the
 * settings panel -- in the terminal, the status line it re-renders. */
export async function saveSettings(state: HarnessState, session: HarnessSession): Promise<void> {
  // A chat that moved to another machine goes on there: this copy's settings are not its any more.
  if (session.movedTo) throw new Error(`This chat moved to ${session.movedTo.machine}; change its settings there.`);
  session.updatedAt = new Date().toISOString();
  await writeState(state);
  return emitHarnessOutput({ panel: 'settings', session, account: state.accounts.find((item) => item.id === session.accountId)?.label });
}
