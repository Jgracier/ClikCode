/** One sub-agent in full view: a chat screen of its own, drawn with the main
 * chat's rows. Pure: state, a key reducer and a renderer, as the conversation
 * board is (conversation-board.ts); the host owns the terminal.
 *
 * Keys: Left (composer empty) and Esc return to the main chat, Ctrl+C too and
 * none of them stops the main turn; Up / Down (composer empty) move between
 * sibling sub-agents; Enter sends the composer, where the harness allows it.
 * Where it does not, the composer is replaced by one line saying why
 * (`subAgentSteerBlock`) and the view is read-only. docs/TURN_FLOW_STANDARD.md
 * section 5a. */
import type { HarnessActivityEvent } from '../harness/prompter.js';
import { agentSpinnerGlyph } from '../harness/protocol/activity-view.js';
import { renderActivityLine } from '../harness/protocol/activity-line.js';
import { subAgentRef, subAgentSteerBlock, type SubAgentModes, type SubAgentRef } from '../harness/protocol/activity-normalize.js';
import { LOOK } from '../harness/protocol/look.js';
import { look } from '../harness/protocol/tool-category-style.js';
import type { SubAgentRow } from '../harness/subagent-read.js';
import { sanitizeTerminalText } from './render/text.js';
import { visibleSlice } from './render/width.js';

export interface SubAgentViewState {
  /** Every sub-agent of the turn, in the order they began. */
  siblings: readonly SubAgentRef[];
  /** The one open. */
  index: number;
  draft: string;
  cursor: number;
  /** The animation step; the ring spins while the sub-agent runs. */
  frame: number;
}

type SubAgentViewEffect =
  | { type: 'none' }
  | { type: 'state'; state: SubAgentViewState }
  /** Back to the main chat; the main turn is not touched. */
  | { type: 'back' }
  /** Another sub-agent was opened: the host reads its rows. */
  | { type: 'open'; state: SubAgentViewState }
  /** Enter on a composer with words in it. */
  | { type: 'send'; ref: SubAgentRef; text: string; state: SubAgentViewState };

/** The sub-agents of a turn: one ref per agent row, in the order they began,
 * each with the state of its latest frame. */
export function subAgentRefs(events: readonly HarnessActivityEvent[], harness: string, modes: SubAgentModes | undefined): SubAgentRef[] {
  const byId = new Map<string, SubAgentRef>();
  for (const event of events) {
    const ref = subAgentRef(event, harness, modes);
    if (!ref) continue;
    const prior = byId.get(ref.id);
    byId.set(ref.id, prior ? { ...ref, label: ref.label === 'tool' || !ref.label ? prior.label : ref.label, ...(ref.agentId ?? prior.agentId ? { agentId: (ref.agentId ?? prior.agentId)! } : {}) } : ref);
  }
  return [...byId.values()];
}

export function subAgentViewOpen(siblings: readonly SubAgentRef[], id: string): SubAgentViewState | undefined {
  const index = siblings.findIndex((ref) => ref.id === id);
  return index < 0 ? undefined : { siblings, index, draft: '', cursor: 0, frame: 0 };
}

const current = (state: SubAgentViewState): SubAgentRef => state.siblings[state.index]!;

export function subAgentViewKey(state: SubAgentViewState, key: string, vendor: string): SubAgentViewEffect {
  const ref = current(state);
  const writable = subAgentSteerBlock(ref, vendor) === undefined;
  const empty = state.draft === '';
  if (key === '\u001b' || key === '\u0003' || (key === '\u001b[D' && empty)) return { type: 'back' };
  if (empty && (key === '\u001b[A' || key === '\u001b[B')) {
    const next = state.index + (key === '\u001b[A' ? -1 : 1);
    if (next < 0 || next >= state.siblings.length) return { type: 'none' };
    return { type: 'open', state: { ...state, index: next, draft: '', cursor: 0 } };
  }
  if (!writable) return { type: 'none' };
  if (key === '\r') {
    const text = state.draft.trim();
    return text ? { type: 'send', ref, text, state: { ...state, draft: '', cursor: 0 } } : { type: 'none' };
  }
  if (key === '\u001b[D') return { type: 'state', state: { ...state, cursor: Math.max(0, state.cursor - 1) } };
  if (key === '\u001b[C') return { type: 'state', state: { ...state, cursor: Math.min(state.draft.length, state.cursor + 1) } };
  if (key === '\u007f' || key === '\b') {
    if (state.cursor === 0) return { type: 'none' };
    return { type: 'state', state: { ...state, draft: state.draft.slice(0, state.cursor - 1) + state.draft.slice(state.cursor), cursor: state.cursor - 1 } };
  }
  // A printable run (typed or pasted); no escape sequence or control byte gets in.
  if (key.length > 0 && !/[\u0000-\u001f\u007f]/.test(key)) {
    return { type: 'state', state: { ...state, draft: state.draft.slice(0, state.cursor) + key + state.draft.slice(state.cursor), cursor: state.cursor + key.length } };
  }
  return { type: 'none' };
}

/** `main > Agent explore`, the ring while it runs, a tick or cross once over. */
export function subAgentHeader(ref: SubAgentRef, frame: number): string {
  const mark = ref.status === 'running' ? look.paint.accent(agentSpinnerGlyph(frame))
    : ref.status === 'done' ? look.paint.success(LOOK.glyph.ok) : ref.status === 'stopped' ? look.paint.stopped(LOOK.glyph.stopped) : look.paint.failed(LOOK.glyph.failed);
  return `${look.paint.neutral('main >')} ${mark} ${ref.label}`;
}

interface SubAgentViewHost {
  /** The harness's display name, for the read-only line. */
  vendor: string;
  /** The main turn's state: `main: running 3m`, `main: waiting for you`, `main: done`. */
  mainStatus: string;
  /** The sub-agent's rows, read from the harness's source (subagent-read.ts). */
  rows: readonly SubAgentRow[];
  /** What the last send did, one line (the visible relay, or the refusal). */
  notice?: string;
  width: number;
  /** The screen's height: the composer sits at the bottom of it, as in the main chat, and nothing else shows. */
  height?: number;
}

/** The screen's rows, top to bottom: header, the chat, the composer or the
 * reason there is none, the main turn's status. */
export function subAgentViewLines(state: SubAgentViewState, host: SubAgentViewHost): string[] {
  const ref = current(state);
  const width = Math.max(10, host.width);
  const fit = (line: string): string => visibleSlice(line, width);
  const lines: string[] = [fit(subAgentHeader(ref, state.frame)), ''];
  const siblings = state.siblings.length > 1 ? ` (${state.index + 1}/${state.siblings.length})` : '';
  for (const row of host.rows) {
    if (row.kind === 'prompt') {
      for (const line of sanitizeTerminalText(row.text).split('\n')) lines.push(fit(`${look.paint.neutral('›')} ${line}`));
      lines.push('');
    } else if (row.kind === 'text') {
      for (const line of sanitizeTerminalText(row.text).split('\n')) lines.push(fit(line));
      lines.push('');
    } else for (const line of renderActivityLine(row.event)) lines.push(fit(line));
  }
  if (host.notice) lines.push(fit(look.paint.neutral(host.notice)));
  const block = subAgentSteerBlock(ref, host.vendor);
  // The screen belongs to this sub-agent: rows above its own are not the main chat's.
  if (host.height) lines.push(...Array.from({ length: Math.max(0, host.height - lines.length - 3) }, () => ''));
  lines.push('', fit(block ? look.paint.neutral(block) : `› ${state.draft}`));
  lines.push(fit(look.paint.neutral(`${host.mainStatus}${siblings}  ·  ←/esc back${state.siblings.length > 1 ? '  ↑↓ sub-agents' : ''}`)));
  return lines;
}
