/** What changed in the ChatModel since a page was last sent it.
 *
 * A streaming turn repaints every 40 ms, and resending the whole model each
 * time (a long transcript, up to 100 traces of 200 tool rows with output, the
 * notes and the answer so far) made every tick cost the size of the
 * conversation. The reducer keeps every untouched field the same object, so a
 * field is sent only when it is a different one, and the live answer only as
 * the text appended since the last send.
 */
import type { ChatModel, LiveTurn } from './model';

type Fields<T> = { set: Partial<T>; unset: Array<keyof T> };

export interface ModelPatch extends Fields<ChatModel> {
  /** `null`: the turn ended. Absent: the live turn is unchanged. */
  live?: (Fields<LiveTurn> & { append?: string }) | null;
}

function diffFields<T extends object>(previous: T, next: T, skip?: keyof T): Fields<T> {
  const set: Partial<T> = {};
  const unset: Array<keyof T> = [];
  for (const key of new Set([...Object.keys(previous), ...Object.keys(next)]) as Set<keyof T>) {
    if (key === skip || previous[key] === next[key]) continue;
    if (next[key] === undefined) unset.push(key);
    else set[key] = next[key];
  }
  return { set, unset };
}

/** `undefined` when nothing changed. */
export function diffModel(previous: ChatModel, next: ChatModel): ModelPatch | undefined {
  const patch: ModelPatch = diffFields(previous, next, 'live');
  if (previous.live !== next.live) {
    if (!next.live) patch.live = null;
    else if (!previous.live) patch.live = { set: next.live, unset: [] };
    else {
      const live = diffFields(previous.live, next.live, 'text');
      const before = previous.live.text;
      const after = next.live.text;
      if (after === before) patch.live = live;
      else if (after.startsWith(before)) patch.live = { ...live, append: after.slice(before.length) };
      else patch.live = { ...live, set: { ...live.set, text: after } };
    }
  }
  const empty = !Object.keys(patch.set).length && !patch.unset.length && patch.live === undefined;
  return empty ? undefined : patch;
}

function applyFields<T extends object>(target: T, fields: Fields<T>): T {
  const next = { ...target, ...fields.set };
  for (const key of fields.unset) delete next[key];
  return next;
}

/** The page's side: every field the patch does not name keeps its object, so
 * memoized parts of the page (the transcript) do not redraw. */
export function applyModelPatch(model: ChatModel, patch: ModelPatch): ChatModel {
  const next = applyFields(model, patch);
  if (patch.live === null) delete next.live;
  else if (patch.live) {
    const live = applyFields(model.live ?? ({} as LiveTurn), patch.live);
    if (patch.live.append) live.text += patch.live.append;
    next.live = live;
  }
  return next;
}
