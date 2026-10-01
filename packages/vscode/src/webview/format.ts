/** Small pure helpers for what the webview shows. */

export function relativeTime(iso: string | undefined, now = Date.now()): string {
  if (!iso) return '';
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function homeRelative(path: string | undefined): string {
  if (!path) return '';
  return path.replace(/^\/home\/[^/]+|^\/Users\/[^/]+|^[A-Z]:\\Users\\[^\\]+/, '~');
}

/** A path-looking token in a tool label or inline code, with a line number
 * when one is attached (`src/a.ts:12`). */
const PATH = /(?:^|[\s"'`(])((?:~|\.{1,2}|[\w@.-]+)?(?:[/\\][\w@.+-]+)+\.[\w]{1,10}|[\w@.+-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|py|rs|go|java|kt|rb|php|c|h|cpp|hpp|cs|css|scss|html|vue|svelte|yml|yaml|toml|sh|txt|lock|sql|swift))(?::(\d+))?(?=$|[\s"'`),:;])/;

export function pathIn(text: string): { path: string; line?: number; index: number } | undefined {
  const match = PATH.exec(text);
  if (!match) return undefined;
  return { path: match[1]!, ...(match[2] ? { line: Number(match[2]) } : {}), index: match.index + match[0].indexOf(match[1]!) };
}

export function clean(detail: string | undefined): string {
  return (detail ?? '').replace(/^\s*·\s*/, '').trim();
}

export function titleCase(value: string): string {
  return value ? value[0]!.toUpperCase() + value.slice(1) : value;
}

/** A model id as people read it beside its provider: ClikCode's own rule,
 * bundled from its source so the panel and the terminal cannot disagree. */
export { modelLabel } from '../../../../src/harness/model-label.js';

/** The running turn's tokens, cache hits, context and cost: the terminal's
 * own line, bundled from its source for the same reason. */
export { estimatedTokens, formatTurnUsage } from '../../../../src/tui/render/usage-line.js';
