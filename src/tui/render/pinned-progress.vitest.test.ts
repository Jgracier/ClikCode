import { describe, expect, it } from 'vitest';
import { backgroundStatusLine, pinnedProgressRows } from './pinned-progress';

const strip = (line: string): string => line.replace(/\u001b\[[0-9;]*m/g, '');

describe('pinned progress', () => {
  const lines = ['  agent Explore', '    Grep(charge)', '    Edit(bill.ts)'];

  it('keeps one line, the latest, until it is opened', () => {
    const closed = pinnedProgressRows({ lines, open: false, width: 80, limit: 6 });
    expect(closed).toHaveLength(1);
    expect(strip(closed[0]!)).toContain('Edit(bill.ts)');
    expect(strip(closed[0]!)).toContain('click');
    expect(strip(closed[0]!)).not.toContain('Grep');
  });

  it('opens onto the latest rows and closes back to one', () => {
    const open = pinnedProgressRows({ lines, open: true, width: 80, limit: 6 }).map(strip);
    expect(open).toEqual(lines);
    const again = pinnedProgressRows({ lines, open: false, width: 80, limit: 6 });
    expect(again).toHaveLength(1);
  });

  it('caps an open band to its newest rows', () => {
    const open = pinnedProgressRows({ lines, open: true, width: 80, limit: 2 }).map(strip);
    expect(open).toEqual(['    Grep(charge)', '    Edit(bill.ts)']);
  });

  it('says what background work is waiting, and shows it the same way', () => {
    expect(backgroundStatusLine({ agents: 2, workflows: 1 })).toBe('Waiting for 2 background agents and 1 dynamic workflow');
    expect(backgroundStatusLine({ terminals: 1 })).toBe('1 background terminal running');
    expect(backgroundStatusLine(undefined)).toBeUndefined();
    const closed = pinnedProgressRows({ lines: [], open: false, background: { agents: 2 }, width: 80, limit: 4 });
    expect(strip(closed[0]!)).toContain('Waiting for 2 background agents');
    const open = pinnedProgressRows({
      lines, open: true, background: { agents: 2 }, width: 80, limit: 6,
    }).map(strip);
    expect(open.at(-1)).toContain('Waiting for 2 background agents');
  });
});
