import { describe, expect, it } from 'vitest';
import { acpActivityEvent, acpApprovalDetail, acpResponseDelta, acpSpawnArgv } from './acp-client.js';

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

  it('renders a new file as added-only and caps very large diffs', () => {
    expect(acpActivityEvent({
      sessionUpdate: 'tool_call', toolCallId: 'w', title: 'Write', status: 'pending',
      content: [{ type: 'diff', path: '/repo/new.ts', oldText: null, newText: 'a\nb\n' }],
    })).toMatchObject({ diff: { removed: [], added: ['a', 'b'] } });
    const big = Array.from({ length: 500 }, (_, index) => `line ${index}`).join('\n');
    const event = acpActivityEvent({ sessionUpdate: 'tool_call', status: 'pending', content: [{ type: 'diff', oldText: big, newText: big }] })!;
    expect(event.diff!.added).toHaveLength(201);
    expect(event.diff!.removed).toHaveLength(201);
    expect(event.diff!.added.at(-1)).toBe('... 300 more lines');
  });

  it('carries bounded tool output', () => {
    expect(acpActivityEvent({
      sessionUpdate: 'tool_call_update', toolCallId: 'c', title: 'Run', status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'ok\n2 passed\n' } }],
    })).toEqual({ kind: 'tool-done', id: 'c', label: 'Run', output: ['ok', '2 passed'] });
  });

  it('describes what is being approved', () => {
    expect(acpApprovalDetail({ rawInput: { command: ['git', 'push'] } })).toBe('$ git push');
    expect(acpApprovalDetail({
      locations: [{ path: '/repo/a.ts' }],
      content: [{ type: 'diff', path: '/repo/a.ts', oldText: 'old', newText: 'new' }],
    })).toBe('/repo/a.ts\n- old\n+ new');
    expect(acpApprovalDetail({ title: 'Mystery' })).toBeUndefined();
  });

  /** The catalog describes an ACP launch -- the mode flag, and the model,
   * effort and permission flags derived from the harness's own entry -- and
   * passes it as `argv`/`extraArgv`. A second copy of those flags used to live
   * in this module as a fallback for callers that passed none, which was only
   * ever this test: production builds the launch from the catalog
   * (harnessAcpLaunch) on every turn. One description of a harness, and it is
   * the catalog. */
  it('assembles the launch the catalog handed it, and refuses without one', () => {
    expect(acpSpawnArgv({ command: 'droid', argv: ['exec', '--output-format', 'acp'], optionPlacement: 'after', extraArgv: ['--model', 'm'] }))
      .toEqual(['exec', '--output-format', 'acp', '--model', 'm']);
    expect(acpSpawnArgv({ command: 'kimi', argv: ['--acp'], extraArgv: ['--model', 'k2'] })).toEqual(['--model', 'k2', '--acp']);
    expect(acpSpawnArgv({ command: 'cursor' }), 'a harness with no catalog ACP launch cannot be spawned').toBeUndefined();
  });
});
