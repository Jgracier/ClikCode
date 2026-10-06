/** The one line worth showing a person out of a failed harness's stderr.
 *
 * Vendor CLIs fail loudly: stack frames, module resolution traces, absolute
 * paths, sometimes a JSON blob. The first line that is none of those is
 * almost always the actual complaint, and it is all that belongs on screen.
 */
/** Words a CLI uses when it is refusing, short of saying "error". */
const COMPLAINT = /\b(?:fail(?:ed|ure)?|denied|invalid|unauthori[sz]ed|forbidden|requires?|required|not (?:found|logged in|signed in|configured|supported|eligible|available)|no (?:api key|access token|credentials)|insufficient|exceeded|unavailable|cannot|can't)\b/i;

export function firstUsefulLine(stderr: string, limit = 200): string {
  // Stack frames, brackets, bare paths, carets, and the runtime's own
  // `throw err;` line -- none of them is the complaint.
  const noise = /^\s*(?:at\s|[{}[\]]|"|\/|[A-Za-z]:\\|\.{3}|Require stack|throw\s|\^+\s*$|node:internal)/;
  // Colour and cursor escapes are how a terminal shows the line, not the line.
  const plain = stderr.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
  const lines = plain.split(/\r?\n/).filter((line) => line.trim() && !noise.test(line));
  const cut = (text: string): string =>
    text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}\u2026` : text;
  // A warning, a hint or a deprecation is printed on the way to the
  // complaint, not instead of it: Pi warns about a session id before saying
  // it has no API key, OpenHands warns about the terminal before saying it
  // has no settings.
  const aside = /^\s*(?:\w*warning\b|warn\b|hint\b|note\b|to override\b|it will be compatible\b|from \S+ import\b)/i;
  const said = lines.filter((line) => !aside.test(line) && !/\bDeprecationWarning\b/.test(line));
  // The line that names the problem wins over whatever merely came first: a
  // runtime prints its banner lines before the message they belong to.
  const named = said.find((line) => /\berror\b/i.test(line))
    ?? said.find((line) => COMPLAINT.test(line));
  if (named) return cut(named.trim());
  if (said.length) return cut(said[0]!.trim());
  if (lines.length) return cut(lines[0]!.trim());
  const fallback = plain.trim().split(/\r?\n/)[0]?.trim() ?? '';
  return cut(fallback);
}

/** A failed turn's message as the one line a person reads. The provider's
 * own report (`(provider reported: …)`) and a JSON body are for the log,
 * which keeps the whole message; classify a failure before shortening it. */
export function failureLine(message: string, limit = 200): string {
  const line = firstUsefulLine(message, Number.POSITIVE_INFINITY)
    .replace(/\s*\(provider reported:.*$/i, '')
    .replace(/[:\s]*(?:\{\s*"|\[\s*\{).*$/, '')
    .trim();
  const text = line || firstUsefulLine(message, Number.POSITIVE_INFINITY);
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}
