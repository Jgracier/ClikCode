/** Where a download shows while it runs and when it ends: in the chat that asked for it, and in no other. */
import { afterEach, describe, expect, it } from 'vitest';
import { downloadsByChat, downloadText, followModelDownloads, followModelDownloadsInEditor } from './local-model';
import { backgroundDownloadsAllowed, modelDownloads, reportDownloadOutcome, startModelDownload } from '../../local-models/downloads';
import type { LocalModelProgress } from '../../local-models';
import type { HarnessSession } from '../../session/model';

afterEach(async () => { for (const job of modelDownloads()) { job.cancel(); await job.done.catch(() => undefined); } });

/** A fetch the test reports through and finishes by hand. */
function fetchWeights() {
  let report!: (update: LocalModelProgress) => void; let finish!: () => void;
  const fetch = (_model: string, progress: (update: LocalModelProgress) => void, signal?: AbortSignal): Promise<void> => {
    report = progress;
    return new Promise<void>((resolve, reject) => { finish = resolve; signal?.addEventListener('abort', () => reject(new Error('cancelled'))); });
  };
  return { fetch, report: (bytes: number, total: number) => report({ stage: 'download', message: 'downloading gemma-4-12b-it-Q4_0.gguf (6.7 GB)', bytes, totalBytes: total }), finish: () => finish() };
}
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

describe('the words', () => {
  it('say the model and how far along, short, and no number before there is a transfer to measure', () => {
    expect(downloadText({ label: 'Gemma 4 12B', progress: { stage: 'download', message: 'x', bytes: 1_072_000_000, totalBytes: 6_700_000_000 } })).toBe('Downloading Gemma 4 12B 16%');
    expect(downloadText({ label: 'Gemma 4 12B', progress: { stage: 'download', message: 'x', bytes: 9, totalBytes: 6 } })).toBe('Downloading Gemma 4 12B 100%');
    expect(downloadText({ label: 'Gemma 4 12B', progress: { stage: 'probe', message: 'checking this machine…' } })).toBe('Downloading Gemma 4 12B…');
    expect(downloadText({ label: 'Gemma 4 12B', progress: undefined })).toBe('Downloading Gemma 4 12B…');
  });

  it('belong to the chats that asked for the download, and to no other', async () => {
    const weights = fetchWeights();
    const job = startModelDownload('qwen3.5-9b', weights.fetch);
    // Started but asked for by nobody: it shows in no chat at all.
    expect([...downloadsByChat()]).toEqual([]);
    job.ask('s1');
    job.ask('s1');
    await tick();
    weights.report(1_000, 10_000);
    expect([...downloadsByChat()]).toEqual([['s1', 'Downloading Qwen3.5 9B 10%']]);
    startModelDownload('qwen3.5-9b', weights.fetch).ask('s2');
    expect([...downloadsByChat().keys()]).toEqual(['s1', 's2']);
    weights.finish();
    await job.done;
    expect([...downloadsByChat()]).toEqual([]);
  });
});

describe('a terminal window', () => {
  const fakeTerminal = () => {
    const calls: string[] = [];
    const terminal = {
      currentSession: { id: 's1' } as HarnessSession,
      setTransfer: (sessionId: string, label?: string) => { calls.push(`transfer ${sessionId} ${label ?? '-'}`); },
      noteFor: (sessionId: string, message: string) => { calls.push(`note ${sessionId} ${message.replace(/\u001b\[[0-9;]*m/g, '')}`); },
      render: (session: HarnessSession) => { calls.push(`render ${session.id}`); },
    };
    return { terminal, calls };
  };

  it('gives each download to the chat that asked for it as it moves, takes it away when it ends, and lets downloads run in the background while it is open', async () => {
    const { terminal, calls } = fakeTerminal();
    expect(backgroundDownloadsAllowed()).toBe(false);
    const stop = followModelDownloads(terminal);
    expect(backgroundDownloadsAllowed()).toBe(true);
    const weights = fetchWeights();
    const job = startModelDownload('qwen3.5-9b', weights.fetch);
    job.ask('s1');
    await tick();
    weights.report(1_000, 10_000);
    weights.report(5_000, 10_000);
    weights.finish();
    await job.done;
    // Only s1, the chat that asked: a chat that did not ask is never told anything, so it shows nothing.
    expect(calls.filter((call) => call.startsWith('transfer'))).toEqual([
      'transfer s1 Downloading Qwen3.5 9B…', 'transfer s1 Downloading Qwen3.5 9B 10%', 'transfer s1 Downloading Qwen3.5 9B 50%', 'transfer s1 -',
    ]);
    stop();
    expect(backgroundDownloadsAllowed()).toBe(false);
    // Closed: it is not told any more.
    const after = calls.length;
    reportDownloadOutcome({ sessionId: 's1', modelId: 'gemma-4-12b', switched: true, level: 'info', text: 'late' });
    expect(calls.length).toBe(after);
  });

  it('shows two chats\' downloads each in its own chat, and clears only the one that ended', async () => {
    const { terminal, calls } = fakeTerminal();
    const stop = followModelDownloads(terminal);
    const first = fetchWeights();
    const second = fetchWeights();
    const a = startModelDownload('qwen3.5-9b', first.fetch); a.ask('s1');
    const b = startModelDownload('gemma-4-12b', second.fetch); b.ask('s2');
    await tick();
    first.report(5_000, 10_000);
    calls.length = 0;
    first.finish();
    await a.done;
    // s1's row is cleared and s2's is never cleared: only the chat whose download ended loses its row.
    expect(calls.filter((call) => call.startsWith('transfer'))).toContain('transfer s1 -');
    expect(calls.filter((call) => call === 'transfer s2 -')).toEqual([]);
    second.finish();
    await b.done;
    stop();
  });

  it('hands how a download ended to the chat it is about -- which says it where it is open, or when it is next opened -- and redraws only when that chat is the one shown', () => {
    const { terminal, calls } = fakeTerminal();
    const stop = followModelDownloads(terminal);
    calls.length = 0;
    // A chat that is not the one shown moved: the line is for it, and the chat on screen is left alone.
    reportDownloadOutcome({ sessionId: 'elsewhere', modelId: 'm', switched: true, level: 'info', text: '"Notes" runs on Gemma 4 12B now.' });
    reportDownloadOutcome({ sessionId: 's1', modelId: 'm', switched: false, level: 'error', text: 'The download of Gemma 4 12B failed: HTTP 503.' });
    expect(calls).toEqual(['note elsewhere "Notes" runs on Gemma 4 12B now.', 'note s1 The download of Gemma 4 12B failed: HTTP 503.']);
    stop();
  });
});

describe('the editor', () => {
  it('puts the download on the busy line of the chat that asked, and no other, clears it at the end, and tells only that chat, refreshing it once it moved', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const otherChat: Array<Record<string, unknown>> = [];
    let refreshed = 0;
    const stop = followModelDownloadsInEditor((event) => sent.push(event), { sessionId: () => 's1', refresh: async () => { refreshed += 1; } });
    // The editor runs one bridge per chat: this is the one of a chat that did not ask.
    const stopOther = followModelDownloadsInEditor((event) => otherChat.push(event), { sessionId: () => 's2', refresh: async () => undefined });
    expect(backgroundDownloadsAllowed()).toBe(true);
    const weights = fetchWeights();
    const job = startModelDownload('qwen3.5-9b', weights.fetch);
    job.ask('s1');
    await tick();
    weights.report(5_000, 10_000);
    weights.finish();
    await job.done;
    expect(sent.filter((event) => event.type === 'busy').map((event) => event.label ?? null)).toEqual(['Downloading Qwen3.5 9B…', 'Downloading Qwen3.5 9B 50%', null]);
    // The other chat's busy line is never written to -- not to show it, and not to clear what something else put there.
    expect(otherChat).toEqual([]);
    sent.length = 0;
    reportDownloadOutcome({ sessionId: 'another-chat', modelId: 'm', switched: true, level: 'info', text: 'not this chat' });
    expect(sent).toEqual([]);
    reportDownloadOutcome({ sessionId: 's1', modelId: 'm', switched: true, level: 'info', text: 'Gemma 4 12B is downloaded.' });
    expect(sent).toEqual([{ type: 'notice', message: 'Gemma 4 12B is downloaded.', level: 'info' }]);
    await tick();
    expect(refreshed).toBe(1);
    reportDownloadOutcome({ sessionId: 's1', modelId: 'm', switched: false, level: 'error', text: 'failed' });
    await tick();
    expect(refreshed).toBe(1);
    stop();
    stopOther();
    expect(backgroundDownloadsAllowed()).toBe(false);
  });
});
