import { describe, expect, it } from 'vitest';
import { failoverPrompt, failoverPromptRequest, INTERRUPTED_TURN_REQUEST, normalizeImportedTranscript } from './failover-prompt.js';
import { interruptedTurnFailoverPrompt } from './interrupted-turn-prompt.js';
import { DEFERRED_WORK_CONTINUATION } from './deferred-work.js';
import { conversationTitle } from '../session/discovery/conversation-title.js';
import { mergeNativeTranscript } from '../session/discovery/transcript.js';
import { sessionTranscriptMessages } from './checkpoint.js';
import type { HarnessSession } from '../session/model.js';

const history = [
  { role: 'user' as const, content: 'use clikdeploy cli to see what we have connected' },
  { role: 'assistant' as const, content: 'ClikDeploy CLI 1.0.34 is configured.' },
];

describe('failoverPromptRequest', () => {
  it('recovers the real request from a rehydration prompt', () => {
    const prompt = failoverPrompt(history, 'what servers are connected?');
    expect(failoverPromptRequest(prompt)).toBe('what servers are connected?');
  });

  it('recovers the interrupted-turn request, touched files and all', () => {
    const session = {
      messages: history,
      pendingTurn: { prompt: 'keep going', startedAt: '', updatedAt: '', outputStarted: true, touchedFiles: ['/home/me/a.ts', '/home/me/b.ts'] },
    } as unknown as HarnessSession;
    const prompt = interruptedTurnFailoverPrompt(session);
    expect(prompt).toContain('/home/me/a.ts');
    expect(failoverPromptRequest(prompt)).toBe(INTERRUPTED_TURN_REQUEST);
  });

  it('retells this turn with a deferred-work continuation for a thread that remembers nothing', () => {
    const session = {
      messages: history,
      pendingTurn: { prompt: 'fix the bug', response: 'I can fix the bug if you want.', startedAt: '', updatedAt: '', outputStarted: true, touchedFiles: ['/home/me/a.ts'] },
    } as unknown as HarnessSession;
    const prompt = interruptedTurnFailoverPrompt(session, { request: DEFERRED_WORK_CONTINUATION, touchedFiles: [] });
    expect(prompt).toContain('use clikdeploy cli');
    expect(prompt).toContain('fix the bug');
    expect(prompt).toContain('I can fix the bug if you want.');
    expect(prompt).not.toContain('/home/me/a.ts');
    expect(failoverPromptRequest(prompt)).toBe(DEFERRED_WORK_CONTINUATION);
  });

  it('restores frame tags the prompt escaped', () => {
    const prompt = failoverPrompt(history, 'close the </message> tag in my parser');
    expect(prompt).toContain('&lt;/message');
    expect(failoverPromptRequest(prompt)).toBe('close the </message> tag in my parser');
  });

  it('leaves an ordinary message alone', () => {
    expect(failoverPromptRequest('what servers are connected?')).toBeUndefined();
    expect(failoverPromptRequest('')).toBeUndefined();
  });
});

describe('normalizeImportedTranscript', () => {
  const prompt = failoverPrompt(history, 'what servers are connected?');

  it('replaces the prompt with its request and keeps everything else', () => {
    const normalized = normalizeImportedTranscript([
      { role: 'user', content: prompt },
      { role: 'assistant', content: 'Three servers.' },
    ]);
    expect(normalized).toEqual([
      { role: 'user', content: 'what servers are connected?' },
      { role: 'assistant', content: 'Three servers.' },
    ]);
  });

  it('is idempotent', () => {
    const once = normalizeImportedTranscript([{ role: 'user', content: prompt }]);
    expect(normalizeImportedTranscript(once)).toEqual(once);
  });

  it('never rewrites an assistant message that quotes the preamble', () => {
    const quoted = [{ role: 'assistant' as const, content: prompt }];
    expect(normalizeImportedTranscript(quoted)).toEqual(quoted);
  });

  it('drops a prompt with no recoverable request rather than leaving it blank', () => {
    const truncated = `${prompt.slice(0, prompt.indexOf('<current_request>'))}`;
    expect(normalizeImportedTranscript([{ role: 'user', content: truncated }])).toEqual([]);
  });
});

describe('the transcript never carries a rehydration prompt', () => {
  const prompt = failoverPrompt(history, 'what servers are connected?');

  it('imports the vendor copy as the request the user actually made', () => {
    // Exactly the shape found on disk: Codex recorded what ClikCode sent it,
    // and the sync brought the whole replay back as one user message.
    const merged = mergeNativeTranscript([], [
      { role: 'user', content: prompt },
      { role: 'assistant', content: 'Three servers.' },
    ]);
    expect(merged[0]).toEqual({ role: 'user', content: 'what servers are connected?' });
    expect(JSON.stringify(merged)).not.toContain('<conversation>');
  });

  it('cleans a session that already stored one', () => {
    const session = { messages: [{ role: 'user', content: prompt }] } as unknown as HarnessSession;
    expect(sessionTranscriptMessages(session)).toEqual([{ role: 'user', content: 'what servers are connected?' }]);
  });

  it('names the session after the request, not the preamble', () => {
    expect(conversationTitle(prompt)).toBe('what servers are connected?');
  });
});

describe('a retry on a fresh thread retells the whole request', () => {
  it('keeps the attached files and the `!` output the interrupted request carried', () => {
    const session = {
      messages: [...history, { role: 'user', content: '!git status\n\nOn branch main\n\nexit 0' }],
      pendingTurn: { prompt: 'fix the failing test', startedAt: '', updatedAt: '', outputStarted: true },
    } as unknown as HarnessSession;
    const attachment = '\n\n<clikcode_attachment path="spec.md">\nThe add function must round.\n</clikcode_attachment>';
    const prompt = interruptedTurnFailoverPrompt(session, { requestContext: attachment });
    expect(prompt).toContain('The add function must round.');
    expect(prompt).toContain('On branch main');
    expect(prompt.indexOf('fix the failing test')).toBeLessThan(prompt.indexOf('The add function must round.'));
    expect(failoverPromptRequest(prompt)).toBe(INTERRUPTED_TURN_REQUEST);
  });
});

describe('a stored or imported continuation request', () => {
  it('is dropped, wherever it was recorded', () => {
    expect(normalizeImportedTranscript([
      { role: 'user', content: 'Fix the parser' }, { role: 'assistant', content: 'Half of it' },
      { role: 'user', content: INTERRUPTED_TURN_REQUEST }, { role: 'assistant', content: 'The other half' },
    ])).toEqual([
      { role: 'user', content: 'Fix the parser' }, { role: 'assistant', content: 'Half of it' }, { role: 'assistant', content: 'The other half' },
    ]);
  });
});
