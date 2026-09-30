/** Aider's plain-text turn, read as the answer it is.
 *
 * `aider --message` prints its startup banner (version, models, git repo,
 * repo map, and -- for a model its tables do not know -- a warning with
 * suggestions), then the answer, then a `Tokens: … Cost: …` footer. All of it
 * went into the chat as the reply, and a chat moved to another harness carried
 * it along as history: a free model on Goose, handed a transcript of Aider
 * banners, answered with a made-up "failover restored" report.
 *
 * Live, only the lines between the banner and the footer are shown. The reply
 * kept is the one Aider writes to its own chat history file (the
 * `--chat-history-file` ClikCode passes for the session): the text after the
 * last `#### <request>` heading, without the `> ` lines Aider quotes its own
 * notices in. Checked against Aider 0.86. */

import type { StreamState } from './adapters.js';
import type { TurnUsage } from '../protocol/turn-usage.js';

/** Lines of Aider's banner and model warning, before the answer starts. */
const BANNER = [
  /^─+$/, /^\s*$/, /^Aider v\d/, /^(?:Main|Weak|Editor) model:/, /^Git repo:/, /^Repo-map:/, /^infinite output$/,
  /^Warning for /, /^Unknown context window/, /^and costs, using/, /^Did you mean one of these/, /^- \S+$/,
  /^You can skip this check/, /^https:\/\/aider\.chat\/docs\//, /^Restored previous conversation history/,
  /^Added .+ to the chat/, /^Use \/help/, /^Cost estimates may be inaccurate/,
];
const FOOTER = /^Tokens: .+ sent, .+ received/;
const COST = /Cost: \$([\d.]+) message/;

/** A count as Aider prints it (`format_tokens`): exact below 1000, then
 * `2.6k` or `12k`. The rounding is Aider's; nothing finer is published. */
function aiderCount(text: string | undefined): number | undefined {
  const match = text ? /^([\d.]+)(k?)$/.exec(text) : null;
  if (!match) return undefined;
  const value = Number(match[1]) * (match[2] ? 1000 : 1);
  return Number.isFinite(value) ? Math.round(value) : undefined;
}

/** Aider's per-call report (base_coder.py `usage_report`):
 * `Tokens: 12k sent, 3.1k cache write, 8.1k cache hit, 45 received.` then
 * `Cost: $0.0026 message, $0.0026 session.` -- on the same line, or on the
 * next one when both cache counts are present. `sent` is the prompt Aider
 * paid for (it adds cache writes in, and excludes cache hits). */
export function aiderFooterUsage(lineText: string): TurnUsage | undefined {
  const line = lineText.trim().replace(/^> /, '');
  if (!FOOTER.test(line)) return undefined;
  const count = (label: string): number | undefined => aiderCount(new RegExp(`([\\d.]+k?) ${label}\\b`).exec(line)?.[1]);
  const usage: TurnUsage = {};
  const input = count('sent');
  const output = count('received');
  const cacheWrite = count('cache write');
  const cacheRead = count('cache hit');
  const cost = Number(COST.exec(line)?.[1]);
  if (input !== undefined) usage.input = input;
  if (output !== undefined) usage.output = output;
  if (cacheRead !== undefined) usage.cacheRead = cacheRead;
  if (cacheWrite !== undefined) usage.cacheWrite = cacheWrite;
  if (Number.isFinite(cost)) usage.costUsd = cost;
  return Object.keys(usage).length ? usage : undefined;
}

/** One stdout line: the answer's text, or nothing (banner, footer). A
 * footer is the turn's usage: one per model call, summed. */
export function aiderLine(lineText: string, turn: StreamState | undefined): { response?: { text: string; mode: 'append' }; usage?: TurnUsage } {
  const state = turn ?? ({} as StreamState);
  const phase = state.textPhase ?? 'banner';
  const footer = aiderFooterUsage(lineText);
  if (footer) {
    state.textPhase = 'done';
    const usage = state.usage?.add(footer);
    return usage ? { usage } : {};
  }
  if (phase === 'done') {
    // The cost of the call just reported, printed on a line of its own.
    const cost = /^Cost: /.test(lineText.trim()) ? Number(COST.exec(lineText)?.[1]) : Number.NaN;
    const usage = Number.isFinite(cost) ? state.usage?.amendLatest({ costUsd: cost }) : undefined;
    return usage ? { usage } : {};
  }
  if (phase === 'banner' && BANNER.some((pattern) => pattern.test(lineText.trim()))) return {};
  state.textPhase = 'reply';
  return { response: { text: `${lineText}\n`, mode: 'append' } };
}

/** The last reply in an Aider chat history file, or undefined when there is
 * none to read. */
export function aiderHistoryReply(markdown: string): string | undefined {
  const lines = markdown.split(/\r?\n/);
  let start = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index]!.startsWith('#### ')) { start = index + 1; break; }
  }
  if (start < 0) return undefined;
  const reply = lines.slice(start)
    // Aider quotes its own notices (`> Tokens: …`, `> Applied edit to …`),
    // one line each ending in a markdown break; a quote in the model's own
    // text does not end that way, and stays.
    .filter((line) => !/^>(?: .*(?: {2}|\.\d+ session\.)|)$/.test(line))
    .join('\n')
    .trim();
  return reply || undefined;
}

/** The answer from Aider's stdout alone: what aiderLine shows, joined. For a
 * turn with no history file to read. */
export function aiderStdoutReply(stdout: string): string | undefined {
  const state = {} as StreamState;
  const text = stdout.split(/\r?\n/).map((line) => aiderLine(line, state).response?.text ?? '').join('').trim();
  return text || undefined;
}

/** Why the last turn in an Aider chat history file has no reply: the notice
 * Aider quoted under its heading (`> litellm.NotFoundError: …`), preferring
 * the one that names an error. Undefined when there is nothing quoted. */
export function aiderHistoryNotice(markdown: string): string | undefined {
  const lines = markdown.split(/\r?\n/);
  let start = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index]!.startsWith('#### ')) { start = index + 1; break; }
  }
  if (start < 0) return undefined;
  const notices = lines.slice(start).filter((line) => line.startsWith('> ')).map((line) => line.slice(2).trim()).filter(Boolean);
  return notices.find((line) => /error/i.test(line)) ?? notices[0];
}
