/** This conversation, cut into topics from the stored transcript.
 *
 * A topic starts at a user request. "Continue", "do it", "check", "before
 * that", the other short replies, and a short direction change ("that is a
 * bandaid") stay in that topic. A request that asks for something else
 * starts the next one. Nothing here asks a model where the cuts are.
 * Message numbers in a span are whatever the caller stored on each message
 * (`index`); the cutter itself counts array positions. */

export interface HindsightMessage {
  /** Message number in the conversation's merged view. */
  index: number;
  role: 'user' | 'assistant';
  content: string;
  origin?: { harness?: string; provider: string | null; model: string | null };
  /** Tool labels the assistant message kept. */
  tools?: readonly string[];
}

export interface TopicSpan {
  /** Array position of the first message, inclusive. */
  start: number;
  /** Array position of the last message, inclusive. */
  end: number;
  requests: { at: number; text: string }[];
}

const CONTINUATION = /^(?:yes|no|yep|sure|continue|do it|do them(?: all)?|check(?: it)?|before that|make the changes|go ahead|ship it|keep going|use the tools)[.!]*$/i;
const OK_CONTINUATION = /^ok(?:ay)?[\s,.!]*?(?:do it|do them(?: all)?|check(?: it)?|make the changes|go ahead|continue|use the tools)?[.!]*$/i;

/** A single short user line that keeps going on the topic already open.
 * Anything with another line is a new request: the rest is what was asked. */
export function isContinuation(text: string): boolean {
  const line = text.trim();
  if (!line || line.includes('\n')) return false;
  return CONTINUATION.test(line) || OK_CONTINUATION.test(line);
}

const DECISION = /\b(?:do it|do them|make the changes|remove it|remove that|bandaid|wrong|stop|don't|do not)\b/i;

/** A short user line that changed direction. Long requests are not decisions,
 * and a decision is this line, not a paraphrase of it. */
export function isDecision(text: string): boolean {
  const line = text.trim();
  return line.length > 0 && line.length <= 180 && !line.includes('\n') && DECISION.test(line);
}

/** Topics in transcript order. The last one is the latest stored topic. */
export function topicSpans(messages: readonly { role: string; content: string }[]): TopicSpan[] {
  const spans: TopicSpan[] = [];
  let current: TopicSpan | undefined;
  messages.forEach((message, index) => {
    if (message.role === 'user') {
      const content = message.content.trim();
      if (!content) return;
      if (current && (isContinuation(content) || isDecision(content))) current.requests.push({ at: index, text: content });
      else {
        current = { start: index, end: index, requests: [{ at: index, text: content }] };
        spans.push(current);
      }
    }
    if (current && index >= current.start) current.end = index;
  });
  return spans;
}

export function oneLine(text: string, max = 90): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Who answered inside a span, from the stamps on its messages. */
export function originLabel(messages: readonly HindsightMessage[], fallback: string): string {
  const labels = new Set<string>();
  for (const message of messages) {
    const origin = message.origin;
    if (!origin) continue;
    const label = [origin.harness, origin.model].filter(Boolean).join(' ');
    if (label) labels.add(label);
  }
  return labels.size ? [...labels].join(', ') : fallback;
}

export interface TurnLike {
  at: string;
  prompt?: string;
  changes: readonly { path?: string; additions?: number; removals?: number }[];
}

/** Turn-log rows whose prompt is a request in this topic. Exact, or either
 * text contains the other when both are long enough to not be a short reply. */
export function recordsForRequests(requests: readonly string[], records: readonly TurnLike[]): TurnLike[] {
  return records.filter((record) => {
    const prompt = record.prompt?.trim() ?? '';
    if (!prompt) return false;
    return requests.some((request) => {
      const text = request.trim();
      if (!text) return false;
      if (prompt === text) return true;
      return prompt.length > 12 && text.length > 12 && (prompt.includes(text) || text.includes(prompt));
    });
  });
}

export interface PresentedTopic {
  /** Merged message numbers. Absent when the request is still only in the running turn. */
  from?: number;
  to?: number;
  requests: { index?: number; text: string }[];
  decisions: { index?: number; text: string }[];
  status: 'answered' | 'unanswered' | 'in progress';
  origin: string;
  tools: string[];
  files: { path: string; additions: number; removals: number }[];
  unnamedEdits: number;
  /** Set when a kept turn record matched. False when the log has nothing for the span. */
  logged: boolean;
  at?: string;
  finished?: string;
  unfinished?: string;
}

export interface PendingAsk {
  prompt: string;
  startedAt?: string;
  tools?: readonly string[];
  steers?: readonly string[];
}

const TOOL_CAP = 8;
const DECISION_CAP = 6;

function quoteDecisions(lines: { index?: number; text: string }[]): { index?: number; text: string }[] {
  const found = lines.filter((line) => isDecision(line.text));
  return found.length > DECISION_CAP ? found.slice(-DECISION_CAP) : found;
}

function filesFrom(records: readonly TurnLike[]): { files: { path: string; additions: number; removals: number }[]; unnamedEdits: number; at?: string } {
  const files = new Map<string, { path: string; additions: number; removals: number }>();
  let unnamedEdits = 0;
  for (const record of records) {
    for (const change of record.changes) {
      if (!change.path) {
        if ((change.additions ?? 0) + (change.removals ?? 0) > 0) unnamedEdits += 1;
        continue;
      }
      const prior = files.get(change.path) ?? { path: change.path, additions: 0, removals: 0 };
      prior.additions += change.additions ?? 0;
      prior.removals += change.removals ?? 0;
      files.set(change.path, prior);
    }
  }
  const at = records.map((record) => record.at).filter(Boolean).sort().at(-1);
  return { files: [...files.values()], unnamedEdits, ...(at ? { at } : {}) };
}

function presentSpan(span: TopicSpan, messages: readonly HindsightMessage[], records: readonly TurnLike[], originFallback: string, running: boolean): PresentedTopic {
  const slice = messages.slice(span.start, span.end + 1);
  const requests = span.requests.map((request) => ({ index: messages[request.at]!.index, text: messages[request.at]!.content.trim() }));
  const matched = recordsForRequests(requests.map((request) => request.text), records);
  const logged = filesFrom(matched);
  const tools: string[] = [];
  for (const message of slice) for (const label of message.tools ?? []) if (label && !tools.includes(label)) tools.push(label);
  const lastAssistant = [...slice].reverse().find((message) => message.role === 'assistant' && message.content.trim());
  const endsOnUser = slice.at(-1)?.role === 'user';
  const status = running ? 'in progress' : endsOnUser ? 'unanswered' : 'answered';
  return {
    from: messages[span.start]!.index,
    to: messages[span.end]!.index,
    requests,
    decisions: quoteDecisions(requests),
    status,
    origin: originLabel(slice, originFallback),
    tools: tools.slice(0, TOOL_CAP),
    files: logged.files,
    unnamedEdits: logged.unnamedEdits,
    logged: matched.length > 0,
    ...(logged.at ? { at: logged.at } : {}),
    ...(status === 'answered' && lastAssistant ? { finished: oneLine(lastAssistant.content) } : {}),
    ...(status !== 'answered' ? { unfinished: oneLine(requests.at(-1)?.text ?? '') } : {}),
  };
}

/** Stored topics, plus the running turn when its request is not one of them yet.
 * `back` 0 is the topic in progress. `back` 1 is the one before it. */
export function presentTopics(messages: readonly HindsightMessage[], options: { pending?: PendingAsk; records?: readonly TurnLike[]; originFallback: string }): { current?: PresentedTopic; earlier: PresentedTopic[] } {
  const records = options.records ?? [];
  const spans = topicSpans(messages);
  const pending = options.pending?.prompt.trim() ? options.pending : undefined;
  const last = spans.at(-1);
  const pendingText = pending?.prompt.trim() ?? '';
  const continuesLast = Boolean(pendingText && last && (
    last.requests.some((request) => messages[request.at]!.content.trim() === pendingText) || isContinuation(pendingText)
  ));
  const stored = spans.map((span, index) => presentSpan(span, messages, records, options.originFallback, Boolean(pending) && continuesLast && index === spans.length - 1));
  if (pending && continuesLast && stored.length) {
    const current = stored.at(-1)!;
    for (const steer of pending.steers ?? []) {
      const text = steer.trim();
      if (!text) continue;
      current.requests.push({ text });
      if (isDecision(text)) current.decisions = quoteDecisions([...current.decisions, { text }]);
    }
    for (const label of pending.tools ?? []) if (label && !current.tools.includes(label)) current.tools.push(label);
    current.tools = current.tools.slice(0, TOOL_CAP);
    if (!current.at && pending.startedAt) current.at = pending.startedAt;
    if (current.status === 'in progress') current.unfinished = oneLine(pendingText);
    return { current, earlier: stored.slice(0, -1) };
  }
  if (!pending) return { ...(stored.length ? { current: stored.at(-1) } : {}), earlier: stored.slice(0, -1) };
  const requests = [{ text: pendingText }, ...(pending.steers ?? []).map((steer) => ({ text: steer.trim() })).filter((steer) => steer.text)];
  const matched = recordsForRequests(requests.map((request) => request.text), records);
  const logged = filesFrom(matched);
  return {
    current: {
      requests,
      decisions: quoteDecisions(requests),
      status: 'in progress',
      origin: options.originFallback,
      tools: [...new Set(pending.tools ?? [])].slice(0, TOOL_CAP),
      files: logged.files,
      unnamedEdits: logged.unnamedEdits,
      logged: matched.length > 0,
      ...(logged.at || pending.startedAt ? { at: logged.at ?? pending.startedAt } : {}),
      unfinished: oneLine(pendingText),
    },
    earlier: stored,
  };
}

/** Drops topics whose turn-log time is newer than `cutoffMs`. A topic with
 * no kept time stays, so older work the log no longer dates is not hidden. */
export function topicsBefore(topics: readonly PresentedTopic[], cutoffMs: number | undefined): PresentedTopic[] {
  if (cutoffMs === undefined) return [...topics];
  return topics.filter((topic) => {
    if (!topic.at) return true;
    const at = Date.parse(topic.at);
    return Number.isNaN(at) || at <= cutoffMs;
  });
}

export function rangeLabel(topic: PresentedTopic): string {
  if (topic.from === undefined || topic.to === undefined) return 'not in the transcript yet';
  return topic.from === topic.to ? `#${topic.from}` : `#${topic.from}–#${topic.to}`;
}
