import { describe, expect, it } from 'vitest';
import { createToolLog, firstErrorLine } from './tool-log.js';
import { redactForLog } from '../runtime/redact.js';

describe('the log line for a finished tool call', () => {
  it("names a call from its start when its end carries only an id (the 48 calls that were all 'tool')", () => {
    let clock = 1_000;
    const log = createToolLog(() => clock);
    log.note({ kind: 'tool-start', label: '$ cd clikcode && git status', id: 'toolu_013JnXoDT3hFMLQpM87ThEab', parentId: 'toolu_01V47A', category: 'run', call: { name: 'Bash', input: { command: 'cd clikcode && git status' } } });
    clock = 1_450;
    const fields = log.finished({
      kind: 'tool-error', label: 'tool', id: 'toolu_013JnXoDT3hFMLQpM87ThEab', parentId: 'toolu_01V47A', exitCode: 1,
      output: ['', 'This agent is isolated in the worktree /home/me/projects/clikdeploy/.claude/worktrees/agent-1; cd outside it is refused.', 'second line'],
    });
    expect(fields).toEqual({
      name: 'Bash', ok: false, id: 'M87ThEab', category: 'run', child: true, ms: 450, exit: 1,
      err: 'This agent is isolated in the worktree /home/me/projects/clikdeploy/.claude/worktrees/agent-1; cd outside it is refused.',
    });
  });

  it('keeps no name it was not given, and no error text for a call that worked', () => {
    const log = createToolLog();
    expect(log.finished({ kind: 'tool-done', label: 'tool', output: ['secret contents of a file'] })).toEqual({ name: 'tool', ok: true });
  });

  it('masks secrets and cuts the line short', () => {
    const line = firstErrorLine([`failed with token sk-ant-api03-${'a'.repeat(60)} ${'x'.repeat(400)}`]);
    expect(line).toBeDefined();
    expect(line!.length).toBeLessThanOrEqual(160);
    expect(line).not.toContain('sk-ant-api03-aaaa');
    expect(line).toContain('[secret hidden]');
    for (const text of ['Authorization: Bearer abcdef0123456789abcdef', 'ghp_abcdefghijklmnopqrstuvwxyz0123', 'API_KEY=supersecretvalue1', 'postgres://user:hunter2hunter2@db/x']) {
      expect(redactForLog(text)).not.toMatch(/abcdef0123456789|ghp_abcdef|supersecretvalue1|hunter2/);
    }
    // Ordinary words are left alone.
    expect(redactForLog('token budget exceeded for this model')).toBe('token budget exceeded for this model');
  });

  it('forgets a call once it ends, and bounds how many it holds open', () => {
    const log = createToolLog();
    for (let index = 0; index < 1_000; index += 1) log.note({ kind: 'tool-start', label: 'x', id: `call-${index}`, call: { name: 'Read', input: {} } });
    expect(log.finished({ kind: 'tool-done', label: 'tool', id: 'call-0' }).name).toBe('tool'); // evicted
    expect(log.finished({ kind: 'tool-done', label: 'tool', id: 'call-999' }).name).toBe('Read');
    expect(log.finished({ kind: 'tool-done', label: 'tool', id: 'call-999' }).name).toBe('tool'); // already closed
  });
});
