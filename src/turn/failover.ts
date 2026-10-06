/** `request-invalid` is the odd one out and the reason it exists: every other
 *  kind describes something about the ACCOUNT, so trying the next account is a
 *  sensible response. A rejected request is about the REQUEST -- the same argv
 *  will be refused identically by every account, so failing over just walks
 *  the whole list failing the same way. */
export type AccountFailureKind = 'quota-exhausted' | 'temporarily-throttled' | 'authentication-required' | 'native-thread-invalid' | 'request-invalid' | 'account-ineligible' | 'other';

/** Machine-readable failure signals. Always preferred over wording: a status
 * code or a vendor error type cannot be produced by the model talking about
 * rate limits. */
interface AccountFailureSignals {
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

// 'no auth type is selected' is Qwen Code's own wording (captured verbatim
// from a real unhandledRejection on this machine: "Qwen Code: No auth type
// is selected. Please configure an auth type (e.g. via settings or
// `--auth-type`) before running in non-interactive mode."). It names a
// missing/unselected credential rather than an expired or rejected one, so
// none of the other AUTH_TEXT wordings matched it and it fell through as
// 'other'.
// "No API key found for provider …" and "No route-compatible authentication
// source is configured for openai." are OpenClaw's (2026.9.6); "No access
// token found for Nous Portal login." is Hermes's.
const AUTH_TEXT = /(?:not authenticated|authentication (?:is )?(?:required|failed|error)|login required|please (?:log|sign) ?in|not logged in|unauthorized|invalid (?:api[ _-]?key|credentials|token)|(?:token|session|credentials?) (?:has |have )?expired|oauth token (?:has )?(?:expired|been revoked)|no auth type is selected|headless mode requires existing settings|no (?:api[ _-]?key|access token) found|no (?:route-compatible )?authentication source is configured|authentication[_ ]?error|incorrect api[ _-]?key|(?:invalid or )?missing api[ _-]?key|api key required|no api key (?:for|found)|no credentials (?:are )?(?:configured|found)|not signed in|no longer authenticated|please authenticate|needs authentication|re-?authenticate|authori[sz]ation (?:with .{0,40})?failed|invalid or expired|has expired\b|\bsign (?:in|up) (?:to|or) |run [`'"]?[\w-]+ login\b|run \/(?:login|auth)\b|no [\w ]{0,30}auth token found|\bPAID_MODEL_AUTH_REQUIRED\b)/i;
// Both halves of "ran out" matter, because vendors write it either way
// round. Captured verbatim from real refusals on this machine:
//   antigravity  'RESOURCE_EXHAUSTED (code 429): Individual quota reached.
//                 ... Resets in 76h57m39s.'
//   copilot      'You have exceeded your monthly quota'
// Neither matched before: the first says "quota reached" where the pattern
// wanted exceeded/exhausted, and the second puts the verb BEFORE the noun.
// Both were therefore classified 'other' and shown as "account failed …
// retrying", which is how a spent plan came to read like a crash.
// 'spend limit' is Command Code's own wording, confirmed from the CLI's own
// installed dist (command-code@1.62.1, the status label constant
// SPEND_LIMIT_REACHED: "Spend limit reached"). It names a configured spend
// cap rather than a usage/plan/quota window, so it did not match the
// existing "…limit" alternation, which only covers usage/session/plan/
// weekly/monthly/daily.
// Cursor's own error codes (cursor-agent 2026.09.26's ErrorDetails enum):
// FREE_USER_USAGE_LIMIT / PRO_USER_USAGE_LIMIT / USAGE_PRICING_REQUIRED for a
// spent plan, *_RATE_LIMIT_EXCEEDED and RATE_LIMITED for throttling.
// "Upgrade your plan/account to continue" is Cursor's ActionRequiredError
// action `upgrade` (cursor-agent 2026.09.26): it is written into the chat as
// an agent_message_chunk, not as a structured error code. Same for "Add a
// payment method to continue" (action `payment`).
const QUOTA_TEXT = /(?:\b(?:FREE|PRO)_USER_USAGE_LIMIT\b|\bUSAGE_PRICING_REQUIRED|\bPROMOTION_MODEL_LIMIT_REACHED\b|UsageLimitError\b|quota (?:has been |is )?(?:exceeded|exhausted|reached|used up)|quota\b[^.\n]{0,40}\bused up|quota to reset|(?:weekly|monthly|daily) (?:\w+ )?limit (?:has been )?reached|\bacu limit|usage (?:limit )?exceeded|usage (?:is )?(?:paused|frozen)|paused usage|insufficient[_ ](?:\w+ )?(?:balance|funds|credits?)|not enough credits|no credits|credits? (?:is |are )?(?:exhausted|depleted)|billing (?:issue|error)|exceeded (?:your |the )?(?:\w+ ){0,3}quota|resource[_ ]exhausted|insufficient[_ ]quota|(?:usage|session|plan|weekly|monthly|daily|spend) limit(?: reached)?|you(?:'ve| have) hit your limit|credits? exhausted|(?:ran|run) out of (?:usage|quota)|out of credits|(?:add|buy|purchase) (?:more )?credits|insufficient credits|billing (?:hard )?limit|payment required|(?:balance|funds|credit) (?:is )?(?:exhausted|depleted)|insufficient (?:balance|funds|credit)|upgrade your (?:plan|account) to continue|add a payment method to continue)/i;
const THROTTLE_TEXT = /(?:rate[ _-]?limit|\bRATE_LIMITED\b|too many requests|temporar(?:y|ily) throttled)/i;
/** The account is real and signed in, but the vendor will not serve it --
 *  a plan or verification problem rather than a credential one. Confirmed
 *  verbatim from agy 1.2.7 on a refreshed, valid token:
 *    "Eligibility check failed: Your current account is not eligible for
 *     Antigravity. Verify your account to continue."
 *  It matched none of the patterns above, so it classified as 'other' and
 *  the user was told "account failed" -- true but useless, since it names
 *  neither the problem nor the fix. Signing in again cannot help, which is
 *  why this is distinct from authentication-required. */
const INELIGIBLE_TEXT = /(?:not eligible|ineligible|eligibility check failed|verify your account|account (?:is )?not verified|(?:no|not have a) valid license|requires? a (?:paid|pro|business|enterprise) (?:plan|subscription)|subscription does not have access|client is no longer supported for .*individual|no active .{0,40}subscription|not granted you access|no profiles available)/i;
/** A vendor refusing the ARGV, not the credentials. Confirmed verbatim against
 * agy 1.2.7 on a real authenticated Antigravity account, which is where this
 * came from: ClikCode sent `--effort` alongside `--model`, and Antigravity
 * encodes effort in the model id instead, so it answered
 *   'invalid model selection (--model "claude-opus-4-6-thinking"
 *    --effort "medium"): --effort is not supported for model ...'
 * and for a mismatched pair
 *   '--model gpt-oss-120b-medium conflicts with --effort=high'.
 * Every account then failed the same way, which read to the user as "all my
 * accounts are broken" -- and one unauthenticated account in the list made
 * each pointless attempt cost a 60-second interactive-auth timeout. Kept to
 * wording a CLI uses for its own flag validation; nothing here matches a
 * model or plan entitlement problem, which IS account-specific. */
const REQUEST_INVALID_TEXT = /(?:invalid model selection|conflicts with --|is not supported for model|unknown (?:flag|option|argument)|unrecogni[sz]ed (?:flag|option|argument)|invalid (?:flag|option|argument) value)/i;

function kindFromErrorKind(errorKind: string): AccountFailureKind | undefined {
  if (/auth|unauthori[sz]ed|invalid_?api_?key|invalid_?(?:token|credentials|grant)|token_?expired|login/i.test(errorKind)) return 'authentication-required';
  if (/quota|billing|credit|payment|usage_?limit|limit_?(?:reached|exceeded)$/i.test(errorKind) && !/rate/i.test(errorKind)) return 'quota-exhausted';
  if (/rate_?limit|too_?many_?requests|throttl/i.test(errorKind)) return 'temporarily-throttled';
  return undefined;
}

/** What to tell someone when a turn moves to another account.
 *
 * The message used to be one of two words -- "quota reached" or the catch-all
 * "account failed" -- so an ineligible account, an expired sign-in and a
 * crash all read identically, and none of them said what to do about it. The
 * classifier already knows which it was; this just says it out loud. */
export function accountFailureReason(kind: AccountFailureKind): string {
  switch (kind) {
    case 'quota-exhausted': return 'usage exhausted';
    case 'temporarily-throttled': return 'rate limited';
    case 'authentication-required': return 'sign-in needed';
    case 'account-ineligible': return 'account not eligible';
    case 'native-thread-invalid': return 'thread expired';
    default: return 'account failed';
  }
}

/** An account the vendor will not serve until it is verified. The vendor's
 * own error carries the fix -- agy prints the Google verification link -- but
 * it was only ever read for classification, so the user saw "account not
 * eligible" with nothing to act on. Undefined for any other failure; `url` is
 * absent when the vendor printed none.
 *
 * The link is not always Google's: only Antigravity's eligibility error is
 * confirmed so far, but any vendor's ineligible-account error is just as
 * likely to carry its own verification URL, not necessarily
 * accounts.google.com. Extract whichever https:// URL the vendor printed,
 * preferring an accounts.google.com one when several appear in the same
 * text (mixed error text can otherwise surface a doc/help link ahead of the
 * actual verification step). */
export function accountVerification(error: unknown): { url?: string } | undefined {
  const carried = (error ?? {}) as { stderrTail?: unknown; message?: unknown };
  const text = [carried.stderrTail, carried.message].filter((part): part is string => typeof part === 'string').join('\n');
  if (!INELIGIBLE_TEXT.test(text)) return undefined;
  const urls = [...text.matchAll(/https:\/\/[^\s"')]+/g)].map((match) => match[0]);
  const url = urls.find((candidate) => /^https:\/\/accounts\.google\.com\//.test(candidate)) ?? urls[0];
  return url ? { url } : {};
}

const DURATION_UNIT_MS: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000 };

/** When a quota refusal says it ends, as an ISO time -- or undefined when it
 * does not say. Read from the vendor's own diagnostics, never a turn's stdout.
 *
 * The forms seen in real refusals: Antigravity's 'Resets in 76h57m39s.',
 * Codex's 'try again in 2 days 3 hours 5 minutes', and the common
 * 'retry after 3600 seconds', and Codex's wall clock 'try again at 10:38 AM'
 * (clockTimeHint). A wall-clock time is read as its NEXT occurrence: the
 * earliest it can mean, so an account is at worst tried early and refused
 * again -- never parked for a day it did not need. */
export function quotaRetryHint(error: unknown, now: number = Date.now()): string | undefined {
  const carried = (error ?? {}) as { stderrTail?: unknown; message?: unknown };
  const text = [carried.stderrTail, carried.message].filter((part): part is string => typeof part === 'string').join('\n');
  const phrase = /(?:resets?|try again|retry(?: again)?)\s+(?:in|after)\s+((?:\d+(?:\.\d+)?\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?![a-z])[\s,]*(?:and\s+)?)+)/i.exec(text)?.[1];
  if (phrase) {
    let total = 0;
    for (const part of phrase.matchAll(/(\d+(?:\.\d+)?)\s*([dhms])/gi)) total += Number(part[1]) * DURATION_UNIT_MS[part[2]!.toLowerCase()]!;
    if (total > 0) return new Date(now + total).toISOString();
  }
  const stamp = /(?:resets?|try again|retry(?: again)?)\s+(?:at|after)\s+(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2}))/i.exec(text)?.[1];
  const at = stamp ? Date.parse(stamp) : Number.NaN;
  if (Number.isFinite(at) && at > now) return new Date(at).toISOString();
  // "Usage resets over a rolling 24-hour window" (Grok Free): what the turn
  // spent comes back only as the window rolls past it.
  const rolling = /rolling (\d+)[- ]hour window/i.exec(text)?.[1];
  if (rolling) return new Date(now + Number(rolling) * 3_600_000).toISOString();
  return clockTimeHint(text, now);
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** "try again at 10:38 AM" / "at Oct 6th, 2026 9:00 AM" / "at 14:05" -- a
 * wall-clock time, as Codex words it: the vendor CLI runs here, so the time is
 * this machine's local time, and without a date it is the next time the clock
 * reads that. Codex's whole refusal used to be read as no reset at all, so a
 * turn gave up on an account a minute before it came back. */
function clockTimeHint(text: string, now: number): string | undefined {
  const match = /(?:resets?|try again|retry(?: again)?)\s+(?:at|after)\s+(?:([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:(\d{4}),?\s+)?)?(\d{1,2}):(\d{2})\s*(am|pm)?(?![\w:])/i.exec(text);
  if (!match) return undefined;
  const [, month, day, year, hourText, minuteText, meridiem] = match;
  let hour = Number(hourText);
  const minute = Number(minuteText);
  if (minute > 59 || hour > 23 || (meridiem && (hour < 1 || hour > 12))) return undefined;
  if (meridiem) hour = (hour % 12) + (meridiem.toLowerCase() === 'pm' ? 12 : 0);
  const at = new Date(now);
  at.setSeconds(0, 0);
  at.setHours(hour, minute);
  if (month) {
    const index = MONTHS.indexOf(month.toLowerCase());
    if (index < 0) return undefined;
    at.setMonth(index, Number(day));
    if (year) at.setFullYear(Number(year));
    else if (at.getTime() <= now) at.setFullYear(at.getFullYear() + 1);
  } else if (at.getTime() <= now) at.setDate(at.getDate() + 1);
  return at.getTime() > now ? at.toISOString() : undefined;
}

export function verificationNotice(verification: { url?: string }): string {
  if (!verification.url) return 'Account needs verification with its provider';
  return /^https:\/\/accounts\.google\.com\//.test(verification.url)
    ? `Google needs verification: ${verification.url}`
    : `Verification needed: ${verification.url}`;
}

/** One account switch, worded the same way wherever it happens.
 *
 * There are four switch sites -- native and api-key, each with a pre-turn
 * check and a reactive one -- and every one of them had written this line for
 * itself. They had drifted into two different wordings for the same event:
 * the pre-turn pair said "quota exhausted … switching to X" while the
 * reactive pair said "<reason> … retrying…". Running out of usage is not a
 * retry, and saying so made a spent plan read like a flaky one.
 *
 * `from` is deliberately a LABEL. The api-key sites were passing an account
 * ID into the same `accountSwitchedFrom` output field the native sites filled
 * with a label, so a headless consumer got a UUID from one path and a name
 * from the other. */
export function accountSwitchNotice(kind: AccountFailureKind, to: string): string {
  return kind === 'quota-exhausted'
    ? `out of usage, switching to ${to}`
    : `${accountFailureReason(kind)}, switching to ${to}`;
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
    // "HTTP 402" too: OpenClaw's "request failed (provider billing issue, HTTP 402)".
    const found = /(?:\bstatus[ :]+|"http_status"\s*:\s*|\bHTTP[ /](?:\d\.\d )?)(\d{3})\b/i.exec(text)?.[1];
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

  // A generic HTTP 429/rate-limit kind also wraps spent subscriptions. The
  // subscription's explicit refusal is more specific than that envelope.
  if (/subscription:[\w-]*usage-exhausted/i.test(text)) return 'quota-exhausted';
  const fromKind = errorKind ? kindFromErrorKind(errorKind) : undefined;
  if (fromKind) return fromKind;
  const effectiveStatus = status ?? embeddedStatus(text || message);
  if (effectiveStatus === 401) return 'authentication-required';
  if (effectiveStatus === 402) return 'quota-exhausted';
  // 403 is also "this model is not on your plan", "region blocked", a WAF, or
  // a content policy refusal. Marking the account needs_login for those sends
  // the user through a sign-in that cannot fix anything.
  // Kimi prefixes a plan denial with "Authentication required: 403"; Gemini
  // prefixes an individual-account shutdown with client wording. Re-login
  // cannot fix either, so these explicit eligibility denials take precedence.
  if (INELIGIBLE_TEXT.test(text)) return 'account-ineligible';
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
  // Last, so a genuine auth/quota/throttle signal always wins: those can
  // legitimately be worded as a rejection too, and they ARE worth another
  // account.
  if (REQUEST_INVALID_TEXT.test(text)) return 'request-invalid';
  return 'other';
}
