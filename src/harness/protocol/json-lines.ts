/** Reading what a vendor CLI wrote: JSONL, a single JSON document, or the
 * near-miss shapes particular harnesses emit. Nothing here knows what the
 * records mean. */



export type JsonRecord = Record<string, unknown>;

export const asRecord = (value: unknown): JsonRecord | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : undefined;

function recordsOf(parsed: unknown): JsonRecord[] {
  const out: JsonRecord[] = [];
  for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
    const record = asRecord(item);
    if (record) out.push(record);
  }
  return out;
}

/** Harnesses whose stream is Claude Code's stream-json, or OpenCode's -- by
 * the stream format the catalog DECLARES (`parser`), not by name.
 *
 * These were sets of command names, `claude` and `qwen`. Grok Build, Gemini
 * CLI and Amp declare the same `claude-stream-json` stream and were missed in
 * every place that asked -- the same mistake, in the same shape, as the
 * response parser that doubled their output: the final answer was saved as
 * `result` alone (the last text block, so every paragraph before the final
 * tool call vanished when the turn ended), and their tool calls were not read
 * as tool rows at all. The names stay only for a harness that speaks the
 * shape without declaring it. */
const CLAUDE_SHAPED_NAMES = new Set(['claude', 'qwen']);
const OPENCODE_SHAPED_NAMES = new Set(['opencode', 'kilo']);

type Shaped = { command: string; parser?: string };

export function claudeShaped(harness: Shaped): boolean {
  return harness.parser === 'claude-stream-json' || CLAUDE_SHAPED_NAMES.has(harness.command);
}

export function opencodeShaped(harness: Shaped): boolean {
  return harness.parser === 'opencode-json' || OPENCODE_SHAPED_NAMES.has(harness.command);
}

/** Vendors interleave banners, deprecation warnings and progress chatter with
 * their JSON records. The streaming adapter has always skipped such lines; the
 * final-result parsers must agree with it, or a turn the user watched succeed
 * is reported as failed because of one warning line. */
export function parseJsonLines(text: string): { values: JsonRecord[]; skipped: string[] } {
  const values: JsonRecord[] = [];
  const skipped: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const candidate = line.trim();
    if (!candidate) continue;
    if (candidate[0] !== '{' && candidate[0] !== '[') { skipped.push(candidate); continue; }
    try {
      const parsed: unknown = JSON.parse(candidate);
      const records = recordsOf(parsed);
      if (records.length) values.push(...records);
      else skipped.push(candidate);
    } catch {
      skipped.push(candidate); // fail-open-ok: a non-JSON line is not a record
    }
  }
  return { values, skipped };
}

/** A single JSON document, tolerating a banner before or after it. */
export function parseJsonDocument(text: string): JsonRecord[] {
  const attempt = (candidate: string): JsonRecord[] | undefined => {
    try {
      const parsed: unknown = JSON.parse(candidate);
      const records = recordsOf(parsed);
      return records.length ? records : undefined;
    } catch {
      // fail-open-ok: malformed vendor output is not a JSON document; the caller tries framed JSON and JSONL next
      return undefined;
    }
  };
  const whole = attempt(text.trim());
  if (whole) return whole;
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) {
    const framed = attempt(text.slice(first, last + 1));
    if (framed) return framed;
  }
  return parseJsonLines(text).values;
}
