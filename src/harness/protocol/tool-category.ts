/** What each tool category is called and how it reads: its verb, glyph,
 * colour and folded summary. Plain data, so the VS Code webview can use it;
 * the terminal paints it (tool-category-style.ts). */

import type { ToolCategory } from '../prompter.js';

export const TOOL_CATEGORY: Record<ToolCategory, {
  /** A chalk colour name; the webview maps it to the theme's own colour. */
  colour: 'blue' | 'magenta' | 'yellow' | 'cyan' | 'green';
  verb: string; glyph: string;
  /** How a folded run of these reads once it has settled. */
  folded: (count: number) => string;
}> = {
  read: { colour: 'blue', verb: 'reading', glyph: '◇', folded: (n) => `read ${n} files` },
  edit: { colour: 'magenta', verb: 'editing', glyph: '◆', folded: (n) => `edited ${n} files` },
  run: { colour: 'yellow', verb: 'running', glyph: '▸', folded: (n) => `ran ${n} commands` },
  search: { colour: 'cyan', verb: 'searching', glyph: '◈', folded: (n) => `searched ${n} times` },
  fetch: { colour: 'green', verb: 'fetching', glyph: '↓', folded: (n) => `fetched ${n} pages` },
};
