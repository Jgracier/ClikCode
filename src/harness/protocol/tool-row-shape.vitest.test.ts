import { describe, expect, it } from 'vitest';
import { formatToolRow, toolLabel } from './tools.js';
import { parseNativeActivityEventsFromValue } from './activity-events.js';
import { renderActivityLine } from './activity-line.js';
import { acpActivityEvent } from '../transport/acp-client.js';
import { localHarnessForCommand } from '@clikcode/router/ai-local-harness';

/**
 * One tool-row shape, whichever harness produced the event.
 *
 * These had drifted into four: `name(detail)`, a bare detail with no name,
 * `name` alone, and a hand-built `name(description)` that repeated the
 * formatting inline and only applied while the tool was still running. The
 * same action looked different depending on which vendor ran it, and an ACP
 * tool that FAILED -- the one most worth identifying -- lost its arguments
 * entirely.
 */
describe('formatToolRow is the single shape', () => {
  it('names the action by what it does, whatever the vendor called the tool', () => {
    expect(formatToolRow('Bash', 'cat x.txt')).toBe('$ cat x.txt');
    expect(formatToolRow('run_command', 'cat x.txt')).toBe('$ cat x.txt');
    expect(formatToolRow('developer__shell', 'cat x.txt', 'run')).toBe('$ cat x.txt');
    expect(formatToolRow('Read', 'src/x.ts')).toBe('Read src/x.ts');
    expect(formatToolRow('view_file', 'src/x.ts')).toBe('Read src/x.ts');
    expect(formatToolRow('read_file', 'src/x.ts', 'read')).toBe('Read src/x.ts');
    expect(formatToolRow('str_replace_editor', 'src/x.ts', 'edit')).toBe('Edit src/x.ts');
    expect(formatToolRow('Write', 'src/x.ts')).toBe('Write src/x.ts');
    expect(formatToolRow('Grep', 'TODO')).toBe('Grep TODO');
    expect(formatToolRow('WebFetch', 'https://example.com')).toBe('Fetch https://example.com');
    expect(formatToolRow('WebSearch', 'vitest docs')).toBe('Web search vitest docs');
    expect(formatToolRow('Task', 'review the tests')).toBe('Agent review the tests');
    expect(formatToolRow('mcp__github__create_issue', 'title=x')).toBe('github › create_issue title=x');
    expect(formatToolRow('mcp__clikcode-conversations__search_conversations', 'webhook')).toBe('Search conversation webhook');
    expect(formatToolRow('mcp__clikcode-conversations__read_conversation', 'id=365f1f74')).toBe('Read conversation id=365f1f74');
    expect(formatToolRow('search_conversations', 'webhook')).toBe('Search conversation webhook');
    expect(formatToolRow('hindsight')).toBe('Hindsight');
    expect(formatToolRow('active_conversations')).toBe('Active conversations');
  });

  it('keeps an unclassified tool\'s own name, bare when there is no detail', () => {
    expect(formatToolRow('manage_task')).toBe('manage_task');
    expect(formatToolRow('manage_task', '   ')).toBe('manage_task');
    expect(formatToolRow('frobnicate', 'x')).toBe('frobnicate x');
  });

  it('takes only the first line and marks that there is more', () => {
    // `$ ls` must not stand for `ls` followed by something else.
    expect(formatToolRow('Bash', 'echo one\necho two')).toBe('$ echo one …');
  });

  it('caps the detail so one long command cannot push the row off screen', () => {
    const row = formatToolRow('Bash', 'x'.repeat(500));
    expect(row.length).toBeLessThan(90);
  });

  it('is what toolLabel produces, so input-driven and detail-driven agree', () => {
    expect(toolLabel('Bash', { command: 'cat x.txt' })).toBe(formatToolRow('Bash', 'cat x.txt'));
    expect(toolLabel('mcp__github__create_issue', { title: 'Fix it', body: 'long '.repeat(20) }))
      .toMatch(/^github › create_issue title=Fix it body=long long/);
  });
});

describe('different vendors, same shape', () => {
  const goose = localHarnessForCommand('goose')!;
  // Goose's own Message serialization, per the parser's own doc comment:
  // { type:'message', message:{ content:[ {type:'toolRequest', toolCall:{status, value:{name, arguments}}} ] } }
  const gooseMessage = (status: string | undefined, args: Record<string, unknown>) => ({
    type: 'message',
    message: {
      content: [{
        type: 'toolRequest', id: 't1',
        toolCall: { ...(status ? { status } : {}), value: { name: 'developer__shell', arguments: args } },
      }],
    },
  });

  it('renders a vendor-prefixed shell exactly as antigravity\'s run_command', () => {
    const [ag] = parseNativeActivityEventsFromValue(localHarnessForCommand('antigravity')!, {
      event: 'step_update',
      step_update: {
        step_type: 'tool', state: 'ACTIVE', tool_name: 'run_command',
        tool_info: { parameters: { CommandLine: 'cat x.txt' } },
      },
    });
    const [gs] = parseNativeActivityEventsFromValue(goose, gooseMessage(undefined, { command: 'cat x.txt' }));
    // Different vendors, different tool names, one row.
    expect(ag?.label).toBe('$ cat x.txt');
    expect(gs?.label).toBe(ag?.label);
  });

  it('a tool that failed keeps the detail a running one showed', () => {
    const running = parseNativeActivityEventsFromValue(goose, gooseMessage(undefined, { command: 'cat missing.txt' }))[0];
    const failed = parseNativeActivityEventsFromValue(goose, gooseMessage('error', { command: 'cat missing.txt' }))[0];
    expect(running?.kind).toBe('tool-start');
    expect(failed?.kind).toBe('tool-error');
    // The regression this guards: the error branch used `label: name` while
    // the start branch used toolLabel(name, args), so a FAILING call -- the
    // one most worth identifying -- lost the argument saying which it was.
    expect(failed?.label).toBe(running?.label);
    expect(failed?.label).toBe('$ cat missing.txt');
  });
});

describe('what a finished row adds', () => {
  const plain = (lines: string[]) => lines[0]!.replace(/\u001b\[[0-9;]*m/g, '');

  it('shows a non-zero exit code and a run of a second or more', () => {
    expect(plain(renderActivityLine({ kind: 'tool-error', label: '$ npm test', category: 'run', exitCode: 2, durationMs: 3400 }))).toContain('failed (exit 2 · 3.4s)');
    expect(plain(renderActivityLine({ kind: 'tool-done', label: '$ make', category: 'run', exitCode: 0, durationMs: 95_000 }))).toMatch(/\$ make \(1m 35s\)$/);
  });

  it('adds nothing for what every call looks like: exit 0, under a second, or still running', () => {
    expect(plain(renderActivityLine({ kind: 'tool-done', label: '$ ls', category: 'run', exitCode: 0, durationMs: 40 }))).not.toContain('(');
    expect(plain(renderActivityLine({ kind: 'tool-start', label: '$ ls', category: 'run', durationMs: 4000 }))).not.toContain('(');
  });
});

describe('ACP rows', () => {
  it('build the row from the input rather than the agent\'s sentence', () => {
    expect(acpActivityEvent({ sessionUpdate: 'tool_call', toolCallId: 'a', title: '`npm test`', kind: 'execute', status: 'pending', rawInput: { command: 'npm test' } })?.label).toBe('$ npm test');
    expect(acpActivityEvent({ sessionUpdate: 'tool_call', toolCallId: 'b', title: 'Read config', kind: 'read', status: 'pending', locations: [{ path: 'src/config.ts' }] })?.label).toBe('Read src/config.ts');
    // Nothing better known: the title stays.
    expect(acpActivityEvent({ sessionUpdate: 'tool_call', toolCallId: 'c', title: 'Thinking about it', status: 'pending' })?.label).toBe('Thinking about it');
  });

  it('carry the exit code and duration its raw output reports', () => {
    expect(acpActivityEvent({ sessionUpdate: 'tool_call_update', toolCallId: 'a', status: 'failed', rawOutput: { exit_code: 1, duration_ms: 1500 } }))
      .toMatchObject({ kind: 'tool-error', exitCode: 1, durationMs: 1500 });
  });
});
