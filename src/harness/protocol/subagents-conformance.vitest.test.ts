/** `subagents: { read, steer }` is declared once per harness and held to
 * `capabilities.childActivity` and to docs/SUBAGENTS.md, the evidence. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AI_LOCAL_HARNESSES } from '@clikcode/router/ai-local-harness';
import { subAgentRef, subAgentRelayText, subAgentSteerBlock, subAgentSteerPlan } from './activity-normalize.js';

const matrix = readFileSync(new URL('../../../docs/SUBAGENTS.md', import.meta.url), 'utf8');
const row = (command: string): string => matrix.split('\n').find((line) => line.startsWith(`| ${command} `) || line.startsWith(`| ${command}(`)) ?? '';

describe('sub-agent capability declarations', () => {
  it.each(AI_LOCAL_HARNESSES.map((h) => [h.command, h] as const))('%s declares read and steer, consistent with childActivity', (command, harness) => {
    const declared = harness.subagents;
    expect(declared, `${command}: no subagents declaration`).toBeDefined();
    const frames = harness.capabilities?.childActivity === true;
    expect(declared!.read !== 'none', `${command}: read ${declared!.read} vs childActivity ${frames}`).toBe(frames);
    if (declared!.steer === 'relay') expect(declared!.read).not.toBe('none');
    if (declared!.steer === 'thread') expect(declared!.read).toBe('thread');
    if (declared!.steer === 'session') expect(declared!.read).toBe('session');
  });

  it.each(AI_LOCAL_HARNESSES.map((h) => [h.command, h] as const))('%s matches its row in docs/SUBAGENTS.md', (command, harness) => {
    const line = row(command === 'command' ? 'command (cmdc)' : command === 'cn' ? 'cn (Continue)' : command);
    expect(line, `${command}: no row in docs/SUBAGENTS.md`).not.toBe('');
    expect(line.includes(`\`${harness.subagents!.read}\` / \`${harness.subagents!.steer}\``), `${command}: doc row disagrees with the declaration`).toBe(true);
  });
});

describe('subAgentRef', () => {
  const modes = { read: 'thread', steer: 'none' } as const;
  it('names the Codex thread from the row id and reads the status from the frame', () => {
    const ref = subAgentRef({ kind: 'tool-start', label: 'reply_ok', agent: true, id: 'agent:t-1' }, 'codex', modes);
    expect(ref).toEqual({ id: 'agent:t-1', agentId: 't-1', label: 'reply_ok', status: 'running', harness: 'codex', read: 'thread', steer: 'none' });
    expect(subAgentRef({ kind: 'tool-error', label: 'x', agent: true, id: 'a', stopped: true }, 'claude', undefined)?.status).toBe('stopped');
  });
  it('is not made for a child, a plain call or a thought', () => {
    expect(subAgentRef({ kind: 'tool-start', label: 'x', agent: true, id: 'a', parentId: 'p' }, 'claude', modes)).toBeUndefined();
    expect(subAgentRef({ kind: 'tool-start', label: '$ ls', id: 'a' }, 'claude', modes)).toBeUndefined();
    expect(subAgentRef({ kind: 'thinking', label: 'hm', agent: true, id: 'a' }, 'claude', modes)).toBeUndefined();
  });
  it('says exactly why a composer is read-only', () => {
    const running = subAgentRef({ kind: 'tool-start', label: 'x', agent: true, id: 'a' }, 'codex', modes)!;
    expect(subAgentSteerBlock(running, 'Codex')).toContain('read-only');
    expect(subAgentSteerBlock({ ...running, steer: 'relay' }, 'Claude Code')).toBeUndefined();
    expect(subAgentSteerBlock({ ...running, status: 'done', steer: 'relay' }, 'Claude Code')).toContain('finished');
  });
  it('relays by label and agent id, in the user\'s words', () => {
    expect(subAgentRelayText({ id: 'a', agentId: 'ab12', label: 'Agent explore', status: 'running', harness: 'claude', read: 'transcript', steer: 'relay' }, 'also check tests'))
      .toBe('Send this to your sub-agent Agent explore (ab12): also check tests');
  });
  it('plans a steer: a relay when the main agent runs, else one line why not', () => {
    const base = { id: 'a', label: 'Agent explore', status: 'running', harness: 'claude', read: 'transcript', steer: 'relay' } as const;
    expect(subAgentSteerPlan(base, 'Claude Code', true, 'hi')).toEqual({ steer: 'Send this to your sub-agent Agent explore: hi' });
    expect(subAgentSteerPlan(base, 'Claude Code', false, 'hi')).toHaveProperty('refuse');
    expect(subAgentSteerPlan({ ...base, steer: 'none' }, 'Codex', true, 'hi')).toEqual({ refuse: expect.stringContaining('read-only') });
    expect(subAgentSteerPlan({ ...base, steer: 'thread' }, 'Codex', true, 'hi')).toEqual({ refuse: expect.stringContaining('not send') });
  });
});
