import { afterEach, describe, expect, it, vi } from 'vitest';
import { eraseInlineBlock, inlineBlock, inlineHistoryMode, swallowsAlternateScreen } from './inline.js';
import { ALTERNATE_SCROLL_ON, mouseWanted, redrawPreamble, sessionModesOn, setSelectionMode } from './modes.js';

describe('screen model selection', () => {
  afterEach(() => { vi.unstubAllEnvs(); inlineBlock.rows = 0; inlineBlock.cursorRow = 0; });

  const remote: Array<[string, NodeJS.ProcessEnv]> = [
    ['plain local xterm', { TERM: 'xterm-256color' }],
    ['empty env', {}],
    ['ssh, unknown terminal', { TERM: 'xterm-256color', SSH_CONNECTION: 'a 1 b 22', TERM_PROGRAM: 'Foo' }],
    ['ssh, tty only', { TERM: 'xterm-256color', SSH_TTY: '/dev/pts/1' }],
    ['ClikDeploy phone page', { TERM: 'xterm-256color', SSH_CONNECTION: 'a 1 b 22', CLIKDEPLOY_CLIENT: 'mobile' }],
    ['tmux, mouse option unknown', { TMUX: '/tmp/tmux-1/default,1,0', TERM: 'screen-256color' }],
    ['tmux over ssh', { TMUX: 'x', TERM: 'tmux-256color', SSH_TTY: '/dev/pts/1' }],
    ['GNU screen', { STY: '1.pts-0', TERM: 'screen-256color' }],
    ['TERM=dumb', { TERM: 'dumb' }],
    ['linux console', { TERM: 'linux' }],
    ['iTerm', { TERM_PROGRAM: 'iTerm.app' }],
  ];
  it.each(remote)('%s is full-screen', (_name, env) => {
    expect(inlineHistoryMode(env)).toBe(false);
  });

  it('inline is an opt-in, and only CLIKCODE_INLINE=1 gives it', () => {
    expect(inlineHistoryMode({ CLIKCODE_INLINE: '1', SSH_CONNECTION: 'a 1 b 22' })).toBe(true);
    expect(inlineHistoryMode({ CLIKCODE_INLINE: '0', STY: '1.x' })).toBe(false);
    expect(inlineHistoryMode({ CLIKCODE_INLINE: 'yes' })).toBe(false);
  });

  it('only GNU screen is taken for a client that swallows the alternate screen', () => {
    expect(swallowsAlternateScreen({ STY: '1.pts-0', TERM: 'screen' })).toBe(true);
    expect(swallowsAlternateScreen({ STY: '1.pts-0', TMUX: 'x' })).toBe(false);
    expect(swallowsAlternateScreen({ TMUX: 'x', TERM: 'screen-256color' })).toBe(false);
    expect(swallowsAlternateScreen({ TERM: 'xterm-256color' })).toBe(false);
  });

  it('full-screen asks for no mouse reporting (the client\'s selection works) and for alternate scroll, and still for paste', () => {
    vi.stubEnv('CLIKCODE_INLINE', '');
    vi.stubEnv('CLIKCODE_MOUSE', '');
    const on = sessionModesOn();
    expect(on).toContain('?2004h');
    expect(on).toContain(ALTERNATE_SCROLL_ON);
    expect(on).not.toMatch(/\?100[0236]h/);
    expect(redrawPreamble('resize')).not.toMatch(/\?100[0236]h/);
    expect(mouseWanted()).toBe(false);
  });

  it('CLIKCODE_MOUSE=1 opts in to the mouse, and /select hands it back and takes it again', () => {
    vi.stubEnv('CLIKCODE_INLINE', '');
    vi.stubEnv('CLIKCODE_MOUSE', '1');
    expect(sessionModesOn()).toContain('?1000h');
    expect(sessionModesOn()).not.toContain('?1007h');
    expect(setSelectionMode(true)).toMatch(/Selection mode on/);
    expect(setSelectionMode(false)).toMatch(/swipe-scrolling is back/);
  });

  it('/select without the mouse says the terminal\'s selection is already on, and changes nothing', () => {
    vi.stubEnv('CLIKCODE_INLINE', '');
    vi.stubEnv('CLIKCODE_MOUSE', '');
    expect(setSelectionMode(true)).toMatch(/always on/);
    expect(sessionModesOn()).not.toMatch(/\?100[0236]h/);
  });

  it('inline asks for no mouse reporting and no alternate scroll, and still asks for paste', () => {
    vi.stubEnv('CLIKCODE_INLINE', '1');
    vi.stubEnv('CLIKCODE_MOUSE', '1');
    const on = sessionModesOn();
    expect(on).toContain('?2004h');
    expect(on).not.toMatch(/\?100[0236]h|\?1007h/);
  });

  it('asks for no phone-specific private mode, ever', () => {
    vi.stubEnv('CLIKDEPLOY_CLIENT', 'mobile');
    expect(sessionModesOn()).not.toMatch(/\?970\d/);
  });

  it('erases the block by walking up from the composer row, relative only', () => {
    inlineBlock.rows = 4; inlineBlock.cursorRow = 2;
    expect(eraseInlineBlock()).toBe('\u001b[2A\r\u001b[J');
    expect(eraseInlineBlock()).toBe('');
  });
});
