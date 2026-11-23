/** A ClikDeploy key handed to ONE chat by whoever opened it (the ClikDeploy canvas,
 * running its agent on this machine's signed-in subscription: protocol.ts `open.clikdeploy`).
 *
 * That chat's ClikDeploy tools use this key instead of the machine's own sign-in, so they
 * run as the canvas turn that asked -- its account, its grant, its permission mode, recorded
 * as that turn -- and a machine that never signed in to ClikDeploy still gets them. The key
 * is the canvas turn's short-lived one: the platform deletes it when the turn ends, and the
 * next turn's open writes the next one over it.
 *
 * Kept in a file only this user can read, named by the chat, never in a server spec (those
 * are copied into vendor command lines and config files: clikdeploy-session.ts). */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateDirectory } from '../../session/store/paths.js';

export interface ChatClikDeployKey { url: string; key: string }

/** Session ids are ClikCode's own; anything else is refused before it names a file. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

function keyPath(sessionId: string): string | undefined {
  return SAFE_ID.test(sessionId) ? join(stateDirectory(), 'clikdeploy-chat', `${sessionId}.json`) : undefined;
}

/** Only an https URL (or loopback http, for a local platform) and a non-empty key are kept. */
export function validChatClikDeployKey(value: unknown): ChatClikDeployKey | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { url, key } = value as { url?: unknown; key?: unknown };
  if (typeof url !== 'string' || typeof key !== 'string' || !key.trim() || key.length > 512) return undefined;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return undefined; }
  const loopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) return undefined;
  return { url: url.replace(/\/+$/, ''), key: key.trim() };
}

export function saveChatClikDeployKey(sessionId: string, value: ChatClikDeployKey): void {
  const path = keyPath(sessionId);
  if (!path) throw new Error('Not a chat id.');
  mkdirSync(join(stateDirectory(), 'clikdeploy-chat'), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
}

export function readChatClikDeployKey(sessionId: string | undefined): ChatClikDeployKey | undefined {
  const path = sessionId ? keyPath(sessionId) : undefined;
  if (!path) return undefined;
  try {
    return validChatClikDeployKey(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return undefined; // none written for this chat: the machine's own sign-in
  }
}

export function forgetChatClikDeployKey(sessionId: string): void {
  const path = keyPath(sessionId);
  if (path) rmSync(path, { force: true });
}
