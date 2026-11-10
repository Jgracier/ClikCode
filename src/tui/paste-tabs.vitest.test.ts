/** A paste keeps its tabs for the model; only the composer's drawing expands them. */
import { describe, expect, it } from 'vitest';
import { PASTE_END, PASTE_START, pastedText } from './keys.js';
import { composerLayout } from './render/composer-layout.js';
import { sanitizeTerminalText } from './render/text.js';

describe('tabs in a paste', () => {
  it('stay tabs in the text that is sent, while escapes and control bytes are still removed', () => {
    expect(pastedText(`${PASTE_START}a\tb\n\tc\u001b[31m\u0007${PASTE_END}`)).toBe('a\tb\n\tc');
    expect(sanitizeTerminalText('a\tb')).toBe('a   b');
  });

  it('are expanded only when the composer is drawn, and the cursor lands where the text does', () => {
    const value = 'ab\tcd';
    const layout = composerLayout(value, value.length, 40);
    expect(layout.rows).toEqual(['ab  cd']);
    expect(layout.cursorWidth).toBe(6);
    const mid = composerLayout(value, 3, 40);
    expect(mid.cursorWidth).toBe(4);
  });
});
