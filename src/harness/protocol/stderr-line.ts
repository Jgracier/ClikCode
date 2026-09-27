/** The one line worth showing a person out of a failed harness's stderr.
 *
 * Vendor CLIs fail loudly: stack frames, module resolution traces, absolute
 * paths, sometimes a JSON blob. The first line that is none of those is
 * almost always the actual complaint, and it is all that belongs on screen.
 */
export function firstUsefulLine(stderr: string, limit = 200): string {
  // Stack frames, brackets, bare paths, carets, and the runtime's own
  // `throw err;` line -- none of them is the complaint.
  const noise = /^\s*(?:at\s|[{}[\]]|"|\/|[A-Za-z]:\\|\.{3}|Require stack|throw\s|\^+\s*$|node:internal)/;
  const lines = stderr.split(/\r?\n/).filter((line) => line.trim() && !noise.test(line));
  const cut = (text: string): string =>
    text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}\u2026` : text;
  // The line that names the error wins over whatever merely came first: a
  // runtime prints its banner lines before the message they belong to.
  const named = lines.find((line) => /\berror\b/i.test(line));
  if (named) return cut(named.trim());
  if (lines.length) return cut(lines[0]!.trim());
  const fallback = stderr.trim().split(/\r?\n/)[0]?.trim() ?? '';
  return cut(fallback);
}
