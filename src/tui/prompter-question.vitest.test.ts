/** A harness's question in the terminal's waiting band: answered with keys,
 * queued behind nothing it should overlap, and closed by its abort signal. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalHarnessPrompter } from './prompter.js';

const request = {
  title: 'Codex asks',
  questions: [
    { id: 'db', prompt: 'Which database?', options: [{ label: 'Postgres' }, { label: 'MySQL' }] },
    { id: 'name', prompt: 'Name it', options: [], allowFreeText: true },
  ],
};

/** The prompter paints to a TTY; give it a silent one. */
const realTty = process.stdout.isTTY;
const realWrite = process.stdout.write.bind(process.stdout);
function silentTty(): void {
  Object.assign(process.stdout, { isTTY: true, columns: 100, rows: 40 });
  process.stdout.write = (() => true) as typeof process.stdout.write;
}

function open(): { rl: TerminalHarnessPrompter; key: (k: string) => void } {
  const rl = new TerminalHarnessPrompter();
  rl.startWaiting('thinking', () => undefined, async () => ({ kind: 'sent' }) as never);
  const key = (k: string): void => (rl as unknown as { onWaitingKey(k: string): void }).onWaitingKey(k);
  return { rl, key };
}

describe('a harness question in the terminal', () => {
  beforeEach(silentTty);
  afterEach(() => { vi.useRealTimers(); Object.assign(process.stdout, { isTTY: realTty }); process.stdout.write = realWrite; });

  it('is answered with the keys, one question at a time, and typed text', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { rl, key } = open();
    try {
      const answered = rl.askQuestions(request);
      // Guarded: a key right after it appears answers nothing.
      key('2');
      vi.setSystemTime(Date.now() + 1000);
      key('2');
      vi.setSystemTime(Date.now() + 1000);
      for (const ch of 'prod') key(ch);
      key('\r');
      await expect(answered).resolves.toEqual({ kind: 'answered', answers: { db: ['MySQL'], name: ['prod'] } });
    } finally { rl.close(); }
  });

  it('preserves spaces in a hidden password answer', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { rl, key } = open();
    try {
      const answered = rl.askQuestions({ title: 'Private login', questions: [
        { id: 'password', prompt: 'Password', options: [], secret: true },
      ] });
      vi.setSystemTime(Date.now() + 1000);
      for (const ch of ' pass ') key(ch);
      key('\r');
      await expect(answered).resolves.toEqual({ kind: 'answered', answers: { password: [' pass '] } });
    } finally { rl.close(); }
  });

  it('shows a private email while typing but omits it from the transcript', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { rl, key } = open();
    try {
      const paint = vi.spyOn(rl, 'paint').mockImplementation(() => {});
      const answered = rl.askQuestions({ title: 'Sign in to accounts.google.com', questions: [
        { id: 'username', prompt: 'Email or phone', options: [], secret: true, maskInput: false },
      ] });
      vi.setSystemTime(Date.now() + 1000);
      for (const ch of 'private@example.com') key(ch);
      rl.paintWaiting(rl.turn!);
      expect(paint).toHaveBeenLastCalledWith('private@example.com', [], 0, '› ', 'private@example.com'.length);
      key('\r');
      await expect(answered).resolves.toEqual({ kind: 'answered', answers: { username: ['private@example.com'] } });
      expect(rl.history.join('\n')).not.toContain('private@example.com');
      expect(JSON.stringify(rl.journal)).not.toContain('private@example.com');
    } finally { rl.close(); }
  });

  it('picks an account with the arrow keys and Enter without writing the choice into history', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { rl, key } = open();
    try {
      const answered = rl.askQuestions({ title: 'Sign in to accounts.google.com', questions: [{
        id: 'account', prompt: 'Choose an account', secret: true,
        options: [{ label: 'one@example.com' }, { label: 'two@example.com' }, { label: 'Use a different account' }],
      }] });
      vi.setSystemTime(Date.now() + 1000);
      key('\u001b[B');
      key('\r');
      await expect(answered).resolves.toEqual({ kind: 'answered', answers: { account: ['two@example.com'] } });
      expect(rl.history.join('\n')).not.toContain('two@example.com');
      expect(JSON.stringify(rl.journal)).not.toContain('two@example.com');
    } finally { rl.close(); }
  });

  it('is cancelled by Esc', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { rl, key } = open();
    try {
      const answered = rl.askQuestions(request);
      vi.setSystemTime(Date.now() + 1000);
      key('\u001b');
      await expect(answered).resolves.toEqual({ kind: 'cancelled' });
    } finally { rl.close(); }
  });

  it('is closed by its abort signal, on screen or queued', async () => {
    const { rl } = open();
    try {
      const first = new AbortController();
      const second = new AbortController();
      const one = rl.askQuestions(request, first.signal);
      const two = rl.askQuestions(request, second.signal);
      second.abort();
      await expect(two).resolves.toEqual({ kind: 'cancelled' });
      first.abort();
      await expect(one).resolves.toEqual({ kind: 'cancelled' });
      const approval = new AbortController();
      const asked = rl.approval('Run make?', undefined, undefined, undefined, approval.signal);
      approval.abort();
      await expect(asked).resolves.toBe(false);
    } finally { rl.close(); }
  });

  it('is cancelled when the turn ends', async () => {
    const { rl } = open();
    try {
      const answered = rl.askQuestions(request);
      rl.stopWaiting();
      await expect(answered).resolves.toEqual({ kind: 'cancelled' });
    } finally { rl.close(); }
  });
});
