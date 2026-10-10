/** `/changes <path>`: which conversations edited a file, from every
 * conversation's per-turn change records (session/turn-changes.ts). The
 * terminal and the editor pick one and open it at that turn
 * (search-browse.ts walkTurns); a client that cannot pick gets the list. */
import path from 'node:path';
import type { HarnessState } from '../../session/model.js';
import { compactPath } from '../../harness/protocol/labels.js';
import { expandHomePath } from '../../session/attachments.js';
import { stateDirectory } from '../../session/store/paths.js';
import { fileTurnRow, turnsThatEdited, type FileTurn } from '../../session/turn-changes.js';
import { conversationTitle } from '../../search/conversations.js';
import { ago, shortId } from '../../search/format.js';

export interface FileTurnRow extends FileTurn { label: string; detail: string }

/** `/changes 3` is a turn; anything else is a path. */
export function isChangesPath(args: string): boolean {
  const word = args.trim();
  return word.length > 0 && !/^\d+$/.test(word);
}

export function changesPath(args: string, workspace: string): string {
  return path.resolve(workspace, expandHomePath(args.trim()));
}

export async function fileTurnRows(state: Pick<HarnessState, 'sessions'>, file: string, now = Date.now()): Promise<FileTurnRow[]> {
  const byId = new Map(state.sessions.map((session) => [session.id, session]));
  return (await turnsThatEdited(stateDirectory(), state.sessions, file)).map((turn) => {
    const session = byId.get(turn.sessionId)!;
    return { ...turn, ...fileTurnRow(turn, `${conversationTitle(session, 40)} ${shortId(session.id)}`, ago(Date.parse(turn.record.at), now)) };
  });
}

export function noFileTurns(file: string): string {
  return `No recorded turn in any conversation edited ${compactPath(file)}`;
}

/** The list, for a screen that cannot open one. */
export function fileTurnsText(file: string, rows: readonly FileTurnRow[]): string {
  if (!rows.length) return `${noFileTurns(file)}.`;
  return [
    `${compactPath(file)} · ${rows.length} turn${rows.length === 1 ? '' : 's'} edited it, newest first`,
    ...rows.flatMap((row) => [`  ${row.label}`, `      ${row.detail}`]),
    '',
    '/resume <id> opens that conversation; there /changes N shows the turn\'s diff.',
  ].join('\n');
}
