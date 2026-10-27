/** Where a download shows while it runs and when it ends: the terminal window's footer and the editor's busy line, for every chat. */
import { afterEach, describe, expect, it } from 'vitest';
import { downloadFooterText, followModelDownloads, followModelDownloadsInEditor } from './local-model';
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

describe('the footer words', () => {
  it('say the model and how far along, short, and no number before there is a transfer to measure', () => {
    expect(downloadFooterText({ label: 'Gemma 4 12B', progress: { stage: 'download', message: 'x', bytes: 1_072_000_000, totalBytes: 6_700_000_000 } })).toBe('↓ Gemma 4 12B 16%');
    expect(downloadFooterText({ label: 'Gemma 4 12B', progress: { stage: 'download', message: 'x', bytes: 9, totalBytes: 6 } })).toBe('↓ Gemma 4 12B 100%');
    expect(downloadFooterText({ label: 'Gemma 4 12B', progress: { stage: 'probe', message: 'checking this machine…' } })).toBe('↓ Gemma 4 12B…');
    expect(downloadFooterText({ label: 'Gemma 4 12B', progress: undefined })).toBe('↓ Gemma 4 12B…');
  });
});

describe('a terminal window', () => {
  const fakeTerminal = () => {
    const calls: string[] = [];
    const terminal = {
      currentSession: { id: 's1' } as HarnessSession,
      setTransfer: (label?: string) => { calls.push(`transfer ${label ?? '-'}`); },
      activity: (message: string) => { calls.push(`activity ${message.replace(/\u001b\[[0-9;]*m/g, '')}`); },
      render: (session: HarnessSession) => { calls.push(`render ${session.id}`); },
    };
    return { terminal, calls };
  };

  it('shows every download in its footer as it moves, clears it when it ends, and lets downloads run in the background while it is open', async () => {
    const { terminal, calls } = fakeTerminal();
    expect(backgroundDownloadsAllowed()).toBe(false);
    const stop = followModelDownloads(terminal);
    expect(backgroundDownloadsAllowed()).toBe(true);
    const weights = fetchWeights();
    const job = startModelDownload('qwen3.5-9b', weights.fetch);
    await tick();
    weights.report(1_000, 10_000);
    weights.report(5_000, 10_000);
    weights.finish();
    await job.done;
    expect(calls.filter((call) => call.startsWith('transfer'))).toEqual(['transfer -', 'transfer ↓ Qwen3.5 9B 10%', 'transfer ↓ Qwen3.5 9B 50%', 'transfer -']);
    stop();
    expect(backgroundDownloadsAllowed()).toBe(false);
    // Closed: it is not told any more.
    const after = calls.length;
    reportDownloadOutcome({ sessionId: 's1', modelId: 'gemma-4-12b', switched: true, level: 'info', text: 'late' });
    expect(calls.length).toBe(after + 0);
  });

  it('tells how a download ended in the chat open, and redraws only when the chat shown is the one that moved', () => {
    const { terminal, calls } = fakeTerminal();
    const stop = followModelDownloads(terminal);
    calls.length = 0;
    // A chat that is not the one shown moved: the line names it, the footer is left alone.
    reportDownloadOutcome({ sessionId: 'elsewhere', modelId: 'm', switched: true, level: 'info', text: '"Notes" runs on Gemma 4 12B now.' });
    reportDownloadOutcome({ sessionId: 's1', modelId: 'm', switched: false, level: 'error', text: 'The download of Gemma 4 12B failed: HTTP 503.' });
    expect(calls).toEqual(['activity "Notes" runs on Gemma 4 12B now.', 'activity The download of Gemma 4 12B failed: HTTP 503.']);
    stop();
  });
});

describe('the editor', () => {
  it('shows every download on the busy line, clears it at the end, and tells only the chat that asked, refreshing it once it moved', async () => {
    const sent: Array<Record<string, unknown>> = [];
    let refreshed = 0;
    const stop = followModelDownloadsInEditor((event) => sent.push(event), { sessionId: () => 's1', refresh: async () => { refreshed += 1; } });
    expect(backgroundDownloadsAllowed()).toBe(true);
    const weights = fetchWeights();
    const job = startModelDownload('qwen3.5-9b', weights.fetch);
    await tick();
    weights.report(5_000, 10_000);
    weights.finish();
    await job.done;
    expect(sent.filter((event) => event.type === 'busy').map((event) => event.label ?? null)).toEqual(['↓ Qwen3.5 9B 50%', null]);
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
    expect(backgroundDownloadsAllowed()).toBe(false);
  });
});
