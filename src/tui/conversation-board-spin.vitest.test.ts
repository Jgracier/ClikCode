/** The board's spinner stops on screen when the last running chat finishes,
 * while the list stays open. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PickerOption } from '../harness/prompter.js';

vi.mock('./input-decoder.js', () => ({ takeTerminalKeys: () => () => undefined }));
vi.mock('./capabilities.js', async (importOriginal) => ({ ...await importOriginal<typeof import('./capabilities.js')>(), reducedMotion: () => false }));

const { runConversationBoard } = await import('./conversation-board.js');

afterEach(() => { vi.useRealTimers(); });

describe('the board spinner', () => {
  it('draws once more after the running row finishes, so no spinner is left behind', async () => {
    vi.useFakeTimers();
    let working = true;
    const painted: string[][] = [];
    const host = {
      paint: (_composer: string, options: readonly PickerOption<string>[]) => { painted.push(options.map((option) => option.label)); },
      clearFrame: () => undefined,
      setSelecting: () => undefined,
      select: async () => undefined,
    };
    const conversations = (): PickerOption<string>[] => [{ label: 'Fix the bug', value: 'a', group: 'Working 1', ...(working ? { activity: 'working' as const } : {}) }];
    void runConversationBoard(host as never, { conversations, commands: [] });
    await vi.advanceTimersByTimeAsync(500);
    expect(painted.at(-1)?.[0]).not.toBe('Fix the bug');
    working = false;
    await vi.advanceTimersByTimeAsync(500);
    // The glyph column stays, blank.
    expect(painted.at(-1)?.[0]).toBe('   Fix the bug');
    const draws = painted.length;
    await vi.advanceTimersByTimeAsync(1_000);
    // Idle: nothing more to animate, so nothing more is drawn.
    expect(painted.length).toBe(draws);
  });

  it('does not tick while nothing animates, and starts when the list says a row is working', async () => {
    vi.useFakeTimers();
    let working = false;
    let builds = 0;
    let painted = 0;
    let redraw: (() => void) | undefined;
    const host = { paint: () => { painted += 1; }, clearFrame: () => undefined, setSelecting: () => undefined, select: async () => undefined };
    let list: PickerOption<string>[] = [{ label: 'Fix the bug', value: 'a', group: 'Active 1' }];
    const conversations = (): PickerOption<string>[] => { builds += 1; return list; };
    const unchanged = Promise.resolve();
    void runConversationBoard(host as never, { conversations, commands: [], refresh: [unchanged, unchanged], listChanged: (listener) => { redraw = listener; } });
    await vi.advanceTimersByTimeAsync(2_000);
    // Opened once; refreshes that changed nothing drew nothing; idle, no ticks.
    expect(painted).toBe(1);
    const idleBuilds = builds;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(builds).toBe(idleBuilds);
    working = true;
    list = [{ label: 'Fix the bug', value: 'a', group: 'Working 1', ...(working ? { activity: 'working' as const } : {}) }];
    redraw!();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(painted).toBeGreaterThan(3);
  });
});
