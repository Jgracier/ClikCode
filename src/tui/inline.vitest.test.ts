import { afterEach, describe, expect, it, vi } from 'vitest';
import { eraseInlineBlock, inlineBlock, inlineHistoryMode } from './inline.js';
import { sessionModesOn, redrawPreamble } from './modes.js';

describe('inline-history mode', () => {
  afterEach(() => { vi.unstubAllEnvs(); inlineBlock.rows = 0; inlineBlock.cursorRow = 0; });

  it('is forced by CLIKCODE_INLINE, and no client name chooses it', () => {
    expect(inlineHistoryMode({})).toBe(false);
    expect(inlineHistoryMode({ CLIKDEPLOY_CLIENT: 'mobile' })).toBe(false);
    expect(inlineHistoryMode({ CLIKDEPLOY_CLIENT: 'mobile', CLIKCODE_INLINE: '1' })).toBe(true);
    expect(inlineHistoryMode({ CLIKCODE_INLINE: '1' })).toBe(true);
    expect(inlineHistoryMode({ CLIKCODE_INLINE: '0', TERM: 'dumb' })).toBe(false);
  });

  it('asks for no mouse reporting, and still asks for paste', () => {
    vi.stubEnv('CLIKCODE_INLINE', '1');
    const on = sessionModesOn(true);
    expect(on).toContain('?2004h');
    expect(on).not.toMatch(/\?100[0236]h/);
    expect(redrawPreamble('resize')).not.toMatch(/\?100[0236]h/);
  });

  it('asks for no phone-specific private mode, ever', () => {
    vi.stubEnv('CLIKDEPLOY_CLIENT', 'mobile');
    expect(sessionModesOn(true)).not.toMatch(/\?970\d/);
  });

  it('keeps the mouse outside inline mode', () => {
    vi.stubEnv('CLIKCODE_INLINE', '0');
    expect(sessionModesOn(true)).toContain('?1000h');
  });

  it('erases the block by walking up from the composer row, relative only', () => {
    inlineBlock.rows = 4; inlineBlock.cursorRow = 2;
    expect(eraseInlineBlock()).toBe('\u001b[2A\r\u001b[J');
    expect(eraseInlineBlock()).toBe('');
  });
});
