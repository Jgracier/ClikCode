import { describe, expect, it } from 'vitest';
import { isContinuation, isDecision, presentTopics, recordsForRequests, topicSpans, topicsBefore, type HindsightMessage } from './hindsight.js';

const message = (index: number, role: 'user' | 'assistant', content: string, extra: Partial<HindsightMessage> = {}): HindsightMessage => ({ index, role, content, ...extra });

describe('topic cuts', () => {
  it('keeps a short reply in the topic and starts the next at a new request', () => {
    const messages = [
      { role: 'user', content: 'Fix the quota reprint' },
      { role: 'assistant', content: 'Retried the same line.' },
      { role: 'user', content: 'ok do it' },
      { role: 'assistant', content: 'The patch is gone.' },
      { role: 'user', content: 'before that' },
      { role: 'assistant', content: 'The publish workflow.' },
      { role: 'user', content: 'ok build it so that an agent can use them' },
      { role: 'assistant', content: 'Building hindsight.' },
    ];
    const spans = topicSpans(messages);
    expect(spans.map((span) => span.requests.map((request) => request.text))).toEqual([
      ['Fix the quota reprint', 'ok do it', 'before that'],
      ['ok build it so that an agent can use them'],
    ]);
    expect(isContinuation('do it\nchange the design')).toBe(false);
    expect(topicSpans([{ role: 'user', content: 'do it\nchange the design' }])).toHaveLength(1);
  });

  it('quotes a short direction change and not a long request that mentions one', () => {
    expect(isDecision('that is a bandaid')).toBe(true);
    expect(isDecision('ok do it')).toBe(true);
    expect(isDecision(`${'please '.repeat(40)}do not ship the guard`)).toBe(false);
  });
});

describe('presentTopics', () => {
  const messages: HindsightMessage[] = [
    message(0, 'user', 'Publish the CLI through ClikDeploy'),
    message(1, 'assistant', 'The publish workflow is in place.', { origin: { harness: 'grok', provider: 'xai', model: 'grok-4' } }),
    message(2, 'user', 'Fix the quota reprint'),
    message(3, 'assistant', 'Retried the same line.', { tools: ['Read src/turn/vendor-turn.ts'], origin: { harness: 'grok', provider: 'xai', model: 'grok-4.7' } }),
    message(4, 'user', 'that is a bandaid'),
    message(5, 'assistant', 'Removed the patch.'),
  ];

  it('treats a new running request as the topic in progress, and steps back one', () => {
    const presented = presentTopics(messages, {
      originFallback: 'grok grok-4.7',
      pending: { prompt: 'build the hindsight tool', tools: ['Read src/search/tools.ts'] },
      records: [{ at: '2026-10-06T12:00:00.000Z', prompt: 'Fix the quota reprint', changes: [{ path: 'src/turn/vendor-turn.ts', additions: 4, removals: 1 }] }],
    });
    expect(presented.current?.status).toBe('in progress');
    expect(presented.current?.requests[0]?.text).toBe('build the hindsight tool');
    expect(presented.current?.from).toBeUndefined();
    expect(presented.earlier).toHaveLength(2);
    const previous = presented.earlier[1]!;
    expect(previous.from).toBe(2);
    expect(previous.to).toBe(5);
    expect(previous.decisions.map((decision) => decision.text)).toEqual(['that is a bandaid']);
    expect(previous.files).toEqual([{ path: 'src/turn/vendor-turn.ts', additions: 4, removals: 1 }]);
    expect(previous.tools).toEqual(['Read src/turn/vendor-turn.ts']);
    expect(previous.origin).toBe('grok grok-4.7');
    expect(previous.finished).toBe('Removed the patch.');
  });

  it('keeps a short reply on the topic already open, including while that turn is running', () => {
    const presented = presentTopics(messages, { originFallback: 'grok', pending: { prompt: 'ok do it' } });
    expect(presented.current?.from).toBe(2);
    expect(presented.current?.status).toBe('in progress');
    expect(presented.earlier).toHaveLength(1);
  });

  it('drops a topic newer than before and keeps one the turn log cannot date', () => {
    const presented = presentTopics(messages, {
      originFallback: 'grok',
      pending: { prompt: 'build the hindsight tool' },
      records: [{ at: '2026-10-06T12:00:00.000Z', prompt: 'Fix the quota reprint', changes: [] }],
    });
    const kept = topicsBefore(presented.earlier, Date.parse('2026-10-06T11:00:00.000Z'));
    expect(kept.map((topic) => topic.from)).toEqual([0]);
    expect(kept[0]?.at).toBeUndefined();
  });
});

describe('recordsForRequests', () => {
  it('matches the sent prompt when one text contains the other', () => {
    const records = [{ at: 't', prompt: 'Fix the quota reprint\n\nInspect the workspace.', changes: [{ path: 'a.ts', additions: 1, removals: 0 }] }];
    expect(recordsForRequests(['Fix the quota reprint'], records)).toHaveLength(1);
    expect(recordsForRequests(['ok'], records)).toHaveLength(0);
  });
});
