/** A command's JSON result (what `clikcode --json` prints) as something to
 * show in the chat: a panel, a one-line notice, or nothing when the result is
 * already visible elsewhere (a settings change shows in the header). */
import { stripAnsi } from './text';
import { modelLabel } from './webview/format';

/** A `models` panel row's model as the terminal prints it: the bridge's
 * label, else the id without its provider's own prefix. A ClikCode Local
 * row's label is already in its provider text, so it shows the id. */
function shownModel(row: Record<string, unknown>): string {
  if (typeof row.label === 'string' && !('fits' in row)) return row.label;
  return modelLabel(String(row.model), typeof row.provider === 'string' ? row.provider : undefined);
}

export type Shown =
  | { kind: 'panel'; title: string; body: string }
  | { kind: 'notice'; text: string; level: 'info' | 'warning' | 'error' }
  | { kind: 'none' };

/** Panels whose whole content is "that worked" (src/harness/output.ts). */
const CONFIRMATIONS = new Set([
  'session-renamed', 'session-archived', 'session-deleted', 'session-closed', 'session-forked',
  'settings-updated', 'conversation-reset', 'account-removed', 'add-dir', 'copied',
]);

const TITLES: Record<string, string> = {
  help: 'Commands', usage: 'Usage', context: 'Context', diff: 'Changes', capabilities: 'Capabilities',
  doctor: 'Doctor', shell: 'Shell', memory: 'Memory', permissions: 'Permissions', attachments: 'Attachments',
};

function titleFor(panel: string): string {
  return TITLES[panel] ?? panel.replace(/[-_]+/g, ' ').replace(/^\w/, (first) => first.toUpperCase());
}

function list(rows: unknown[], row: (item: Record<string, unknown>) => string): string {
  return rows.length ? rows.map((item) => row(item as Record<string, unknown>)).join('\n') : '(none)';
}

export function formatOutput(payload: Record<string, unknown>): Shown {
  const panel = typeof payload.panel === 'string' ? payload.panel : undefined;
  const text = typeof payload.text === 'string' ? stripAnsi(payload.text) : undefined;
  if (payload.status === 'ready') return { kind: 'none' };
  if (panel === 'error' && typeof payload.message === 'string') {
    const message = stripAnsi(payload.message);
    // Running out of every account is an outcome, not a fault: show it as
    // plain informational chat text, not a warning or error banner.
    const outcome = /^(?:All accounts exhausted|Usage Exhausted|Credits Exhausted)\b/.test(message.trim());
    return { kind: 'notice', text: message, level: outcome ? 'info' : 'error' };
  }
  if (panel === 'notice' && typeof payload.message === 'string') return { kind: 'notice', text: stripAnsi(payload.message), level: 'warning' };
  if (panel === 'settings' || panel === 'provider-selected' || panel === 'history' || panel === 'redraw') return { kind: 'none' };
  if (panel === 'accounts' && payload.selected) return { kind: 'none' };
  if (panel && CONFIRMATIONS.has(panel)) return text ? { kind: 'notice', text, level: 'info' } : { kind: 'none' };
  if (panel === 'help' && typeof payload.helpText === 'string') return { kind: 'panel', title: 'Commands', body: stripAnsi(payload.helpText) };
  if (panel === 'models' && Array.isArray(payload.models)) {
    const selected = payload.selected;
    return {
      kind: 'panel', title: 'Models',
      body: list(payload.models, (model) => `${model.model === selected ? '● ' : '  '}${shownModel(model)}${model.provider ?? model.account ? `  (${String(model.provider ?? model.account)})` : ''}`),
    };
  }
  if (panel === 'accounts' && Array.isArray(payload.accounts)) {
    return { kind: 'panel', title: 'Accounts', body: list(payload.accounts, (account) => `${String(account.label)}  (${String(account.provider)} · ${String(account.status)})`) };
  }
  if (panel === 'sessions' && Array.isArray(payload.sessions)) {
    return {
      kind: 'panel', title: 'Sessions',
      body: list(payload.sessions, (item) => `${String(item.id).slice(0, 8)}  ${String(item.harness ?? item.provider ?? 'unselected')}  ${String(item.status)}`),
    };
  }
  if (panel === 'permissions' && Array.isArray(payload.controls)) return { kind: 'panel', title: 'Permissions', body: payload.controls.map(String).join('\n') };
  if (text !== undefined) return { kind: 'panel', title: titleFor(panel ?? 'Result'), body: text };
  if (panel) {
    const { panel: _panel, ...rest } = payload;
    return { kind: 'panel', title: titleFor(panel), body: stripAnsi(JSON.stringify(rest, null, 2)) };
  }
  return { kind: 'none' };
}
