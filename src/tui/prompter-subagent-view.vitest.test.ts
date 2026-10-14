/** The sub-agent full view on the waiting display: open from an expanded row with Right, steer, back with Left,
 * and the main turn is never touched by any key typed in it. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalHarnessPrompter } from './prompter.js';

const realTty = process.stdout.isTTY;
const realWrite = process.stdout.write.bind(process.stdout);
let written = '';
beforeEach(() => {
  written = '';
  Object.assign(process.stdout, { isTTY: true, columns: 100, rows: 40 });
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    written += String(chunk);
    for (const arg of rest) if (typeof arg === 'function') (arg as () => void)();
    return true;
  }) as typeof process.stdout.write;
});
afterEach(() => { Object.assign(process.stdout, { isTTY: realTty }); process.stdout.write = realWrite; });

function follow(harness = 'claude') {
  const rl = new TerminalHarnessPrompter();
  (rl as unknown as { currentSession: unknown }).currentSession = { id: 's', nativeHarness: harness, workspace: '/w', messages: [], route: 'local' };
  const cancel = vi.fn();
  const leave = vi.fn();
  rl.startWaiting('thinking', cancel, async () => ({ kind: 'sent' }) as never, undefined, leave);
  const key = (k: string): void => (rl as unknown as { onWaitingKey(k: string): void }).onWaitingKey(k);
  rl.activityEvent({ kind: 'tool-start', label: 'Agent explore', agent: true, id: 'a1' });
  rl.activityEvent({ kind: 'tool-start', label: '$ ls', id: 'c1', parentId: 'a1' });
  rl.activityEvent({ kind: 'tool-start', label: 'Agent review', agent: true, id: 'a2' });
  return { rl, key, cancel, leave };
}
const open = (rl: TerminalHarnessPrompter, id: string): void => { (rl.groupExpansion as { toggleGroup(id: string): boolean }).toggleGroup(`call:${id}`); };
const screen = (): string => written.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');

describe('sub-agent view in the terminal', () => {
  it('Right on a collapsed row opens nothing; on an expanded agent row it opens its screen', async () => {
    const { rl, key } = follow();
    try {
      key('\u001b[C');
      expect(rl.subView).toBeUndefined();
      open(rl, 'a1');
      key('\u001b[C');
      expect(rl.subView?.state.siblings.map((s) => s.id)).toEqual(['a1', 'a2']);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(screen()).toContain('main > ');
      expect(screen()).toContain('main: running');
    } finally { rl.closeSubView(); rl.close(); }
  });

  it('Left, Esc and Ctrl+C return to the main chat without stopping, leaving or cancelling the turn', () => {
    for (const back of ['\u001b[D', '\u001b', '\u0003']) {
      const { rl, key, cancel, leave } = follow();
      try {
        open(rl, 'a1');
        key('\u001b[C');
        expect(rl.subView).toBeDefined();
        key(back);
        expect(rl.subView).toBeUndefined();
        expect(cancel).not.toHaveBeenCalled();
        expect(leave).not.toHaveBeenCalled();
      } finally { rl.close(); }
    }
  });

  it('Left from the main chat with an empty composer still steps out to the board', () => {
    const { rl, key, leave } = follow();
    try { key('\u001b[D'); expect(leave).toHaveBeenCalledTimes(1); } finally { rl.close(); }
  });

  it('Down moves to the next sibling and Up back', () => {
    const { rl, key } = follow();
    try {
      open(rl, 'a1');
      key('\u001b[C');
      key('\u001b[B');
      expect(rl.subView?.state.index).toBe(1);
      key('\u001b[A');
      expect(rl.subView?.state.index).toBe(0);
    } finally { rl.closeSubView(); rl.close(); }
  });

  it('typing then Enter sends a steer for that sub-agent, not the main composer', async () => {
    const { rl, key } = follow();
    const steer = vi.fn(async () => undefined);
    rl.subAgentSteer = steer;
    try {
      open(rl, 'a1');
      key('\u001b[C');
      for (const k of 'go on') key(k);
      key('\r');
      expect(steer).toHaveBeenCalledWith(expect.objectContaining({ id: 'a1', label: 'Agent explore' }), 'go on');
      expect(rl.turn?.draft).toBe('');
    } finally { rl.closeSubView(); rl.close(); }
  });

  it('a harness that gives no way says so in place of the composer, and types nothing', async () => {
    const { rl, key } = follow('codex');
    const steer = vi.fn(async () => undefined);
    rl.subAgentSteer = steer;
    try {
      open(rl, 'a1');
      key('\u001b[C');
      key('x');
      key('\r');
      expect(steer).not.toHaveBeenCalled();
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(screen()).toContain('Codex gives ClikCode no way to message a running sub-agent: this view is read-only.');
    } finally { rl.closeSubView(); rl.close(); }
  });
});
