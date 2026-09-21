import { activityLabelIsReadOnly, sessionTranscriptMessages, type PendingTurnWithHints } from './turn-checkpoint.js';
import type { HarnessSession } from './types.js';

export type AccountFailureKind = 'quota-exhausted' | 'temporarily-throttled' | 'authentication-required' | 'native-thread-invalid' | 'other';

/** Usage probes deliberately return display labels so provider-specific
 * response shapes stay out of routing. Interpret only explicit percentage
 * windows here; token/cost labels and unavailable probes remain unknown. Any
 * exhausted window is enough to make an account unusable for a new turn. */
export function usageLabelIsExhausted(label: string | undefined): boolean {
  return (usageLabelRemainingPercent(label) ?? 1) <= 0;
}

/** Most constrained remaining window; higher is better for routing headroom.
 * The legacy `used` form remains readable during cache/version migration. */
export function usageLabelRemainingPercent(label: string | undefined): number | undefined {
  if (!label) return undefined;
  const left = [...label.matchAll(/(\d+(?:\.\d+)?)%\s*left/gi)].map((match) => Number(match[1]));
  if (left.length) return Math.min(...left);
  const used = [...label.matchAll(/(\d+(?:\.\d+)?)%\s*used/gi)].map((match) => Number(match[1]));
  return used.length ? 100 - Math.max(...used) : undefined;
}

/** Machine-readable failure signals. Always preferred over wording: a status
 * code or a vendor error type cannot be produced by the model talking about
 * rate limits. */
export interface AccountFailureSignals {
  /** HTTP/API status (Claude's `api_error_status`, a gateway response status). */
  statusCode?: number;
  /** Vendor error type/code, e.g. 'authentication_error', 'rate_limit_error',
   * 'insufficient_quota', or a result subtype. */
  errorKind?: string;
  /** true: the message is the vendor's own declared error result, safe to read.
   * false: the message is (or may be) model-authored text; never read it. */
  isResultError?: boolean;
  /** Latest rate-limit event status: 'allowed' | 'allowed_warning' | 'rejected'. */
  rateLimitStatus?: string;
  /** The vendor CLI's stderr, when the caller has it separately. */
  stderrText?: string;
}

const AUTH_TEXT = /(?:not authenticated|authentication (?:required|failed|error)|login required|please (?:log|sign) ?in|not logged in|unauthorized|invalid (?:api[ _-]?key|credentials|token)|(?:token|session|credentials?) (?:has |have )?expired|oauth token (?:has )?(?:expired|been revoked))/i;
const QUOTA_TEXT = /(?:quota (?:exceeded|exhausted)|insufficient[_ ]quota|(?:usage|session|plan|weekly|monthly|daily) limit(?: reached)?|you(?:'ve| have) hit your limit|credits? exhausted|out of credits|billing (?:hard )?limit|payment required|(?:balance|funds|credit) (?:is )?(?:exhausted|depleted)|insufficient (?:balance|funds|credit))/i;
const THROTTLE_TEXT = /(?:rate limit|too many requests|temporar(?:y|ily) throttled)/i;

function kindFromErrorKind(errorKind: string): AccountFailureKind | undefined {
  if (/auth|unauthori[sz]ed|invalid_?api_?key|invalid_?(?:token|credentials|grant)|token_?expired|login/i.test(errorKind)) return 'authentication-required';
  if (/quota|billing|credit|payment|usage_?limit|limit_?(?:reached|exceeded)$/i.test(errorKind) && !/rate/i.test(errorKind)) return 'quota-exhausted';
  if (/rate_?limit|too_?many_?requests|throttl/i.test(errorKind)) return 'temporarily-throttled';
  return undefined;
}

/** Classify only signals strong enough to justify changing credentials.
 *
 * Order of trust: explicit structured signals, then status codes, then the
 * wording of vendor *diagnostics*. Wording is only ever read from stderr (the
 * `stderrTail` that captureNativeHarnessTurn attaches, or `signals.stderrText`)
 * or from an error the caller did not mark as model text -- never from a
 * turn's stdout, where "I hit the rate limit handling code" is just prose. */
export function classifyAccountFailure(error: unknown, signals: AccountFailureSignals = {}): AccountFailureKind {
  const carried = (error ?? {}) as {
    statusCode?: unknown; response?: { status?: unknown }; errorKind?: unknown; rateLimitStatus?: unknown;
    stderrTail?: unknown; stdoutTail?: unknown;
  };
  const rawStatus = signals.statusCode ?? carried.statusCode ?? carried.response?.status;
  const status = typeof rawStatus === 'number' ? rawStatus : undefined;
  // Some harnesses report the code only inside the message they print. Grok
  // Build's failure is a result record whose `errors` array holds
  // 'API error (status 402 Payment Required): ... usage balance exhausted' --
  // no status field anywhere, so a turn that plainly ran out of money was
  // classified 'other' and never reached the failover path at all.
  const embeddedStatus = (text: string): number | undefined => {
    const found = /(?:\bstatus[ :]+|"http_status"\s*:\s*)(\d{3})\b/i.exec(text)?.[1];
    const code = found ? Number(found) : undefined;
    return code !== undefined && code >= 400 && code < 600 ? code : undefined;
  };
  const errorKind = signals.errorKind ?? (typeof carried.errorKind === 'string' ? carried.errorKind : undefined);
  const rateLimitStatus = signals.rateLimitStatus ?? (typeof carried.rateLimitStatus === 'string' ? carried.rateLimitStatus : undefined);
  const message = error instanceof Error ? error.message : String(error ?? '');
  // An error that carries its streams separately is classified by stderr alone:
  // its message may embed stdout. Otherwise the message is the error's own
  // text, unless the caller says it is not a vendor-declared error.
  const hasStreams = typeof carried.stderrTail === 'string' || typeof carried.stdoutTail === 'string';
  const text = signals.stderrText !== undefined || hasStreams
    ? [signals.stderrText, typeof carried.stderrTail === 'string' ? carried.stderrTail : undefined].filter(Boolean).join('\n')
    : signals.isResultError === false ? '' : message;

  const fromKind = errorKind ? kindFromErrorKind(errorKind) : undefined;
  if (fromKind) return fromKind;
  const effectiveStatus = status ?? embeddedStatus(text || message);
  if (effectiveStatus === 401) return 'authentication-required';
  if (effectiveStatus === 402) return 'quota-exhausted';
  // 403 is also "this model is not on your plan", "region blocked", a WAF, or
  // a content policy refusal. Marking the account needs_login for those sends
  // the user through a sign-in that cannot fix anything.
  if (AUTH_TEXT.test(text)) return 'authentication-required';
  if (rateLimitStatus === 'rejected' || QUOTA_TEXT.test(text)) return 'quota-exhausted';
  if (status === 429 || THROTTLE_TEXT.test(text)) return 'temporarily-throttled';
  // Confirmed verbatim from a real, reproduced Codex error: "thread/resume:
  // thread/resume failed: no rollout found for thread id ...". A stale
  // nativeSessionId (the account it was created under no longer matches the
  // session's current account -- switching accounts within the same
  // provider used to leave it untouched) is recoverable, not fatal: clear
  // it and let the existing failoverPrompt rehydration path start a fresh
  // thread from the real stored transcript instead of surfacing this raw
  // vendor error. Only Codex's exact confirmed wording is matched here --
  // no other vendor's equivalent phrasing has been verified, so none is
  // guessed at.
  if (/no rollout found/i.test(text)) return 'native-thread-invalid';
  return 'other';
}

/**
 * Caps how much prior transcript gets replayed into a fresh native thread.
 * Uncapped replay grows every prompt's cost and context-window usage in lockstep
 * with total conversation length, on every provider/account switch — bounding it
 * to the most recent exchanges keeps switching cheap regardless of how long the
 * conversation has run.
 */
const MAX_REPLAY_MESSAGES = 40;
/** Total UTF-8 budget for a rehydration prompt. A message count alone bounds
 * nothing: forty messages of pasted logs is megabytes, which overflows argv
 * (E2BIG) for prompt-as-argument harnesses and the context window for all. */
export const FAILOVER_PROMPT_MAX_BYTES = 48 * 1024;
/** Newest messages replayed verbatim (budget permitting). */
const VERBATIM_MESSAGES = 6;
/** Cap for each older message. */
const OLDER_MESSAGE_MAX_BYTES = 2 * 1024;

export interface FailoverPromptOptions {
  /** Total prompt budget in UTF-8 bytes. Defaults to FAILOVER_PROMPT_MAX_BYTES. */
  maxBytes?: number;
  /** Files the interrupted turn had started changing. */
  touchedFiles?: readonly string[];
}

const bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

/** Transcript content is data inside an XML-ish frame. Only the frame's own
 * tags are neutralized, so code in the transcript (generics, JSX, HTML) stays
 * readable while `</message>` in a message can no longer end it early and
 * smuggle the rest in as a forged turn or request. */
export function escapeFailoverContent(text: string): string {
  return text.replace(/<(\/?)(message|conversation|current_request|touched_files)\b/gi, '&lt;$1$2');
}

function sliceBytes(text: string, maxBytes: number, from: 'start' | 'end'): string {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) return text;
  const part = from === 'start' ? buffer.subarray(0, maxBytes) : buffer.subarray(buffer.length - maxBytes);
  // Drop the partial code point a byte cut can leave at either edge.
  return part.toString('utf8').replace(/^�+|�+$/g, '');
}

/** Head and tail of an over-long message: how it began and where it ended up. */
function truncateMiddle(text: string, maxBytes: number): string {
  const total = bytes(text);
  if (total <= maxBytes) return text;
  const room = Math.max(64, maxBytes - 64);
  const head = sliceBytes(text, Math.ceil(room * 0.6), 'start');
  const tail = sliceBytes(text, Math.floor(room * 0.4), 'end');
  return `${head}\n[… ${total - bytes(head) - bytes(tail)} bytes truncated …]\n${tail}`;
}

/** Rehydrate a new vendor-native session after switching account profiles or providers. */
export function failoverPrompt(
  messages: readonly { role: 'user' | 'assistant'; content: string }[],
  currentPrompt: string,
  options: FailoverPromptOptions = {},
): string {
  const maxBytes = Math.max(1024, options.maxBytes ?? FAILOVER_PROMPT_MAX_BYTES);
  const preamble = 'Continue the same ClikCode conversation after an account or provider failover. Preserve all prior decisions, files, and task state. Do not repeat completed work.';
  const touched = (options.touchedFiles ?? []).filter((file) => file.trim());
  const touchedBlock = touched.length
    ? `\n\n<touched_files>\nThe interrupted turn had started changing these files; they may be partially edited. Check each before editing again:\n${touched.map((file) => `- ${escapeFailoverContent(file)}`).join('\n')}\n</touched_files>`
    : '';
  // The current request is what the user actually asked for: it is never
  // dropped, only (pathologically) trimmed so the frame itself still fits.
  const request = truncateMiddle(escapeFailoverContent(currentPrompt), Math.floor(maxBytes * 0.5));
  const fixed = bytes(preamble) + bytes(touchedBlock) + bytes(request) + 160;
  let remaining = Math.max(0, maxBytes - fixed);

  const recent = messages.slice(-MAX_REPLAY_MESSAGES);
  const kept: string[] = [];
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const message = recent[index]!;
    const age = recent.length - 1 - index;
    const escaped = escapeFailoverContent(message.content);
    const frame = `<message role="${message.role}">\n\n</message>\n`;
    const room = remaining - bytes(frame);
    if (room < 128) break;
    const content = truncateMiddle(escaped, age < VERBATIM_MESSAGES ? room : Math.min(room, OLDER_MESSAGE_MAX_BYTES));
    kept.unshift(`<message role="${message.role}">\n${content}\n</message>`);
    remaining -= bytes(frame) + bytes(content);
  }
  const omitted = messages.length - kept.length;
  const note = omitted > 0 ? `\n\n(${omitted} earlier message${omitted === 1 ? '' : 's'} omitted for brevity.)` : '';
  return `${preamble}\n\n<conversation>${note}\n${kept.join('\n')}\n</conversation>${touchedBlock}\n\n<current_request>\n${request}\n</current_request>`;
}

export const INTERRUPTED_TURN_REQUEST = 'Continue the interrupted latest request. Inspect the current workspace first and finish the remaining work without repeating completed steps.';

/** Rehydration prompt for a turn that was cut off mid-flight, including the
 * files it is known to have started changing. */
export function interruptedTurnFailoverPrompt(session: HarnessSession, options: FailoverPromptOptions = {}): string {
  const touchedFiles = options.touchedFiles ?? (session.pendingTurn as PendingTurnWithHints | undefined)?.touchedFiles;
  return failoverPrompt(sessionTranscriptMessages(session), INTERRUPTED_TURN_REQUEST, { ...options, ...(touchedFiles ? { touchedFiles } : {}) });
}

