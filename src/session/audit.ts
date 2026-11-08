/** Is each stored conversation as long as the evidence says it was, and if not, what is it
 * rebuilt from.
 *
 * `clikcode sessions audit` (read only) and `clikcode sessions repair` (dry run unless told) are
 * this module. The evidence is what ClikCode keeps beside a conversation without being it: the
 * index row's count, the full record written at each handoff (records/<id>.md and the ones set
 * aside), and the vendor threads (Claude's and Codex's, under every profile) that carried its
 * turns. Where the store holds fewer turns than a piece of evidence that agrees with it up to the
 * store's newest turn, it is behind by the turns after that. */

import { quiet } from '../runtime/lifecycle-log.js';
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { HarnessSession, TranscriptMessage } from './model.js';
import { requestKey } from './store-evidence.js';
import { loadIndex } from './state/index-file.js';
import { readSessionTranscript, ConversationLogMissingError, replaceTranscriptFromEvidence } from './store/transcripts.js';
import { sessionLogPath, stateDirectory } from './store/paths.js';
import { readClaudeFsTranscript } from './discovery/vendors/claude.js';
import { readCodexFsTranscript } from './discovery/vendors/codex.js';
import { forgetNativeThread } from './native-thread.js';
import { readState } from './state/read.js';
import { writeState } from './state/write.js';

type Said = { role: 'user' | 'assistant'; content: string };

export interface EvidenceSource {
  source: 'index' | 'record' | 'older-record' | 'claude-thread' | 'codex-thread';
  /** The file, or the index row. */
  path: string;
  userTurns: number;
  at: string;
  /** The conversation's turns after the store's newest turn that this source holds (0: nothing the store lacks). */
  beyondStore: number;
  /** The source agrees with the store up to the store's newest request. False: it cannot be laid against it. */
  aligned: boolean;
  /** Named by the conversation (its record, a thread its row lists). Otherwise it was found by opening with the same request,
   * which a branch of the conversation, or another conversation begun the same way, also does: advice, never proof. */
  named: boolean;
}

export interface AuditEntry {
  id: string;
  name: string | undefined;
  status: 'ok' | 'behind' | 'possibly-behind' | 'log-missing';
  store: { messages: number; userTurns: number } | null;
  indexCount: number | undefined;
  /** The most turns that named evidence says the conversation has and the store lacks. */
  behindBy: number;
  /** The same by threads that only open with the same request. */
  possiblyBehindBy: number;
  evidence: EvidenceSource[];
}

// ---------------------------------------------------------------------------
// Reading evidence
// ---------------------------------------------------------------------------

/** A record file (session/full-record.ts) as messages: `## You` and `## Assistant` sections. */
export function parseRecordMarkdown(markdown: string): Said[] {
  const out: Said[] = [];
  let current: Said | undefined;
  for (const line of markdown.split('\n')) {
    const heading = /^## (You|Assistant)$/.exec(line);
    if (heading) {
      if (current) out.push({ ...current, content: current.content.trim() });
      current = { role: heading[1] === 'You' ? 'user' : 'assistant', content: '' };
    } else if (current) current.content += `${line}\n`;
  }
  if (current) out.push({ ...current, content: current.content.trim() });
  return out;
}

const userTurnsOf = (messages: readonly { role: string }[]): number => messages.filter((message) => message.role === 'user').length;

/** A request and what answered it: the unit evidence is laid against the store in. */
interface Turn { head: string; messages: Array<TranscriptMessage | Said> }

/** The first 80 characters of a request as it was typed (notes and spacing aside), or '' when too short
 * to tell one request from another. */
function headOf(text: string): string {
  const key = requestKey(text);
  return key.length >= MIN_REQUEST ? key.slice(0, 80) : '';
}
const MIN_REQUEST = 24;

function turnsOf(messages: ReadonlyArray<TranscriptMessage | Said>): Turn[] {
  const turns: Turn[] = [];
  for (const message of messages) {
    if (message.role === 'user' || !turns.length) turns.push({ head: message.role === 'user' ? headOf(message.content) : '', messages: [] });
    turns[turns.length - 1]!.messages.push(message);
  }
  return turns;
}

const flatten = (turns: readonly Turn[]): Array<TranscriptMessage | Said> => turns.flatMap((turn) => turn.messages);

/** How a piece of evidence lies against the store: how many of its requests the store holds, and how many
 * it does not. `agrees`: they share requests (or the store has none), so it is the same conversation. */
export function layAgainst(store: ReadonlyArray<TranscriptMessage>, evidence: readonly Said[]): { agrees: boolean; missing: number } {
  const held = new Set(turnsOf(store).map((turn) => turn.head).filter(Boolean));
  const asked = turnsOf(evidence).map((turn) => turn.head).filter(Boolean);
  const shared = asked.filter((head) => held.has(head)).length;
  const agrees = held.size === 0 || shared >= Math.min(3, held.size);
  return { agrees, missing: agrees ? asked.length - shared : 0 };
}

/** A piece of evidence that can make up a conversation's log. */
export interface Piece { source: EvidenceSource['source'] | 'store'; path: string; at: string; messages: ReadonlyArray<TranscriptMessage | Said> }

/** The conversation as the evidence has it. The piece with most requests is the backbone; where the store
 * holds a request of it, the store's own turn stands (its tool calls, attachments, origins), and the
 * requests the store alone holds follow. Then each newer piece adds what comes after the last request it
 * shares with the result and the result lacks, oldest piece first. */
export function mergeEvidence(pieces: readonly Piece[]): { messages: Array<TranscriptMessage | Said>; steps: Array<{ source: Piece['source']; path: string; addedMessages: number }> } {
  const ordered = [...pieces].sort((a, b) => userTurnsOf(b.messages) - userTurnsOf(a.messages) || b.at.localeCompare(a.at));
  const backbone = ordered[0];
  if (!backbone) return { messages: [], steps: [] };
  const steps: Array<{ source: Piece['source']; path: string; addedMessages: number }> = [{ source: backbone.source, path: backbone.path, addedMessages: backbone.messages.length }];
  let result = turnsOf(backbone.messages);
  const store = pieces.find((piece) => piece.source === 'store');
  if (store && store !== backbone) {
    const own = new Map<string, Turn>();
    for (const turn of turnsOf(store.messages)) if (turn.head && !own.has(turn.head)) own.set(turn.head, turn);
    result = result.map((turn) => own.get(turn.head) ?? turn);
  }
  for (const piece of [...pieces].filter((candidate) => candidate !== backbone).sort((a, b) => a.at.localeCompare(b.at))) {
    if (piece.at <= backbone.at && piece.source !== 'store') continue;
    const have = new Set(result.map((turn) => turn.head).filter(Boolean));
    const turns = turnsOf(piece.messages);
    let last = -1;
    turns.forEach((turn, index) => { if (turn.head && have.has(turn.head)) last = index; });
    if (last < 0 && have.size) continue;
    const tail = turns.slice(last + 1).filter((turn) => !turn.head || !have.has(turn.head));
    if (!tail.length) continue;
    result = [...result, ...tail];
    steps.push({ source: piece.source, path: piece.path, addedMessages: flatten(tail).length });
  }
  return { messages: flatten(result), steps };
}

interface ThreadFile { source: 'claude-thread' | 'codex-thread'; path: string; id: string; profile: string }

/** Every Claude and Codex thread under every profile the state directory holds, once per run. */
async function threadIndex(): Promise<ThreadFile[]> {
  const out: ThreadFile[] = [];
  const profiles = join(stateDirectory(), 'profiles');
  const dirs = async (path: string) => (await readdir(path, { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  for (const profile of await dirs(join(profiles, 'claude'))) {
    const root = join(profiles, 'claude', profile, 'projects');
    for (const project of await dirs(root)) {
      for (const name of await readdir(join(root, project)).catch(() => [] as string[])) {
        if (name.endsWith('.jsonl')) out.push({ source: 'claude-thread', path: join(root, project, name), id: name.slice(0, -'.jsonl'.length), profile: join(profiles, 'claude', profile) });
      }
    }
  }
  const walk = async (path: string, profile: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory()) await walk(join(path, entry.name), profile);
      else if (/^rollout-.*\.jsonl$/.test(entry.name)) out.push({ source: 'codex-thread', path: join(path, entry.name), id: /([0-9a-f-]{36})\.jsonl$/.exec(entry.name)?.[1] ?? entry.name, profile });
    }
  };
  for (const profile of await dirs(join(profiles, 'codex'))) await walk(join(profiles, 'codex', profile, 'sessions'), join(profiles, 'codex', profile));
  return out;
}

/** The thread ids a conversation's row names, as `source:id`. */
function referencedThreads(session: HarnessSession): Set<string> {
  const ids = new Set<string>();
  const add = (harness: string | undefined, id: string | undefined): void => { if (harness && id) ids.add(`${harness}:${id}`); };
  add(session.nativeHarness, session.nativeSessionId);
  for (const [harness, slot] of Object.entries(session.nativeThreads ?? {})) add(harness, slot.id);
  add(session.previousNativeThread?.harness, session.previousNativeThread?.id);
  for (const owned of session.ownedThreads ?? []) ids.add(owned);
  return ids;
}

const firstKeys = new Map<string, string | undefined>();

/** The first request of a Claude thread, from its first 64 KB. */
async function firstRequest(path: string): Promise<string | undefined> {
  if (firstKeys.has(path)) return firstKeys.get(path);
  const handle = await open(path, 'r');
  let head = '';
  try {
    const bytes = Buffer.alloc(65536);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    head = bytes.toString('utf8', 0, bytesRead);
  } finally { await handle.close(); }
  let found: string | undefined;
  for (const line of head.split('\n')) {
    if (!line.includes('"type":"user"')) continue;
    try {
      const entry = JSON.parse(line) as { type?: string; isSidechain?: boolean; isMeta?: boolean; message?: { content?: unknown } };
      if (entry.type !== 'user' || entry.isSidechain || entry.isMeta) continue;
      const content = entry.message?.content;
      const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((block) => (block as { type?: string; text?: string })?.type === 'text' ? String((block as { text?: string }).text) : '').join('\n') : '';
      if (text.trim() && !/^\s*<(command-|local-command|system-reminder)/.test(text)) { found = requestKey(text); break; }
    } catch { /* a line cut by the window edge */ }
  }
  firstKeys.set(path, found);
  return found;
}

async function readThread(thread: ThreadFile, workspace: string): Promise<Said[]> {
  return thread.source === 'claude-thread'
    ? readClaudeFsTranscript(thread.id, workspace, { CLAUDE_CONFIG_DIR: thread.profile })
    : readCodexFsTranscript(thread.id, workspace, { CODEX_HOME: thread.profile });
}

interface Gathered { source: EvidenceSource['source']; path: string; at: string; messages: Said[]; /** Named by the conversation's own row or a record of it: what a repair may build from. */ named: boolean }

/** Every piece of evidence for a conversation that holds turns: its records and the threads it names or opens with. */
async function gather(session: HarnessSession, store: readonly TranscriptMessage[], threads: ThreadFile[]): Promise<Gathered[]> {
  const out: Gathered[] = [];
  const records = join(stateDirectory(), 'records');
  const files: Array<{ path: string; source: 'record' | 'older-record' }> = [{ path: join(records, `${session.id}.md`), source: 'record' }];
  for (const name of await readdir(join(records, 'older')).catch(() => [] as string[])) {
    if (name.startsWith(`${session.id}.`)) files.push({ path: join(records, 'older', name), source: 'older-record' });
  }
  for (const file of files) {
    const info = await stat(file.path).catch(quiet('session/audit'));
    if (!info) continue;
    out.push({ source: file.source, path: file.path, at: info.mtime.toISOString(), messages: parseRecordMarkdown(await readFile(file.path, 'utf8')), named: true });
  }
  const named = referencedThreads(session);
  const branch = Boolean(session.parentSessionId || session.foldedInto || session.movedTo);
  const first = store.find((message) => message.role === 'user');
  const firstKey = first ? requestKey(first.content) : '';
  for (const thread of threads) {
    const wasNamed = named.has(`${thread.source === 'claude-thread' ? 'claude' : 'codex'}:${thread.id}`);
    let wanted = wasNamed;
    // A branch of a conversation (a fork, a folded copy) shares its opening request with the whole line it
    // branched from: it is told by the threads it names, not by how its first request reads.
    if (!wanted && !branch && thread.source === 'claude-thread' && firstKey.length >= 24) {
      const opens = await firstRequest(thread.path).catch(quiet('session/audit'));
      wanted = Boolean(opens && opens.length >= 24 && (opens.includes(firstKey.slice(0, 80)) || firstKey.includes(opens.slice(0, 80))));
    }
    if (!wanted) continue;
    const messages = await readThread(thread, session.workspace ?? '').catch(() => [] as Said[]);
    if (messages.length) out.push({ source: thread.source, path: thread.path, at: (await stat(thread.path)).mtime.toISOString(), messages, named: wasNamed });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

async function storeOf(id: string): Promise<readonly TranscriptMessage[] | null> {
  try {
    return (await readSessionTranscript(id)).messages ?? [];
  } catch (error) {
    if (error instanceof ConversationLogMissingError) return null;
    throw error;
  }
}

/** Fewer requests than this that a piece of evidence has and the store lacks are not reported. */
const MIN_BEHIND = 5;

async function auditOne(session: HarnessSession, threads: ThreadFile[]): Promise<AuditEntry> {
  const store = await storeOf(session.id);
  const have = store ?? [];
  const evidence: EvidenceSource[] = [];
  let behindBy = 0;
  let possiblyBehindBy = 0;
  const counted = session.listMessageCount;
  if (counted !== undefined && have.length < counted) {
    evidence.push({ source: 'index', path: 'index.json', userTurns: Math.ceil(counted / 2), at: session.updatedAt, beyondStore: Math.ceil((counted - have.length) / 2), aligned: true, named: true });
    behindBy = Math.max(behindBy, Math.ceil((counted - have.length) / 2));
  }
  for (const piece of await gather(session, have, threads)) {
    const laid = layAgainst(have, piece.messages);
    // One or two requests more than the store is what an undo, or a vendor's own preamble, leaves in a thread.
    const beyondStore = laid.missing >= MIN_BEHIND ? laid.missing : 0;
    evidence.push({ source: piece.source, path: piece.path, userTurns: userTurnsOf(piece.messages), at: piece.at, beyondStore, aligned: laid.agrees, named: piece.named });
    if (piece.named) behindBy = Math.max(behindBy, beyondStore);
    else possiblyBehindBy = Math.max(possiblyBehindBy, beyondStore);
  }
  return {
    id: session.id, name: session.name,
    status: store === null ? 'log-missing' : behindBy > 0 ? 'behind' : possiblyBehindBy > 0 ? 'possibly-behind' : 'ok',
    store: store === null ? null : { messages: have.length, userTurns: userTurnsOf(have) },
    indexCount: counted, behindBy, possiblyBehindBy, evidence,
  };
}

/** Every conversation in the index against the evidence. Reads only. */
export async function auditConversations(only?: readonly string[]): Promise<AuditEntry[]> {
  const index = await loadIndex();
  const threads = await threadIndex();
  const out: AuditEntry[] = [];
  for (const session of (index?.sessions ?? []) as HarnessSession[]) {
    if (only && !only.includes(session.id)) continue;
    // Never-started chats hold no turns to lose.
    if (!session.listMessageCount && !session.listPreview && !only) continue;
    out.push(await auditOne(session, threads));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Repair
// ---------------------------------------------------------------------------

export interface RepairPlan {
  id: string;
  /** The store now, null when its log is missing. */
  from: { messages: number; userTurns: number } | null;
  to: { messages: number; userTurns: number };
  /** What the new log is made of, in the order applied. */
  steps: Array<{ source: Piece['source']; path: string; addedMessages: number }>;
  /** Evidence that holds turns but could not be laid against the store (not used). */
  unaligned: Array<{ source: EvidenceSource['source']; path: string; userTurns: number }>;
  messages: Array<TranscriptMessage | Said>;
}

/** What the conversation's log would be rebuilt as: the store, extended by each piece of evidence in turn,
 * the one with most turns first. Reads only. */
export async function planRepair(id: string): Promise<RepairPlan> {
  const index = await loadIndex();
  const session = (index?.sessions as HarnessSession[] | undefined)?.find((item) => item.id === id);
  if (!session) throw new Error(`conversation ${id} is not in the index; repair rebuilds the log of a listed conversation`);
  const store = await storeOf(id);
  const info = await stat(sessionLogPath(id)).catch(quiet('session/audit'));
  const pieces = (await gather(session, store ?? [], await threadIndex())).filter((piece) => piece.named);
  const unaligned: RepairPlan['unaligned'] = [];
  const usable: Piece[] = [];
  for (const piece of pieces) {
    if (layAgainst(store ?? [], piece.messages).agrees) usable.push(piece);
    else unaligned.push({ source: piece.source, path: piece.path, userTurns: userTurnsOf(piece.messages) });
  }
  if (store?.length) usable.push({ source: 'store', path: sessionLogPath(id), at: info?.mtime.toISOString() ?? session.updatedAt, messages: store });
  const merged = mergeEvidence(usable);
  const messages = merged.messages;
  // Only a result longer than the store is a repair.
  const better = userTurnsOf(messages) > userTurnsOf(store ?? []);
  return {
    id,
    from: store === null ? null : { messages: store.length, userTurns: userTurnsOf(store) },
    to: { messages: better ? messages.length : (store?.length ?? 0), userTurns: better ? userTurnsOf(messages) : userTurnsOf(store ?? []) },
    steps: better ? merged.steps.filter((step) => step.source !== 'store') : [],
    unaligned, messages: better ? messages : [...(store ?? [])],
  };
}

/** Writes the plan's log, with every file the conversation has copied first. The index row follows the log. */
export async function applyRepair(plan: RepairPlan): Promise<{ backup: string; backedUp: string[] }> {
  if (!plan.steps.length) throw new Error(`nothing in the evidence extends conversation ${plan.id}; nothing was changed`);
  const backup = join(stateDirectory(), 'repair-backups', plan.id, new Date().toISOString().replace(/[:.]/g, '-'));
  const { backedUp } = await replaceTranscriptFromEvidence(plan.id, plan.messages as TranscriptMessage[], backup);
  // The index row's count follows the log it now describes. And no vendor thread is resumed against it:
  // each was written or resumed against the store as it stood, so it has a hole where the repair filled
  // one (native-thread.ts: a thread is a copy of the record). The next turn takes the whole repaired
  // conversation up afresh.
  const state = await readState({ transcripts: [plan.id] });
  const row = state.sessions.find((item) => item.id === plan.id);
  if (row) {
    forgetNativeThread(row);
    delete row.nativeThreads;
  }
  await writeState(state);
  return { backup, backedUp };
}
