/** The conversation of a chat on another machine, kept here from the last time it was shown.
 *
 * Opening it again says what is held (`open`'s `held`, ide/session-delta.ts),
 * so the machine sends only the messages after it -- coming back to a chat, or
 * to a machine, is what changed since, not the chat again. One file per chat,
 * gzipped; the newest KEEP_CHATS are kept. A file that cannot be read is a chat
 * held of nothing: the open sends it whole, as before. */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { stateDirectory } from '../session/store/paths.js';
import type { HarnessSession } from '../session/model.js';

type Messages = NonNullable<HarnessSession['messages']>;

const KEEP_CHATS = 40;
const VERSION = 1;

function directory(): string { return join(stateDirectory(), 'remote', 'chats'); }
function fileOf(machineId: string, chatId: string): string {
  return join(directory(), `${createHash('sha256').update(`${machineId}\0${chatId}`).digest('hex').slice(0, 32)}.json.gz`);
}

/** What was kept of `chatId` on `machineId`: its messages as that machine sent them, and the log generation they are the start of. */
export async function readChatCache(machineId: string, chatId: string): Promise<{ messages: Messages; gen?: string } | undefined> {
  try {
    const saved = JSON.parse(gunzipSync(await readFile(fileOf(machineId, chatId))).toString('utf8')) as { v?: number; chatId?: string; gen?: string; messages?: Messages };
    return saved.v === VERSION && saved.chatId === chatId && Array.isArray(saved.messages) ? { messages: saved.messages, ...(saved.gen ? { gen: saved.gen } : {}) } : undefined;
  } catch {
    return undefined;
  }
}

/** Keeps `messages` of `chatId` on `machineId` for the next open. Written whole beside and renamed over: a crash leaves the old one. */
export async function writeChatCache(machineId: string, chatId: string, messages: Messages, gen?: string): Promise<void> {
  try {
    await mkdir(directory(), { recursive: true });
    const path = fileOf(machineId, chatId);
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, gzipSync(JSON.stringify({ v: VERSION, chatId, ...(gen ? { gen } : {}), messages })), { mode: 0o600 });
    await rename(temporary, path);
    await prune();
  } catch {
    // fail-open-ok: nothing kept; the next open sends the chat whole.
  }
}

async function prune(): Promise<void> {
  const names = (await readdir(directory())).filter((name) => name.endsWith('.json.gz'));
  if (names.length <= KEEP_CHATS) return;
  const aged = await Promise.all(names.map(async (name) => ({ name, at: (await stat(join(directory(), name))).mtimeMs })));
  aged.sort((a, b) => b.at - a.at);
  await Promise.all(aged.slice(KEEP_CHATS).map(({ name }) => unlink(join(directory(), name)).catch(() => undefined)));
}

/** Keeps what a client holds of the chats it shows (the terminal's, VS Code's) for the next open of each: a burst of changes is one write. */
export class ChatKeeper {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly machineId: () => string,
    private readonly held: () => { sessionId: string; messages: Messages; gen?: string } | undefined,
    private readonly pauseMs = 2_000,
  ) {}

  /** Something changed: kept shortly. */
  soon(): void {
    this.timer ??= setTimeout(() => this.now(), this.pauseMs);
    this.timer.unref?.();
  }

  /** Kept now (the chat is leaving). */
  now(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const held = this.held();
    if (held?.messages.length) void writeChatCache(this.machineId(), held.sessionId, held.messages, held.gen);
  }
}
