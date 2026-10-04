/** Small pure helpers for what the webview shows. */

export { relativeTime, tildePath } from '../../../../src/harness/protocol/format';

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
