import { describe, expect, it } from 'vitest';
import { Screen } from './screen.js';
import { readScreenPrompt } from './vendor-sign-in.js';

describe('the screen a sign-in draws', () => {
  it('places text where the cursor is sent, as a full-screen menu does (Hermes)', () => {
    const screen = new Screen(10, 60);
    screen.write('\u001b[?1049h\u001b[2;2HSelect provider:\u001b[4;4H(●) Nous Portal\u001b[5;4H(○) OpenRouter\u001b[6;4H(○) Leave unchanged');
    expect(screen.state().lines.slice(1, 6)).toEqual([' Select provider:', '', '   (●) Nous Portal', '   (○) OpenRouter', '   (○) Leave unchanged']);
  });

  it('keeps only the last drawing of a prompt redrawn in place', () => {
    const screen = new Screen(10, 60);
    screen.write('◆  Login method\n│  ● Browser\n│  ○ API key\n└\n');
    screen.write('\u001b[4A\u001b[J◆  Login method\n│  ○ Browser\n│  ● API key\n└\n');
    expect(screen.state().lines.slice(0, 4)).toEqual(['◆  Login method', '│  ○ Browser', '│  ● API key', '└']);
  });

  it('knows the line the cursor waits on', () => {
    const screen = new Screen(10, 60);
    screen.write('Starting\r\nPaste your API key: ');
    expect(screen.state()).toMatchObject({ row: 1, column: 20 });
    expect(readScreenPrompt(screen.state())).toEqual({ kind: 'input', prompt: 'Paste your API key', secret: true });
  });

  it('scrolls at the bottom and wraps at the edge', () => {
    const screen = new Screen(3, 10);
    screen.write('one\r\ntwo\r\nthree\r\nfour');
    expect(screen.state().lines).toEqual(['two', 'three', 'four']);
    const narrow = new Screen(3, 5);
    narrow.write('abcdefgh');
    expect(narrow.state().lines.slice(0, 2)).toEqual(['abcde', 'fgh']);
  });

  it('keeps a sequence split across two reads', () => {
    const screen = new Screen(5, 20);
    screen.write('ab\u001b[');
    screen.write('2Dz');
    expect(screen.state().lines[0]).toBe('zb');
  });
});
