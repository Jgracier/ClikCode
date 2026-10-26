/** The sub-agent view on the waiting display: opened from an expanded agent
 * row with Right, drawn in place of the live region (the settled transcript
 * above is untouched), left with Left / Esc / Ctrl+C. The main turn runs on
 * underneath; none of these keys reaches it. State, keys and rows are
 * tui/subagent-view.ts; this file only connects them to the prompter. */
import { quiet } from '../../runtime/lifecycle-log.js';
import { stdout as output } from 'node:process';
import { localHarnessForCommand } from '../../runtime/lazy-bridge.js';
import { turnElapsedMs } from '../../harness/protocol/activity-view.js';
import { formatElapsed } from '../../harness/protocol/format.js';
import { liveSubAgentRows, readClaudeSubagent, type SubAgentRow } from '../../harness/subagent-read.js';
import { subAgentRefs, subAgentViewKey, subAgentViewLines, subAgentViewOpen, type SubAgentViewState } from '../subagent-view.js';
import { terminalCellWidth } from '../render/width.js';
import type { SubAgentModes } from '../../harness/protocol/activity-normalize.js';
import type { TerminalHarnessPrompter } from '../prompter.js';
import { isClikCodeAgent } from '../../session/route.js';

export interface SubView { state: SubAgentViewState; rows: SubAgentRow[]; notice?: string; timer?: NodeJS.Timeout; reading?: boolean }

function harnessOf(p: TerminalHarnessPrompter): { command: string; vendor: string; modes: SubAgentModes } {
  const command = p.currentSession?.nativeHarness;
  const harness = command ? localHarnessForCommand(command) : undefined;
  const own = Boolean(p.currentSession && isClikCodeAgent(p.currentSession));
  return { command: command ?? 'clikcode', vendor: harness?.displayName ?? 'ClikCode',
    modes: harness?.subagents ?? (own ? { read: 'frames', steer: 'session' } : { read: 'none', steer: 'none' }) };
}

/** The rows of the open sub-agent: its live frames, and where the harness keeps a
 * transcript, that (the richer: it has the prompt and the prose). */
async function readRows(p: TerminalHarnessPrompter, view: SubView): Promise<SubAgentRow[]> {
  const ref = view.state.siblings[view.state.index]!;
  const recorded = await p.subAgentRead?.(ref.id);
  if (recorded?.length) return recorded;
  const frames = liveSubAgentRows(p.childEntries.flatMap((entry) => (entry.event ? [entry.event] : [])), ref.id);
  const session = p.currentSession;
  if (ref.read !== 'transcript' || ref.harness !== 'claude' || !session?.nativeSessionId) return frames;
  const found = await readClaudeSubagent(session.workspace ?? '', session.nativeSessionId, ref.id).catch(quiet('tui/prompter/subagent-host'));
  return found?.rows.length ? found.rows : frames;
}

function refresh(p: TerminalHarnessPrompter): void {
  const view = p.subView;
  if (!view || view.reading) return;
  const index = view.state.index;
  view.reading = true;
  void readRows(p, view).then((rows) => {
    if (p.subView !== view || view.state.index !== index) return;
    view.rows = rows;
    p.paint(p.composer.text, p.composer.options, p.composer.selected, p.composer.prompt, p.composer.cursor, p.composer.palette);
  }).finally(() => { view.reading = false; });
}

/** Right on an empty composer opens a running sub-agent's full view. */
export function openSubView(this: TerminalHarnessPrompter): boolean {
  if (this.subView || !this.turn || !this.currentSession) return false;
  const { command, modes } = harnessOf(this);
  const events = this.activityEntries.flatMap((entry) => (entry.event ? [entry.event] : []));
  const siblings = subAgentRefs(events, command, modes);
  // A harness that publishes nothing of its sub-agents has nothing to open (docs/SUBAGENTS.md).
  const readable = siblings.filter((ref) => ref.read !== 'none');
  const expanded = readable.filter((ref) => this.groupExpansion.isOpen(`call:${ref.id}`));
  const ref = expanded.at(-1) ?? readable.filter((item) => item.status === 'running').at(-1);
  const state = ref ? subAgentViewOpen(siblings, ref.id) : undefined;
  if (!state) return false;
  this.subView = { state, rows: [] };
  refresh(this);
  // Cheap: a transcript read, and only while it is on screen.
  this.subView.timer = setInterval(() => refresh(this), 1500);
  this.subView.timer.unref?.();
  this.paintWaiting(this.turn);
  return true;
}

export function closeSubView(this: TerminalHarnessPrompter): void {
  const view = this.subView;
  if (!view) return;
  if (view.timer) clearInterval(view.timer);
  this.subView = undefined;
  if (this.turn) {
    this.requestRedraw('repair');
    this.forgetScreenPosition();
    this.paintWaiting(this.turn);
  }
}

export function subViewKey(this: TerminalHarnessPrompter, key: string): void {
  const view = this.subView;
  if (!view) return;
  const { vendor } = harnessOf(this);
  const effect = subAgentViewKey(view.state, key, vendor);
  if (effect.type === 'back') { this.closeSubView(); return; }
  if (effect.type === 'state') view.state = effect.state;
  else if (effect.type === 'open') { view.state = effect.state; view.rows = []; view.notice = undefined; refresh(this); }
  else if (effect.type === 'send') {
    view.state = effect.state;
    const steer = this.subAgentSteer;
    if (!steer) view.notice = 'This window cannot send to a sub-agent.';
    else {
      view.notice = effect.ref.steer === 'relay' ? 'Sending to the main agent, asking it to pass this on…' : 'Sending to the sub-agent…';
      void steer(effect.ref, effect.text).then((message) => {
        if (this.subView === view) { view.notice = message ?? (effect.ref.steer === 'relay' ? `Sent through the main agent to ${effect.ref.label}.` : `Sent to ${effect.ref.label}.`); this.paintWaiting(this.turn!); }
      });
    }
  } else return;
  if (this.turn) this.paintWaiting(this.turn);
}

/** One frame of the view, in place of the live region. */
export function paintSubView(this: TerminalHarnessPrompter): void {
  const view = this.subView;
  const turn = this.turn;
  if (!view || !turn) return;
  const { vendor } = harnessOf(this);
  view.state = { ...view.state, frame: this.reducedMotion ? 0 : this.waitingFrame };
  const width = Math.max(12, output.columns || 100);
  const height = Math.max(4, this.viewportRows());
  const mainStatus = `main: running ${formatElapsed(turnElapsedMs(turn.clock, Date.now()))}`;
  const lines = subAgentViewLines(view.state, { vendor, mainStatus, rows: view.rows, ...(view.notice ? { notice: view.notice } : {}), width: width - 1, height });
  const shown = lines.slice(-height);
  const composerRow = shown.length - 2;
  const writable = shown[composerRow]?.startsWith('› ') ?? false;
  this.renderFrame([], shown, Math.max(0, composerRow), 2 + terminalCellWidth(view.state.draft.slice(0, view.state.cursor)), !writable);
}
