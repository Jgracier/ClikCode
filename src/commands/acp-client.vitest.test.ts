import { describe, expect, it } from 'vitest';
import { acpActivityEvent, acpArgvForHarness, acpResponseDelta } from './acp-client.js';

describe('shared ACP adapter contract', () => {
  it('normalizes agent prose and tool lifecycle events', () => {
    expect(acpResponseDelta({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } })).toBe('hello');
    expect(acpActivityEvent({ sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'Read config', status: 'pending' }))
      .toEqual({ kind: 'tool-start', id: 'call-1', label: 'Read config' });
    expect(acpActivityEvent({ sessionUpdate: 'tool_call_update', toolCallId: 'call-1', title: 'Read config', status: 'completed' }))
      .toEqual({ kind: 'tool-done', id: 'call-1', label: 'Read config' });
    expect(acpActivityEvent({ sessionUpdate: 'tool_call_update', toolCallId: 'call-1', title: 'Read config', status: 'failed' }))
      .toEqual({ kind: 'tool-error', id: 'call-1', label: 'Read config' });
  });

  it('preserves ACP diff content in the provider-neutral activity event', () => {
    expect(acpActivityEvent({
      sessionUpdate: 'tool_call_update', toolCallId: 'edit-1', title: 'Edit file', status: 'completed',
      content: [{ type: 'diff', path: '/repo/a.ts', oldText: 'old', newText: 'new' }],
    })).toMatchObject({ kind: 'tool-done', diff: { removed: ['old'], added: ['new'] } });
  });

  it('only opts providers with a verified ACP launch into the shared transport', () => {
    // Cursor Agent currently publishes structured stream-json but no ACP
    // subcommand; do not pay for a guaranteed failed spawn before fallback.
    expect(acpArgvForHarness('cursor')).toBeUndefined();
    expect(acpArgvForHarness('copilot')).toEqual(['--acp', '--stdio']);
    expect(acpArgvForHarness('droid')).toEqual(['exec', '--output-format', 'acp']);
    expect(acpArgvForHarness('aider')).toBeUndefined();
  });
});
