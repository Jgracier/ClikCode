/** A failed harness or turn put to a person: the whole message, minus the noise.
 *
 * Vendor CLIs fail loudly: stack frames, module resolution traces, absolute
 * paths, colour codes, sometimes a JSON body. Those are noise. The cause is
 * not: a worker killed with exit code 137 or out of memory says so on a line
 * of its own, and the provider's own reported message is the part to act on.
 * So nothing is chosen between lines. What is left after the noise is shown
 * whole, wrapped by whoever draws it, and a JSON body is replaced by the
 * readable message inside it, never dropped.
 */

/** A bound against a runaway flood only. The note wraps over as many rows as
 * it needs (tool-rows.ts noteRows) and the log keeps the whole message, so
 * this is never the width of anything and no real error comes near it. */
export const FAILURE_TEXT_LIMIT = 8000;

/** Stack frames, the runtime's own `throw err;` line, module resolution
 * traces, carets and bare paths: where the failure happened, not what it was. */
const NOISE = /^\s*(?:at\s|Require stack|throw\s|\^+\s*$|node:internal|\(Use `node --trace|\/[^\s]*$|[A-Za-z]:\\[^\s]*$|-\s+\/)/;
const DEPRECATION = /\bDeprecationWarning\b/;

/** The readable text of a parsed error body, or undefined when it holds none. */
function bodyMessage(body: unknown): string | undefined {
  if (typeof body === 'string') return body.trim() || undefined;
  if (Array.isArray(body)) {
    const parts = body.map(bodyMessage).filter((part): part is string => Boolean(part));
    return parts.length ? parts.join('; ') : undefined;
  }
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    for (const key of ['message', 'error', 'detail', 'error_description', 'errors']) {
      const found = bodyMessage(record[key]);
      if (found) return found;
    }
  }
  return undefined;
}

/** The end of the JSON value that opens at `start`, or -1 when it never closes. */
function jsonEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i]!;
    if (inString) {
      if (char === '\\') i += 1;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === '{' || char === '[') depth += 1;
    else if (char === '}' || char === ']') { depth -= 1; if (depth === 0) return i; }
  }
  return -1;
}

/** Each JSON body in the text becomes the message it carries; a body that is
 * not valid JSON, or carries no message, stays exactly as the vendor wrote it. */
function readableBodies(text: string): string {
  let out = '';
  let from = 0;
  const opener = /[{[]\s*(?:"|\{)/g;
  for (let hit = opener.exec(text); hit; hit = opener.exec(text)) {
    if (hit.index < from) continue;
    const end = jsonEnd(text, hit.index);
    if (end < 0) break;
    let message: string | undefined;
    try { message = bodyMessage(JSON.parse(text.slice(hit.index, end + 1))); } catch { message = undefined; }
    if (!message) continue;
    out += text.slice(from, hit.index) + message;
    from = end + 1;
  }
  return out + text.slice(from);
}

export function failureText(message: string, limit = FAILURE_TEXT_LIMIT): string {
  // Colour and cursor escapes are how a terminal shows the line, not the line.
  const plain = message.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
  const kept = readableBodies(plain)
    .split(/\r?\n/)
    .filter((line) => !NOISE.test(line) && !DEPRECATION.test(line))
    .map((line) => line.trimEnd());
  // Blank runs collapse; the lines themselves are never reduced to one.
  const text = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim() || plain.trim();
  if (text.length <= limit) return text;
  // A flood keeps its start and its end: the banner says what ran, the end
  // says why it stopped, and the middle is the repetition.
  const head = Math.floor(limit / 4);
  return `${text.slice(0, head).trimEnd()}\n\u2026\n${text.slice(text.length - (limit - head)).trimStart()}`;
}
