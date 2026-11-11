/** A status update while the slash palette is open is drawn, and the palette stays as it was. */
import { stdin } from 'node:process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KEEP_STDIN_FLOWING } from './input-decoder.js';
import { TerminalHarnessPrompter } from './prompter.js';

const realTty = process.stdout.isTTY;
const realInTty = stdin.isTTY;
const realWrite = process.stdout.write.bind(process.stdout);
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('status updates with the palette open', () => {
  beforeEach(() => {
    Object.assign(process.stdout, { isTTY: true, columns: 100, rows: 40 });
    Object.assign(stdin, { isTTY: true, setRawMode: () => stdin });
    process.stdout.write = (() => true) as typeof process.stdout.write;
    stdin.on('data', KEEP_STDIN_FLOWING);
  });
  afterEach(() => {
    stdin.off('data', KEEP_STDIN_FLOWING); stdin.pause();
    Object.assign(process.stdout, { isTTY: realTty });
    Object.assign(stdin, { isTTY: realInTty });
    process.stdout.write = realWrite;
  });

  it('repaints a usage change with the palette kept', async () => {
    const rl = new TerminalHarnessPrompter();
    try {
      rl.paletteCommands = [{ label: '/model', value: '/model' }, { label: '/help', value: '/help' }] as never;
      rl.render({ id: 's1', route: 'local', accountId: null, provider: null, model: null, createdAt: '', updatedAt: '', status: 'active', messages: [] } as never);
      void rl.question('› ', rl.paletteCommands).catch(() => undefined);
      stdin.emit('data', Buffer.from('/'));
      const paint = vi.spyOn(rl, 'paint');
      rl.usage('5h 40% left');
      await wait(100);
      expect(paint).toHaveBeenCalled();
      const last = paint.mock.calls.at(-1)!;
      expect(last[0]).toBe('/');
      expect(last[5]).toMatchObject({ capacity: expect.any(Number) });
    } finally { rl.close(); }
  });
});
