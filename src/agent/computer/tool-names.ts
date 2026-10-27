import { specOf } from './actions.js';

/** The two tools were `computer_web` and `computer_desktop` until 2026-10-26. Permission rules, scripts and
 * other harnesses may still use those names, so they keep working wherever a name comes in from outside. */
const RENAMED: Readonly<Record<string, string>> = { computer_web: 'browser_use', computer_desktop: 'computer_use' };

export function currentToolName(name: string): string { return RENAMED[name] ?? name; }

/** The tool a call is for. browser_use used to carry the sign-in, key and email actions too (they are account_use now): a call from outside
 * ClikCode's own agent (an MCP client with an old tool list, a script, the CLI) that still sends one to browser_use is sent where it lives.
 * The agent itself is told instead (actions.ts, elsewhere), so it learns the right tool. */
export function toolForCall(name: string, args: Record<string, unknown>): string {
  const current = currentToolName(name);
  const spec = typeof args['action'] === 'string' ? specOf(args['action']) : undefined;
  return current === 'browser_use' && spec?.kind === 'account' ? 'account_use' : current;
}
