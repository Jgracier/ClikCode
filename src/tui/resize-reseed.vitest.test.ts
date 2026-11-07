import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stdout } from 'node:process';
import { reseedIfScreenChanged } from './prompter/viewport.js';

/** What a settled resize owes the transcript. Inline the terminal moves its own rows when its height changes (pulls
 * saved lines back, adds blank rows at the bottom, drops the rows below the cursor), so a new height writes the
 * conversation again just as a new width does; on the alternate screen every row is drawn at an address and only a new
 * width matters. */
describe('what a settled resize owes the transcript', () => {
  let requested: number;
  let host: { transcriptColumns: number; transcriptRows: number; emitted: { requestReseed: () => void } };
  const size = (columns: number, rows: number): void => {
    Object.defineProperty(stdout, 'columns', { value: columns, configurable: true });
    Object.defineProperty(stdout, 'rows', { value: rows, configurable: true });
  };
  beforeEach(() => { requested = 0; host = { transcriptColumns: 69, transcriptRows: 35, emitted: { requestReseed: () => { requested += 1; } } }; size(69, 35); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('inline: a new height is written again, anchored to the new last row', () => {
    vi.stubEnv('CLIKCODE_INLINE', '1');
    size(69, 67);
    reseedIfScreenChanged.call(host as never);
    expect(requested).toBe(1);
    expect(host.transcriptRows).toBe(67);
    reseedIfScreenChanged.call(host as never);
    expect(requested).toBe(1); // the same size again owes nothing
  });

  it('inline: a new width is written again', () => {
    vi.stubEnv('CLIKCODE_INLINE', '1');
    size(100, 35);
    reseedIfScreenChanged.call(host as never);
    expect(requested).toBe(1);
  });

  it('the alternate screen: a new height owes nothing, a new width does', () => {
    vi.stubEnv('CLIKCODE_INLINE', '0');
    host.transcriptRows = 0;
    size(69, 67);
    reseedIfScreenChanged.call(host as never);
    expect(requested).toBe(0);
    size(50, 67);
    reseedIfScreenChanged.call(host as never);
    expect(requested).toBe(1);
  });
});
