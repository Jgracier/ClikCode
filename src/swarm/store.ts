/** Swarm memory that is not the conversation. The board and the live activity
 * spool live beside the session index so a clerk's turn cannot rewrite the
 * host's transcript to share them. */

import { readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteFile } from '../session/store/files.js';
import { stateDirectory } from '../session/store/paths.js';
import { beginTurn, emptyBoard, type SwarmBoard } from './board.js';

function directory(): string {
  return join(stateDirectory(), 'swarm');
}

function boardPath(sessionId: string): string {
  return join(directory(), `board-${sessionId}.json`);
}

export function swarmActivityPath(sessionId: string): string {
  return join(directory(), `activity-${sessionId}.jsonl`);
}

/** A missing board is a new one. A board that is there but unreadable is
 * external damage (writes are atomic): its bytes are kept beside it as
 * `.corrupt-<time>` and the swarm starts a fresh board, rather than the next
 * write silently replacing what was there. Any other read error is thrown. */
export async function readBoard(sessionId: string): Promise<SwarmBoard> {
  const file = boardPath(sessionId);
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyBoard();
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as SwarmBoard;
    if (!parsed || !Array.isArray(parsed.facts) || !Array.isArray(parsed.roster)) throw new Error('not a swarm board');
    return parsed;
  } catch {
    await rename(file, `${file}.corrupt-${Date.now()}`);
    process.emitWarning(`swarm board for ${sessionId} was unreadable; kept as ${file}.corrupt-* and started a new board`);
    return emptyBoard();
  }
}

export async function writeBoard(sessionId: string, board: SwarmBoard): Promise<void> {
  await atomicWriteFile(boardPath(sessionId), JSON.stringify(board));
}

/** Decisions and facts carry into the turn. The previous roster does not. */
export async function openSwarmTurn(sessionId: string): Promise<SwarmBoard> {
  const board = beginTurn(await readBoard(sessionId));
  await writeBoard(sessionId, board);
  return board;
}
