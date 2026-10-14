/** What each tool category is called and how it reads: its verb and folded
 * summary. Plain data, so the VS Code webview can use it. How it LOOKS (glyph,
 * colour) is one thing for every category and every harness: look.ts. */

import type { ToolCategory } from '../prompter.js';

export const TOOL_CATEGORY: Record<ToolCategory, {
  verb: string;
  /** How a folded run of these reads once it has settled. */
  folded: (count: number) => string;
}> = {
  read: { verb: 'reading', folded: (n) => `read ${n} files` },
  edit: { verb: 'editing', folded: (n) => `edited ${n} files` },
  run: { verb: 'running', folded: (n) => `ran ${n} commands` },
  search: { verb: 'searching', folded: (n) => `searched ${n} times` },
  fetch: { verb: 'fetching', folded: (n) => `fetched ${n} pages` },
};
