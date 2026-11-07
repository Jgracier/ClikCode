import { afterEach, describe, expect, it, vi } from 'vitest';
import { eraseInlineBlock, inlineBlock, inlineHistoryMode } from './inline.js';
import { sessionModesOn, redrawPreamble, phoneSignals, setFullPage, takeQueuedModes } from './modes.js';

describe('inline-history mode', () => {
  afterEach(() => { vi.unstubAllEnvs(); inlineBlock.rows = 0; inlineBlock.cursorRow = 0; });

  it('is chosen by the mobile client and forced by CLIKCODE_INLINE', () => {
    expect(inlineHistoryMode({})).toBe(false);
    expect(inlineHistoryMode({ CLIKDEPLOY_CLIENT: 'mobile' })).toBe(true);
    expect(inlineHistoryMode({ CLIKDEPLOY_CLIENT: 'mobile', CLIKCODE_INLINE: '0' })).toBe(false);
    expect(inlineHistoryMode({ CLIKCODE_INLINE: '1' })).toBe(true);
  });

  it('asks for no mouse reporting, and still asks for paste', () => {
    vi.stubEnv('CLIKDEPLOY_CLIENT', 'mobile');
    const on = sessionModesOn(true);
    expect(on).toContain('?2004h');
    expect(on).not.toMatch(/\?100[0236]h/);
    expect(redrawPreamble('resize')).not.toMatch(/\?100[0236]h/);
  });

  it('tells a page that was reloaded about the phone modes: every cleared inline repaint carries them again', () => {
    vi.stubEnv('CLIKDEPLOY_CLIENT', 'mobile');
    expect(phoneSignals()).toBe('\u001b[?9701h');
    setFullPage(true);
    expect(takeQueuedModes()).toBe('\u001b[?9702h');
    expect(phoneSignals()).toBe('\u001b[?9701h\u001b[?9702h');
    setFullPage(false);
    expect(takeQueuedModes()).toBe('\u001b[?9702l');
    expect(phoneSignals()).toBe('\u001b[?9701h');
    vi.stubEnv('CLIKDEPLOY_CLIENT', '');
    expect(phoneSignals()).toBe('');
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
