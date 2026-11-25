import { describe, expect, it } from 'vitest';
import { vendorProcessEnvironment } from './compaction.js';

describe('vendorProcessEnvironment', () => {
  it('drops a compaction threshold inherited from a parent Claude Code session', () => {
    const env = vendorProcessEnvironment({}, { PATH: '/bin', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '137656', CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '50' });
    expect(env).toEqual({ PATH: '/bin' });
  });

  it('keeps the threshold the launch sets', () => {
    const env = vendorProcessEnvironment({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '133000' }, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '137656', CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '50' });
    expect(env).toEqual({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '133000' });
  });
});
