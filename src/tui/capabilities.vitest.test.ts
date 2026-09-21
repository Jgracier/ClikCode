import { describe, expect, it } from 'vitest';
import { terminalUiSupported } from './capabilities';

describe('terminal capabilities', () => {
  it('uses the inline renderer only on ANSI-capable interactive terminals', () => {
    expect(terminalUiSupported(true, true, { TERM: 'xterm-256color' })).toBe(true);
    expect(terminalUiSupported(true, true, { WT_SESSION: '1' })).toBe(true);
    expect(terminalUiSupported(true, true, { TERM: 'dumb' })).toBe(false);
    expect(terminalUiSupported(false, true, { TERM: 'xterm' })).toBe(false);
  });
});
