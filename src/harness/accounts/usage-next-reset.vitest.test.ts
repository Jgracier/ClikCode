import { describe, expect, it } from 'vitest';
import { usageNextReset, usageWindowsDetail } from './usage-reading';

// Local times, so the wording ("5:34PM", the weekday) holds in any timezone.
const NOW = new Date(2026, 9, 10, 9, 0).getTime();
const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).toISOString();

describe('the composer\'s reset beside the figure', () => {
  it('names the window closest to running out, with the date once it is not today', () => {
    const windows = [{ name: '5h', usedPct: 30, resetsAt: at(10, 17, 34) }, { name: 'weekly', usedPct: 80, resetsAt: at(14, 9) }];
    expect(usageNextReset(windows, NOW)).toBe('Weekly resets 9:00AM Wednesday Oct 14');
    expect(usageNextReset([{ name: '5h', usedPct: 60, resetsAt: at(10, 17, 34) }], NOW)).toBe('5h resets 5:34PM');
  });

  it('says nothing for advisory windows, past resets or windows with none', () => {
    expect(usageNextReset([{ name: 'API', usedPct: 90, resetsAt: at(14, 9), advisory: true }], NOW)).toBeUndefined();
    expect(usageNextReset([{ name: '5h', usedPct: 90, resetsAt: at(9, 9) }, { name: 'monthly', usedPct: 50 }], NOW)).toBeUndefined();
  });

  it('lists every window with what is left and its reset, for the tooltip', () => {
    expect(usageWindowsDetail([{ name: '5h', usedPct: 30, resetsAt: at(10, 17, 34) }, { name: 'monthly', usedPct: 50 }], NOW))
      .toBe('5h 70% left · resets 5:34PM\nMonthly 50% left');
    expect(usageWindowsDetail([], NOW)).toBeUndefined();
  });
});
