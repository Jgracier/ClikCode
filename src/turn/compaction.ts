/** ClikCode's one compaction: when and how a conversation is compacted, for every harness.
 *
 * One threshold (globalSettings.compactAt, default DEFAULT_COMPACT_AT_TOKENS; `/compact <tokens>`
 * sets it). The same number caps what a handoff to another provider may carry (handoffTokens).
 *
 * Automatic: the vendor's own agent loop is the one place that sees the context before every
 * model call, so wherever a vendor has an auto-compaction threshold (catalog `compactThreshold`)
 * every launch carries ClikCode's number in the vendor's own terms (vendorThresholdPlan) and the
 * vendor compacts itself, mid-turn, with its own summary. A changed number changes the launch,
 * so a long-lived vendor process is restarted for it. Only where no threshold reaches the vendor
 * does ClikCode compact after a turn that ended over it (worker/worker-turn.ts shouldCompact).
 *
 * Manual (`/compact`, and that after-turn fallback): the harness's own compaction
 * (compactionMechanism) -- its compact API (Codex `thread/compact/start`), else the command it
 * runs itself (Claude's `/compact`, Gemini's `/compress`, ...). Only a harness with neither is
 * compacted by ClikCode: its thread is let go and the next turn takes the conversation up afresh
 * (turn/thread-start.ts), fitted to half the threshold. ClikCode's own record keeps every turn
 * either way, and the model is told where it is: the hindsight tool, or the full-record file.
 *
 * Chalk free and dependency free: the slash registry and the webview import it. */

/** MEASURED 2026-11-23 (scripts/compaction-eval.mjs, six conversations, ~326 judged probes, Haiku
 * through Claude Code, with recall + hindsight, the search nudge and the identifier list): 50k
 * answers as well as nothing compacted (83.4% against 83.3%, 95% range -4.6..+4.4) at 44% of the
 * full context's cost; 100k was 5.4 points down (decisions -9.2), 40k lost facts (-6.8). */
export const DEFAULT_COMPACT_AT_TOKENS = 50_000;
/** Below this a compaction costs more than it saves. */
export const MIN_COMPACT_AT_TOKENS = 20_000;
/** Turns after a compaction before another may run by itself. About one in ten sessions carries
 * one huge tool result that keeps the context near the threshold, and would otherwise compact
 * again every few calls. */
export const TURNS_BETWEEN_COMPACTIONS = 2;
/** A vendor launched with ClikCode's threshold compacts itself; after a turn ClikCode compacts it
 * only past this multiple of the threshold -- the vendor ignored its setting (Grok and Vibe did,
 * live). Above 1 so a turn whose last call crossed the line is left to the vendor's next call. */
export const VENDOR_THRESHOLD_BACKSTOP = 1.5;
/** Room a conversation gets past what its compaction left before the next one. MEASURED
 * 2026-11-23: a compaction leaves 37-57k (summary, system prompt, tools), so a fixed 50k trigger
 * compacted again 2-10 calls later; the floor plus this keeps 50k for a first compaction and
 * puts the next one ~35k of new work away. */
export const COMPACTION_HEADROOM = 35_000;

/** What a compaction's summary keeps, where the harness takes instructions for it: the state the
 * work is in, not the story of how it got there. ClikCode's record keeps every turn, and recall
 * (search/recall.ts) and the topic contents (search/topic-contents.ts) bring back what a summary
 * left out, so the summary need not narrate. Only letters, spaces, commas, periods and colons: it
 * is echoed by a hook command (claudeCompactSettings) that sh and cmd both run as it is.
 * Claude: a PreCompact hook, for its auto-compaction and `/compact` alike. Codex: within
 * CODEX_COMPACT_PROMPT. Gemini's /compress takes no instructions; a rewrite writes no summary. */
export const COMPACT_INSTRUCTIONS = 'Summarize the current state only, not the history of how it was reached. Keep, as short sections: '
  + 'the goal and the constraints the user set. Decisions made, each with its reason. Things tried or proposed and rejected, each with why. '
  + 'Open threads and unanswered questions. The current step and the next action. '
  + 'Every exact identifier in play, verbatim: file paths, function and variable names, commands, ids, hashes, numbers, URLs and error text. '
  + 'Leave out narrative, pleasantries and tool output already acted on.';

/** Codex's `compact_prompt` replaces its whole compaction prompt, so it says what the task is too. */
export const CODEX_COMPACT_PROMPT = `You are performing a context checkpoint compaction. Write a handoff summary for the model that will resume this work. ${COMPACT_INSTRUCTIONS}`;

/** Claude Code's settings (claude-agent-acp `_meta.claudeCode.options.settings`) with a PreCompact
 * hook whose output Claude Code adds to its summary's instructions, for its own threshold and a
 * `/compact` alike. */
export function claudeCompactSettings(): Record<string, unknown> {
  return { hooks: { PreCompact: [{ hooks: [{ type: 'command', command: `echo ${COMPACT_INSTRUCTIONS}` }] }] } };
}

/** The only words a person sees about it. */
export const COMPACTING = 'Compacting…';
export const COMPACTED = 'Compacted';
export const NOTHING_TO_COMPACT = 'Nothing to compact yet.';
export const compactFailedLine = (reason: string): string => `Could not compact: ${reason.replace(/^Could not compact:\s*/, '')}`;

/** What a client sends to have the conversation compacted now: a turn of its own. */
export const COMPACT_REQUEST = '/compact';
export const isCompactRequest = (prompt: string): boolean => prompt.trim() === COMPACT_REQUEST;

/** A size typed as `150000`, `150k`, `1m` or `0.5m` (a trailing `tokens` is fine); undefined when it is not one. */
export function parseCompactAt(word: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)\s*([km]?)(?:\s*tokens?)?$/i.exec(word.trim());
  if (!match) return undefined;
  const unit = match[2]!.toLowerCase();
  return Math.round(Number(match[1]) * (unit === 'm' ? 1_000_000 : unit === 'k' ? 1_000 : 1));
}

/** The threshold the user set, or the default. */
export function compactAt(settings: { compactAt?: unknown } | undefined): number {
  const set = settings?.compactAt;
  return typeof set === 'number' && Number.isFinite(set) && set >= MIN_COMPACT_AT_TOKENS ? set : DEFAULT_COMPACT_AT_TOKENS;
}

/** `150k`, `1.5m`. */
export function tokenLabel(tokens: number): string {
  return tokens >= 1_000_000 ? `${Math.round(tokens / 100_000) / 10}m` : `${Math.round(tokens / 1000)}k`;
}

/** The threshold last read from the state file in this process (session/state/read.ts), for
 * what is drawn synchronously: the /compact entry's description. */
let knownCompactAt: number | undefined;
export function noteCompactAt(settings: { compactAt?: unknown } | undefined): void { knownCompactAt = compactAt(settings); }
export const currentCompactAt = (): number => knownCompactAt ?? DEFAULT_COMPACT_AT_TOKENS;
export function compactDescription(): string {
  return `compact this conversation now; /compact <tokens> sets when it compacts by itself (now ${tokenLabel(currentCompactAt())})`;
}

/** How much context the conversation holds now, in tokens: what the latest model call read
 * (`contextUsed`, set from that call alone -- never the turn's sum over its calls), or the
 * vendor's percentage of its window where that is all it says. */
export function contextTokens(usage: { contextUsed?: number; contextPercent?: number; contextWindow?: number } | undefined): number | undefined {
  if (usage?.contextUsed !== undefined && usage.contextUsed > 0) return usage.contextUsed;
  if (usage?.contextPercent !== undefined && usage.contextWindow) return Math.round(usage.contextPercent / 100 * usage.contextWindow);
  return undefined;
}

/** A conversation going to another provider carries at most this many tokens of itself: the
 * threshold, and never more than half the receiving model's window (the rest is the vendor's
 * system prompt, tools and the work). */
export function handoffTokens(threshold: number, contextWindow?: number): number {
  return contextWindow && contextWindow > 0 ? Math.min(threshold, Math.floor(contextWindow / 2)) : threshold;
}

/** How `/compact` compacts the conversation now. */
export type CompactionMechanism =
  /** The vendor's compact operation on its server (Codex `thread/compact/start`), sent as a turn. */
  | { kind: 'native-api'; prompt: string }
  /** The vendor's own compaction command, sent as a turn's prompt. */
  | { kind: 'native-command'; prompt: string }
  /** No native compaction: ClikCode lets the thread go and the next turn takes the conversation
   * up afresh, fitted (turn/thread-start.ts). */
  | { kind: 'rewrite' };

/** Names a vendor gives its own compaction command. */
const COMPACT_COMMAND_NAMES = ['compact', 'compress'];

interface CompactingHarness {
  nativeOperations?: readonly string[];
  nativeSlashPassthrough?: boolean;
  acp?: { compactCommand?: { prompt: string } };
}

/** How this harness compacts now, from what it declares and the commands it has said it runs
 * (its live `available_commands`, the cached list, ClikCode's declared list). */
export function compactionMechanism(harness: CompactingHarness, commands: readonly string[] = []): CompactionMechanism {
  if (harness.nativeOperations?.includes('compact')) return { kind: 'native-api', prompt: COMPACT_REQUEST };
  if (harness.acp?.compactCommand) return { kind: 'native-command', prompt: harness.acp.compactCommand.prompt };
  const names = commands.map((name) => name.replace(/^\//, '').toLowerCase());
  const named = COMPACT_COMMAND_NAMES.find((name) => names.includes(name));
  if (named) return { kind: 'native-command', prompt: `/${named}` };
  if (harness.nativeSlashPassthrough) return { kind: 'native-command', prompt: COMPACT_REQUEST };
  return { kind: 'rewrite' };
}

/** A vendor's auto-compaction threshold, as the catalog declares it (clikrouter AiHarnessCompactThreshold). */
export interface VendorThresholdSetting {
  env?: string;
  config?: string;
  settingsKey?: string;
  unit?: 'tokens' | 'share' | 'percent' | 'claude-window';
  /** The config key of the vendor's compaction prompt, set to CODEX_COMPACT_PROMPT. */
  promptConfig?: string;
}

/** What one launch carries so the vendor compacts at ClikCode's threshold. */
export type VendorThresholdPlan =
  /** Variables to set. */
  | { kind: 'env'; env: Record<string, string> }
  /** Settings in a file ClikCode writes, named by the variable `env`. */
  | { kind: 'settings'; env: string; settings: Record<string, unknown> }
  /** Keys of the vendor thread's config. */
  | { kind: 'config'; config: Record<string, unknown> };

/** The largest share of the window a threshold is set to: at or past the whole window some
 * vendors switch auto-compaction off (Goose) or never reach it. */
export const MAX_THRESHOLD_SHARE = 0.95;

/** Claude Code compacts at its auto-compact window less the summary's room: min(the model's
 * output limit, 20k) plus a 13k buffer -- 33k for every current model. The window is at least
 * 100k; below that CLAUDE_AUTOCOMPACT_PCT_OVERRIDE lowers the threshold to a percent of the
 * window less the output room (2.1.330 bundle; code.claude.com/docs/en/env-vars). */
const CLAUDE_OUTPUT_ROOM = 20_000;
const CLAUDE_BUFFER = 13_000;
const CLAUDE_MIN_WINDOW = 100_000;
/** What Claude Code's own compaction leaves: its summary, system prompt and tools. MEASURED
 * 2026-11-23: 37-57k. */
const CLAUDE_COMPACTION_FLOOR = 60_000;
/** The lowest trigger Claude Code is launched with. Its process compacts itself many times in one
 * turn, so the floor-aware threshold (effectiveThreshold) reaches it only at its next launch; a
 * 62.5k trigger over a ~55k floor refilled within three calls three times running, and Claude Code
 * stopped the turn ("Autocompact is thrashing"). Sonnet at 100k answered 91.7% vs 89.8% at 50k. */
export const CLAUDE_MIN_TRIGGER = CLAUDE_COMPACTION_FLOOR + COMPACTION_HEADROOM;
/** The threshold (tokens) a vendor is launched with for ClikCode's `threshold`. */
export function vendorTrigger(setting: VendorThresholdSetting | undefined, threshold: number, record?: CompactionRecord): number {
  if (setting?.unit !== 'claude-window') return threshold;
  // Measured: the floor plus the headroom (effectiveThreshold) is the trigger. Not yet: the
  // highest floor seen across conversations plus the headroom.
  return record?.vendorFloor !== undefined ? effectiveThreshold(threshold, record) : Math.max(threshold, CLAUDE_MIN_TRIGGER);
}
export function claudeCompactWindow(threshold: number): Record<string, string> {
  const window = threshold + CLAUDE_OUTPUT_ROOM + CLAUDE_BUFFER;
  if (window >= CLAUDE_MIN_WINDOW) return { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(window) };
  const percent = Math.floor(threshold / (CLAUDE_MIN_WINDOW - CLAUDE_OUTPUT_ROOM) * 1000) / 10;
  return { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(CLAUDE_MIN_WINDOW), CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: String(percent) };
}

/** ClikCode's threshold (tokens) in the vendor's own terms, for a model whose window is `window`
 * (tokens) where known. Undefined when it cannot be said: a share of an unknown window -- the
 * vendor keeps its own default then, and ClikCode compacts after the turn instead. */
export function vendorThresholdPlan(setting: VendorThresholdSetting | undefined, threshold: number, window?: number, record?: CompactionRecord): VendorThresholdPlan | undefined {
  if (!setting) return undefined;
  const unit = setting.unit ?? 'tokens';
  if (unit === 'claude-window') return { kind: 'env', env: claudeCompactWindow(vendorTrigger(setting, threshold, record)) };
  let value: number;
  if (unit === 'tokens') value = threshold;
  else {
    if (!window || window <= 0) return undefined;
    const share = Math.min(MAX_THRESHOLD_SHARE, threshold / window);
    value = unit === 'percent' ? Math.max(1, Math.round(share * 100)) : Math.max(0.01, Math.round(share * 1000) / 1000);
  }
  if (setting.config) return { kind: 'config', config: { [setting.config]: value, ...(setting.promptConfig ? { [setting.promptConfig]: CODEX_COMPACT_PROMPT } : {}) } };
  if (!setting.env) return undefined;
  if (!setting.settingsKey) return { kind: 'env', env: { [setting.env]: String(value) } };
  const settings: Record<string, unknown> = {};
  const keys = setting.settingsKey.split('.');
  let node = settings;
  for (const key of keys.slice(0, -1)) node = (node[key] = {}) as Record<string, unknown>;
  node[keys.at(-1)!] = value;
  return { kind: 'settings', env: setting.env, settings };
}

/** What the conversation keeps about its latest compaction (HarnessSession.compaction). */
export interface CompactionRecord {
  at: string;
  /** `messages.length` when it was made: the turns after it are counted from there. */
  through: number;
  /** The context the first turn after it ran on, once known. */
  after?: number;
  /** The previous compaction's floor (its `after`), the estimate of this one's until measured. */
  floor?: number;
  /** The context of the vendor's first model call after one of its own compactions -- the floor
   * its next trigger must clear -- the highest seen in this conversation (vendor-observer.ts).
   * Claude Code's boundary reports only what the summary kept (11-21k); its first call after it
   * sent 39-53k, with up to five re-read files (5k each), the skill and tool listings re-added. */
  vendorFloor?: number;
  /** A rewrite whose fresh thread the next turn has yet to write. */
  rewrite?: true;
  /** A native compaction whose next turn has yet to tell the model where the whole conversation is. */
  noteRecord?: true;
}

interface CompactableSession {
  messages?: ReadonlyArray<{ role: string; automatic?: string }>;
  lastUsage?: { contextUsed?: number; contextPercent?: number; contextWindow?: number; at: string };
  compaction?: CompactionRecord;
}

/** How many of the conversation's first messages the model's context holds only as a summary, or
 * not at all: its latest compaction, or a thread started from a record fitted to the threshold.
 * What automatic recall searches (search/recall.ts). 0: the context holds every message. */
export function recallBoundary(session: { messages?: readonly unknown[]; compaction?: CompactionRecord; recallFrom?: number }): number {
  return Math.min(session.messages?.length ?? 0, Math.max(session.compaction?.through ?? 0, session.recallFrom ?? 0));
}

/** Turns the person ran since the latest compaction. */
export function turnsSinceCompaction(session: CompactableSession): number {
  const record = session.compaction;
  const messages = session.messages ?? [];
  const from = record ? Math.min(record.through, messages.length) : 0;
  return messages.slice(from).filter((message) => message.role === 'user' && !message.automatic).length;
}

/** The threshold for this conversation: the user's, or -- once a compaction has run -- what it
 * left (measured, else the previous compaction's) plus COMPACTION_HEADROOM where that is higher,
 * so a conversation whose summary, tools or one huge tool result sit near the threshold does not
 * compact again every few calls. */
export function effectiveThreshold(threshold: number, record: CompactionRecord | undefined): number {
  const floor = record?.vendorFloor ?? record?.after ?? record?.floor;
  return floor !== undefined ? Math.max(threshold, floor + COMPACTION_HEADROOM) : threshold;
}

/** The record of a compaction made now, carrying the previous one's floor forward. */
export function nextCompactionRecord(
  previous: CompactionRecord | undefined,
  through: number,
  fields: Pick<CompactionRecord, 'rewrite' | 'noteRecord'>,
): CompactionRecord {
  const floor = previous?.after ?? previous?.floor;
  const vendorFloor = previous?.vendorFloor;
  return { at: new Date().toISOString(), through, ...(floor !== undefined ? { floor } : {}), ...(vendorFloor !== undefined ? { vendorFloor } : {}), ...fields };
}

/** Note a reading of the vendor's context after one of its own compactions: the first that rose
 * above the reading before it is its first model call on the compacted thread (the boundary's own
 * reading, what the summary kept, comes first and lower). True when it was taken. */
export function noteVendorFloor(record: CompactionRecord | undefined, previous: number | undefined, used: number): boolean {
  if (!record || previous === undefined || used <= previous) return false;
  record.vendorFloor = Math.max(record.vendorFloor ?? 0, used);
  return true;
}

/** Note what the first turn after a compaction ran on. True when the record changed. */
export function noteContextAfterCompaction(session: CompactableSession): boolean {
  const record = session.compaction;
  if (!record || record.after !== undefined || turnsSinceCompaction(session) < 1) return false;
  const used = contextTokens(session.lastUsage);
  if (used === undefined || Date.parse(session.lastUsage!.at) < Date.parse(record.at)) return false;
  record.after = used;
  return true;
}

/** Whether a turn that has just ended should be followed by a compaction. `since`: when that
 * turn started -- a reading older than it belongs to another provider or an earlier turn. */
export function shouldCompact(session: CompactableSession, threshold: number, since: number): boolean {
  const usage = session.lastUsage;
  const used = contextTokens(usage);
  if (used === undefined || Date.parse(usage!.at) < since) return false;
  if (session.compaction && turnsSinceCompaction(session) < TURNS_BETWEEN_COMPACTIONS) return false;
  return used >= effectiveThreshold(threshold, session.compaction);
}
