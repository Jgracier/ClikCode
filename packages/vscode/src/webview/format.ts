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

export function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
}

export function resetIn(iso: string | undefined, now = Date.now()): string | undefined {
  if (!iso) return undefined;
  const at = Date.parse(iso);
  if (Number.isNaN(at) || at <= now) return undefined;
  const minutes = Math.round((at - now) / 60_000);
  if (minutes < 60) return `resets in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `resets in ${hours}h`;
  return `resets in ${Math.round(hours / 24)}d`;
}

/** The last two segments of a path, for a compact label. */
export function shortPath(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.length <= 2 ? parts.join('/') : `…/${parts.slice(-2).join('/')}`;
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

/** A model id as people read it: `opencode:big-pickle` or `opencode/big-pickle`
 * under OpenCode is `big-pickle`. A prefix naming someone else (a Gateway
 * model's lab, `openai/gpt-5.5`) is kept: there it says whose model it is. */
export function modelLabel(model: string | undefined, ...owners: Array<string | undefined>): string | undefined {
  if (!model) return model;
  const match = /^([\w.-]+)[:/](.+)$/.exec(model);
  if (!match) return model;
  const norm = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, '');
  const prefix = norm(match[1]!);
  return owners.some((owner) => owner && norm(owner) === prefix) ? match[2]! : model;
}
