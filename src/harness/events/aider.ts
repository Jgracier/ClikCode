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

/** Lines of Aider's banner and model warning, before the answer starts. */
const BANNER = [
  /^─+$/, /^\s*$/, /^Aider v\d/, /^(?:Main|Weak|Editor) model:/, /^Git repo:/, /^Repo-map:/, /^infinite output$/,
  /^Warning for /, /^Unknown context window/, /^and costs, using/, /^Did you mean one of these/, /^- \S+$/,
  /^You can skip this check/, /^https:\/\/aider\.chat\/docs\//, /^Restored previous conversation history/,
  /^Added .+ to the chat/, /^Use \/help/, /^Cost estimates may be inaccurate/,
];
const FOOTER = /^Tokens: .+ sent, .+ received/;

/** One stdout line: the answer's text, or nothing (banner, footer). */
export function aiderLine(lineText: string, turn: StreamState | undefined): { response?: { text: string; mode: 'append' } } {
  const state = turn ?? ({} as StreamState);
  const phase = state.textPhase ?? 'banner';
  if (phase === 'done') return {};
  if (FOOTER.test(lineText.trim())) {
    state.textPhase = 'done';
    return {};
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
