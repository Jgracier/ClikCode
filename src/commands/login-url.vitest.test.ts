import { describe, expect, it } from 'vitest';
import {
  extractLoginUrl, hasLocalDisplay, LoginUrlWatcher, loginUrlNotice, shortenLoginUrl, stripAnsi,
} from './login-url.js';
import { scriptArgv, shellQuote } from './login-tee.js';

/** Verbatim from a pty capture of `claude login`, the flow this models. */
const CLAUDE_LOGIN = [
  'Opening browser to sign in…',
  "Browser didn't open? Use the url below to sign in (c to copy)",
  'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a&response_type=code&scope=org%3Acreate_api_key+user%3Aprofile',
  'Paste code here if prompted > ',
].join('\n');

const AUTH_URL = 'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a&response_type=code&scope=org%3Acreate_api_key+user%3Aprofile';

describe('extractLoginUrl', () => {
  it('finds the sign-in URL in a real login', () => {
    expect(extractLoginUrl(CLAUDE_LOGIN)).toBe(AUTH_URL);
  });

  it('ignores a documentation link with no auth in it', () => {
    expect(extractLoginUrl('Welcome! Docs at https://example.com/getting-started')).toBeUndefined();
  });

  it('picks the authorisation URL out of a banner that also links docs', () => {
    const text = `Docs: https://example.com/docs\nSign in: ${AUTH_URL}\n`;
    expect(extractLoginUrl(text)).toBe(AUTH_URL);
  });

  it('sees through the colours a vendor TUI prints', () => {
    expect(extractLoginUrl(`\u001b[4;34m${AUTH_URL}\u001b[0m\n`)).toBe(AUTH_URL);
  });

  it('prefers the complete URL over a truncated reprint', () => {
    expect(extractLoginUrl(`https://claude.com/cai/oauth/authorize\n${AUTH_URL}\n`)).toBe(AUTH_URL);
  });
});

describe('stripAnsi', () => {
  it('removes CSI and OSC sequences', () => {
    expect(stripAnsi('\u001b[1mbold\u001b[0m\u001b]0;title\u0007 text')).toBe('bold text');
  });
});

describe('hasLocalDisplay', () => {
  it('is false on a headless Linux box', () => {
    expect(hasLocalDisplay({})).toBe(false);
  });

  it('is true with an X or Wayland display', () => {
    expect(hasLocalDisplay({ DISPLAY: ':0' })).toBe(true);
    expect(hasLocalDisplay({ WAYLAND_DISPLAY: 'wayland-0' })).toBe(true);
  });
});

describe('shortenLoginUrl', () => {
  it('shortens a long URL to its host, for display only', () => {
    expect(shortenLoginUrl(AUTH_URL)).toBe('https://claude.com/…');
  });

  it('leaves a URL that already fits alone', () => {
    expect(shortenLoginUrl('https://example.com/auth')).toBe('https://example.com/auth');
  });

  it('never sends the URL anywhere: the clipboard gets it in full', () => {
    const { clipboard } = loginUrlNotice(AUTH_URL, {});
    expect(Buffer.from(/\u001b\]52;c;([^\u0007]*)\u0007/.exec(clipboard)![1]!, 'base64').toString('utf8')).toBe(AUTH_URL);
  });
});

describe('loginUrlNotice', () => {
  it('tells a phone user to paste the code back', () => {
    expect(loginUrlNotice(AUTH_URL, {}).lines.join(' ')).toContain("phone's browser");
  });

  it('tells a desktop user a browser should have opened', () => {
    expect(loginUrlNotice(AUTH_URL, { DISPLAY: ':0' }).lines.join(' ')).toContain('should have opened');
  });
});

describe('LoginUrlWatcher', () => {
  const watcherFor = (environment: NodeJS.ProcessEnv) => {
    const written: string[] = [];
    const opened: string[] = [];
    const watcher = new LoginUrlWatcher({
      write: (chunk) => { written.push(chunk); }, environment, open: (url) => { opened.push(url); },
    });
    return { watcher, written, opened };
  };

  it('acts on the URL as soon as its line is complete', () => {
    const { watcher, written } = watcherFor({});
    expect(watcher.push(CLAUDE_LOGIN.slice(0, 120))).toBe(false);
    expect(watcher.push(`${CLAUDE_LOGIN.slice(120)}\n`)).toBe(true);
    expect(written.join('')).toContain('copied to your clipboard');
  });

  it('never acts on half a URL split across chunks', () => {
    const { watcher, written } = watcherFor({});
    expect(watcher.push(`https://claude.com/cai/oauth/authorize?code=`)).toBe(false);
    expect(written).toEqual([]);
  });

  it('acts once, so a reprint cannot clobber a code being pasted', () => {
    const { watcher } = watcherFor({});
    expect(watcher.push(`${AUTH_URL}\n`)).toBe(true);
    expect(watcher.push(`${AUTH_URL}\n`)).toBe(false);
  });

  it('opens a browser only where one is any use', () => {
    const headless = watcherFor({});
    headless.watcher.push(`${AUTH_URL}\n`);
    expect(headless.opened).toEqual([]);

    const desktop = watcherFor({ DISPLAY: ':0' });
    desktop.watcher.push(`${AUTH_URL}\n`);
    expect(desktop.opened).toEqual([AUTH_URL]);
  });

  it('keeps a redrawing TUI from growing the buffer without bound', () => {
    const { watcher } = watcherFor({});
    for (let index = 0; index < 50; index += 1) watcher.push(`${'x'.repeat(4000)}\n`);
    expect(watcher.seenUrl).toBe(false);
    expect(watcher.push(`${AUTH_URL}\n`)).toBe(true);
  });

  it('survives a handler that throws', () => {
    const watcher = new LoginUrlWatcher({
      write: () => { throw new Error('terminal gone'); }, environment: {}, open: () => {},
    });
    expect(() => watcher.push(`${AUTH_URL}\n`)).toThrow();
  });
});

describe('scriptArgv', () => {
  it('uses the util-linux form on Linux, with live flushing', () => {
    expect(scriptArgv('claude', ['login'], 'linux')).toEqual(['-q', '-e', '-f', '-c', "'claude' 'login'", '/dev/null']);
  });

  it('asks util-linux for the child exit status, which it does not report by default', () => {
    // Without -e, script always exits 0 and a failed sign-in looks successful.
    expect(scriptArgv('claude', ['login'], 'linux')).toContain('-e');
  });

  it('uses the BSD form on macOS, which takes argv rather than a shell string', () => {
    expect(scriptArgv('claude', ['login'], 'darwin')).toEqual(['-q', '/dev/null', 'claude', 'login']);
  });

  it('has no answer on Windows, so the caller falls back', () => {
    expect(scriptArgv('claude', ['login'], 'win32')).toBeUndefined();
  });

  it('quotes arguments so a vendor flag cannot become shell syntax', () => {
    expect(shellQuote(['agy', '-p', "hi; rm -rf /"])).toBe("'agy' '-p' 'hi; rm -rf /'");
    expect(shellQuote(["it's"])).toBe("'it'\\''s'");
  });

  it('passes Antigravity\'s real login argv through intact', () => {
    expect(scriptArgv('agy', ['-p', 'hi', '--output-format', 'json'], 'linux')?.[4])
      .toBe("'agy' '-p' 'hi' '--output-format' 'json'");
  });
});
