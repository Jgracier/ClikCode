import { describe, expect, it } from 'vitest';
import { failoverPrompt, INTERRUPTED_TURN_REQUEST, interruptedTurnFailoverPrompt } from './failover.js';
import { failoverPromptRequest, normalizeImportedTranscript } from './failover-prompt.js';
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
