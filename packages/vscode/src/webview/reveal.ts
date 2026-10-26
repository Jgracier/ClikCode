/** Live answer text, paced: a burst is revealed over a moment (reveal-pace.ts) rather than appearing at once. */
import { useEffect, useRef, useState } from 'preact/hooks';
import { nextRevealed, revealedPrefix, REVEAL_FRAME_MS, REVEAL_IMMEDIATE_CHARS, REVEAL_MAX_HOLD_MS } from '../../../../src/harness/protocol/reveal-pace';

import type { ChatModel } from '../model';

let pacing = 0;
const finished = new Set<() => void>();

/** Whether some text is still being revealed. */
export const isPacing = (): boolean => pacing > 0;

/** Calls `listener` when no text is being revealed any more; returns its removal. */
export function onPacingEnd(listener: () => void): () => void {
  finished.add(listener);
  return () => { finished.delete(listener); };
}

/** `full` as far as it has been revealed. Text already there when this mounts (a reopened chat, a window
 * joining a turn) is whole at once, and so is any growth of a few words. */
export function usePacedText(full: string): string {
  const [, step] = useState(0);
  const shown = useRef(full.length);
  const latest = useRef(full);
  const waiting = useRef(false);
  latest.current = full;
  if (shown.current > full.length) shown.current = full.length;
  // Ordinary streaming leaves a few words between frames: shown now, not a frame late.
  if (!waiting.current && full.length - shown.current <= REVEAL_IMMEDIATE_CHARS) shown.current = full.length;
  const behind = shown.current < full.length;
  useEffect(() => {
    if (!behind || waiting.current) return undefined;
    waiting.current = true;
    pacing += 1;
    let last = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = (): void => {
      const now = Date.now();
      shown.current = nextRevealed(shown.current, latest.current.length, now - last);
      last = now;
      step((count) => count + 1);
      if (shown.current < latest.current.length) { timer = setTimeout(tick, REVEAL_FRAME_MS); return; }
      end();
    };
    const end = (): void => {
      waiting.current = false;
      pacing -= 1;
      if (pacing === 0) for (const listener of [...finished]) listener();
    };
    timer = setTimeout(tick, REVEAL_FRAME_MS);
    return () => {
      if (timer) clearTimeout(timer);
      if (waiting.current) end();
    };
  }, [behind]);
  return revealedPrefix(full, shown.current);
}

/** The model to draw the transcript from. When a turn ends while its text is still being revealed, the
 * finished message would replace the live one and show whole, so the last running model is kept, its
 * text brought up to the finished answer, until the reveal catches up (or REVEAL_MAX_HOLD_MS passes). */
export function useHeldEnd(model: ChatModel | undefined): ChatModel | undefined {
  const [, bump] = useState(0);
  const last = useRef<ChatModel>();
  const holding = useRef(false);
  if (model?.running) { last.current = model; holding.current = false; }
  else if (model && last.current && !holding.current) {
    const answer = model.messages[model.messages.length - 1];
    const before = last.current.live?.text ?? '';
    const grown = answer?.role === 'assistant' && answer.content.startsWith(before) && answer.content.length - before.length > REVEAL_IMMEDIATE_CHARS;
    if (grown || isPacing()) {
      holding.current = true;
      if (grown) last.current = { ...last.current, live: { ...last.current.live!, text: answer!.content } };
    } else last.current = undefined;
  }
  const held = holding.current && model && !model.running ? last.current : undefined;
  useEffect(() => {
    if (!held) return undefined;
    const release = (): void => { holding.current = false; last.current = undefined; bump((count) => count + 1); };
    const stop = onPacingEnd(release);
    const cap = setTimeout(release, REVEAL_MAX_HOLD_MS);
    return () => { stop(); clearTimeout(cap); };
  }, [held]);
  return held ?? model;
}
