/** The terminal's one live home for subagents, just above the composer. */
import chalk from 'chalk';
import { agentSpinnerGlyph } from '../../harness/protocol/activity-view.js';
import type { BackgroundWork } from '../../harness/protocol/background-agents.js';
import { look } from '../../harness/protocol/tool-category-style.js';
import type { ActivityEntry } from './activity-log.js';
import { sanitizeTerminalText } from './text.js';
import { visibleSlice } from './width.js';

export function liveAgentRows(
  entries: readonly ActivityEntry[], latestChild: (id: string) => string | undefined,
  frame: number, width: number, limit: number, background?: BackgroundWork,
): string[] {
  const active = entries.filter((entry) => entry.event?.agent && entry.event.kind === 'tool-start' && entry.event.id)
    .map((entry) => ({ id: entry.event!.id!, agentId: entry.event!.agentId, label: entry.event!.label, child: latestChild(entry.event!.id!) }));
  const named = (background?.agentTasks ?? []).filter((task) => !active.some((entry) =>
    entry.id === task.id || entry.agentId === task.id))
    .map((task) => ({ id: task.id, label: sanitizeTerminalText(task.label, { singleLine: true }) }));
  const unnamed = !active.length ? Math.max(0, (background?.agents ?? 0) - (background?.agentTasks?.length ?? 0)) : 0;
  const all = [...active, ...named, ...Array.from({ length: unnamed }, (_, index) => ({ id: `background-${index}`, label: `Background agent ${index + 1}` }))];
  if (!all.length || limit < 1) return [];
  const shown = all.slice(-(all.length > limit && limit > 1 ? limit - 1 : limit));
  const rows = shown.map((agent) => visibleSlice(
    `  ${look.paint.accent(agentSpinnerGlyph(frame))}  ${agent.label}${'child' in agent && agent.child ? `  ·  ${agent.child}` : ''}`, width,
  ));
  const hidden = all.length - shown.length;
  if (hidden && limit > 1) rows.unshift(visibleSlice(`  ${chalk.dim(`+${hidden} other subagent${hidden === 1 ? '' : 's'} running`)}`, width));
  else if (hidden) rows[0] = visibleSlice(`${chalk.dim(`+${hidden} more · `)}${rows[0]}`, width);
  return rows;
}
