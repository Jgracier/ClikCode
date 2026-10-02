/** Swarm memory that is not the conversation. The board and the live activity
 * spool live beside the session index so a clerk's turn cannot rewrite the
 * host's transcript to share them. */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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

export function swarmActivePath(): string {
  return join(directory(), 'active.json');
}

export async function readBoard(sessionId: string): Promise<SwarmBoard> {
  try {
    const parsed = JSON.parse(await readFile(boardPath(sessionId), 'utf8')) as SwarmBoard;
    if (!parsed || !Array.isArray(parsed.facts) || !Array.isArray(parsed.roster)) return emptyBoard();
    return parsed;
  } catch {
    return emptyBoard();
  }
}

export async function writeBoard(sessionId: string, board: SwarmBoard): Promise<void> {
  const dir = directory();
  await mkdir(dir, { recursive: true });
  await writeFile(boardPath(sessionId), JSON.stringify(board), 'utf8');
}

/** Decisions and facts carry into the turn. The previous roster does not. */
export async function openSwarmTurn(sessionId: string): Promise<SwarmBoard> {
  const board = beginTurn(await readBoard(sessionId));
  await writeBoard(sessionId, board);
  return board;
}

export async function markSwarmHost(sessionId: string | undefined): Promise<void> {
  const dir = directory();
  await mkdir(dir, { recursive: true });
  if (!sessionId) {
    await writeFile(swarmActivePath(), '{}\n', 'utf8');
    return;
  }
  await writeFile(swarmActivePath(), JSON.stringify({ sessionId }), 'utf8');
}

export async function activeSwarmHost(): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(swarmActivePath(), 'utf8')) as { sessionId?: unknown };
    return typeof parsed.sessionId === 'string' ? parsed.sessionId : undefined;
  } catch {
    return undefined;
  }
}
