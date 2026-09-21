import { describe, expect, it } from 'vitest';
import { LoginField, maskSecret, renderLoginScreen } from './screen.js';
import { failureTail, redactSecrets } from './session.js';

const plain = (lines: readonly string[]): string => lines.join('\n').replace(/\u001b\[[0-9;]*m/g, '');

describe('LoginField', () => {
  it('collects typing and submits on Enter', () => {
    const field = new LoginField();
    expect(field.push('abc').kind).toBe('update');
    expect(field.push('\r')).toEqual({ kind: 'submit', value: 'abc' });
  });

  it('takes a bracketed paste as one unit, markers excluded', () => {
    const field = new LoginField();
    field.push('\u001b[200~sk-ant-api03-XYZ\u001b[201~');
    expect(field.contents).toBe('sk-ant-api03-XYZ');
  });

  it('does not submit on a newline inside a paste', () => {
    const field = new LoginField();
    // A copied credential often carries a trailing newline.
    const event = field.push('\u001b[200~key-line-one\nkey-line-two\u001b[201~');
    expect(event.kind).toBe('update');
    expect(field.contents).toBe('key-line-onekey-line-two');
  });

  it('handles backspace and Ctrl-U', () => {
    const field = new LoginField();
    field.push('abcd');
    field.push('\u007f');
    expect(field.contents).toBe('abc');
    field.push('\u0015');
    expect(field.contents).toBe('');
  });

  it('reports Ctrl-C and Ctrl-O', () => {
    expect(new LoginField().push('\u0003').kind).toBe('cancel');
    expect(new LoginField().push('\u000f').kind).toBe('reveal');
  });

  it('ignores arrow keys rather than typing their escape sequence', () => {
    const field = new LoginField();
    field.push('ab\u001b[Dcd');
    expect(field.contents).toBe('abcd');
  });

  it('clears after submit so a second paste starts empty', () => {
    const field = new LoginField();
    field.push('first\r');
    expect(field.contents).toBe('');
  });

  it('trims whitespace a phone keyboard adds around a paste', () => {
    const field = new LoginField();
    field.push('  code-123  ');
    expect(field.push('\r')).toEqual({ kind: 'submit', value: 'code-123' });
  });
});

describe('maskSecret', () => {
  it('shows length, never the value', () => {
    expect(maskSecret('sk-ant-123')).toBe('••••••••••');
    expect(maskSecret('')).toBe('');
  });

  it('caps the dots and states the real length for a long key', () => {
    expect(maskSecret('x'.repeat(100))).toBe(`${'•'.repeat(32)}… (100)`);
  });
});

describe('renderLoginScreen', () => {
  const base = { displayName: 'Antigravity CLI', shortUrl: 'https://accounts.google.com/…', copied: true, field: '' };

  it('gives a phone the link, the clipboard note and the field', () => {
    const text = plain(renderLoginScreen({ ...base, opened: false }));
    expect(text).toContain('Sign in to Antigravity CLI');
    expect(text).toContain('https://accounts.google.com/…');
    expect(text).toContain('Copied to your clipboard.');
    expect(text).toContain('Open it on your phone');
    expect(text).toContain('Paste the code or key here');
  });

  it('tells a desktop the browser already opened', () => {
    expect(plain(renderLoginScreen({ ...base, opened: true }))).toContain('A browser should have opened here.');
  });

  it('never shows the typed credential', () => {
    const text = plain(renderLoginScreen({ ...base, opened: false, field: 'sk-ant-secret' }));
    expect(text).not.toContain('sk-ant-secret');
    expect(text).toContain('•');
  });

  it('drops the field once the vendor has finished', () => {
    const ok = plain(renderLoginScreen({ ...base, opened: false, finished: 'ok' }));
    expect(ok).toContain('Signed in.');
    expect(ok).not.toContain('Paste the code');
  });

  it('says a failure is about to be explained', () => {
    expect(plain(renderLoginScreen({ ...base, opened: false, finished: 'failed' })))
      .toContain("the vendor's output follows");
  });

  it('always offers the way back to the raw output', () => {
    expect(plain(renderLoginScreen({ ...base, opened: false }))).toContain('Ctrl-O shows the raw output');
  });
});

describe('redactSecrets', () => {
  it('keeps a pasted key out of revealed output', () => {
    // The pty echoes everything written to it, so the credential is in there.
    const raw = 'awaiting key\nsk-ant-api03-SECRET\nRECEIVED=[sk-ant-api03-SECRET]\n';
    const safe = redactSecrets(raw, ['sk-ant-api03-SECRET']);
    expect(safe).not.toContain('sk-ant-api03-SECRET');
    expect(safe).toContain('«redacted»');
    expect(safe).toContain('awaiting key');
  });

  it('ignores a value too short to match without hitting prose', () => {
    expect(redactSecrets('a cat sat', ['cat'])).toBe('a cat sat');
  });
});

describe('failureTail', () => {
  it('redacts the credential it is about to print', () => {
    expect(failureTail('boom\nsk-ant-SECRET-VALUE\n', ['sk-ant-SECRET-VALUE']))
      .not.toContain('sk-ant-SECRET-VALUE');
  });

  it('keeps the end, where the error is, and drops blank lines', () => {
    const raw = `${Array.from({ length: 100 }, (_, index) => `line ${index}`).join('\n')}\n\n\nError: nope\n`;
    const tail = failureTail(raw);
    expect(tail).toContain('Error: nope');
    expect(tail).not.toContain('line 1\n');
    expect(tail.split('\n')).toHaveLength(40);
  });
});
