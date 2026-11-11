/** One question decides whether a frame may be drawn: who has the screen. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalHarnessPrompter } from './prompter.js';

const realTty = process.stdout.isTTY;
const realWrite = process.stdout.write.bind(process.stdout);
const session = { id: 's1', route: 'local', accountId: null, provider: null, model: null, createdAt: '', updatedAt: '', status: 'active', messages: [] } as never;

describe('screen owner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.assign(process.stdout, { isTTY: true, columns: 100, rows: 40 });
    process.stdout.write = (() => true) as typeof process.stdout.write;
  });
  afterEach(() => {
    vi.useRealTimers();
    Object.assign(process.stdout, { isTTY: realTty });
    process.stdout.write = realWrite;
  });

  it('names the owner by precedence: closed, suspended, held, picker, chat', () => {
    const rl = new TerminalHarnessPrompter();
    try {
      expect(rl.screenOwner).toBe('chat');
      rl.selecting = true;
      expect(rl.screenOwner).toBe('picker');
      expect(rl.canPaint()).toBe(false);
      expect(rl.canPaint('picker')).toBe(true);
      rl.holdPaints();
      expect(rl.screenOwner).toBe('held');
      expect(rl.canPaint('picker')).toBe(false);
      rl.suspended = true;
      expect(rl.screenOwner).toBe('suspended');
    } finally { rl.close(); }
    expect(rl.screenOwner).toBe('closed');
  });

  it('draws nothing from any chat path while held, and once when released', () => {
    const rl = new TerminalHarnessPrompter();
    try {
      rl.render(session);
      rl.holdPaints();
      const paint = vi.spyOn(rl, 'paint');
      const frames = vi.fn();
      const flush = vi.spyOn(rl, 'flushFrame').mockImplementation(frames);
      rl.schedulePaint(0);
      rl.paintCurrent();
      rl.render(session);
      vi.advanceTimersByTime(50);
      expect(frames).not.toHaveBeenCalled();
      expect(paint).not.toHaveBeenCalled();
      flush.mockRestore();
      rl.releasePaints();
      expect(paint).toHaveBeenCalledTimes(1);
    } finally { rl.close(); }
  });

  it('a chat path does not draw over an open picker; a closed window draws nothing at all', () => {
    const rl = new TerminalHarnessPrompter();
    rl.render(session);
    const paint = vi.spyOn(rl, 'paint');
    rl.selecting = true;
    rl.paintCurrent();
    rl.render(session);
    rl.schedulePaint(0);
    vi.advanceTimersByTime(50);
    expect(paint).not.toHaveBeenCalled();
    rl.selecting = false;
    rl.close();
    const write = vi.fn(() => true);
    process.stdout.write = write as never;
    rl.paint('x', [], 0, '› ', 1);
    rl.render(session);
    expect(write).not.toHaveBeenCalled();
  });
});
