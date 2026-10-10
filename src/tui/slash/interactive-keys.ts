/** The slash commands the interactive loop answers by opening a picker,
 * rather than by running a command. */

import { type SlashHandlerKey } from './registry.js';

/** Commands the interactive loop handles itself (pickers, prompts, turns with
 * the waiting UI). Every other registry command falls through to
 * HEADLESS_SLASH_HANDLERS with its output shown in a panel. */
const INTERACTIVE_SLASH_HANDLER_KEYS = [
  'exit', 'new', 'redraw', 'provider', 'accounts', 'model', 'effort', 'permissions', 'sandbox', 'send', 'swarm', 'options', 'capabilities',
  'settings', 'sessions', 'resume', 'search', 'rename', 'archive', 'delete', 'mention', 'review', 'init', 'native', 'compact',
  'export', 'memory', 'doctor', 'login', 'logout', 'fork', 'redo', 'copy',
] as const satisfies readonly SlashHandlerKey[];

export type InteractiveSlashHandlerKey = typeof INTERACTIVE_SLASH_HANDLER_KEYS[number];

export interface InteractiveSlashOutcome {
  /** Adopt this session (a new conversation, a fork, a resumed chat). */
  id?: string;
  exit?: boolean;
  notice?: string;
  /** Run this as a turn on the (possibly just adopted) session. */
  prompt?: string;
  /** Put this in the message box to edit and send (/redo). */
  draft?: string;
  echo?: boolean;
}
