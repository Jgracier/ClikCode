import { describe, expect, it } from 'vitest';
import { agentBudget, decideAction, desktopReserve, NUDGE_AT, STALL_STOP_PERCENT, nudgeNote, stopNote, viewProcesses, type ProcessEntry } from './resource-guard.js';

const GIB = 2 ** 30;
const proc = (pid: number, ppid: number, gib: number, exe: string, command: string): ProcessEntry => ({ pid, ppid, bytes: gib * GIB, exe, command });

/** Two conversations, as the slice holds them on this machine. */
const table: ProcessEntry[] = [
  // Conversation A: Claude through ACP, a test suite, an MCP server, a script that runs two things.
  proc(100, 1, 0.3, 'node', 'node /x/dist/index.js session-worker aaaa'),
  proc(101, 100, 0.1, 'node', 'node /usr/bin/claude-agent-acp'),
  proc(102, 101, 0.4, 'claude', '/opt/claude --output-format stream-json'),
  proc(103, 102, 0.01, 'bash', '/bin/bash -c npx vitest run'),
  proc(104, 103, 2.5, 'node', 'node /repo/node_modules/.bin/vitest run'),
  proc(105, 104, 0.6, 'node', 'node vitest fork'),
  proc(106, 104, 0.6, 'node', 'node vitest fork'),
  proc(107, 102, 0.01, 'sh', 'sh -c npx @upstash/context7-mcp'),
  proc(108, 107, 0.9, 'node', 'node /npx/context7-mcp/dist/index.js'),
  proc(109, 102, 0.01, 'bash', '/bin/bash -c ./pm.sh'),
  proc(110, 109, 0.01, 'bash', 'bash ./pm.sh full'),
  proc(111, 110, 1.1, 'node', 'node resident.mjs'),
  // Conversation B: Codex, one typecheck.
  proc(200, 1, 0.2, 'node', 'node /x/dist/index.js session-worker bbbb'),
  proc(201, 200, 0.3, 'codex', 'codex app-server'),
  proc(202, 201, 0.01, 'bash', 'bash -lc tsc --noEmit'),
  proc(203, 202, 3.0, 'node', 'node /repo/node_modules/.bin/tsc --noEmit'),
];

describe('resource guard', () => {
  it('gives agents what is free less the desktop reserve, never past the slice ceiling', () => {
    expect(desktopReserve(57 * GIB)).toBeCloseTo(57 * GIB * 0.08);
    expect(desktopReserve(16 * GIB)).toBe(4 * GIB);
    const roomy = agentBudget({ total: 57 * GIB, available: 30 * GIB, agentUsed: 10 * GIB });
    expect(roomy.limit / GIB).toBeCloseTo(10 + 30 - 57 * 0.08);
    const capped = agentBudget({ total: 57 * GIB, available: 30 * GIB, agentUsed: 10 * GIB, agentCeiling: 20 * GIB });
    expect(capped.limit / GIB).toBeCloseTo(20 * 0.97);
    expect(agentBudget({ total: 16 * GIB, available: 1 * GIB, agentUsed: 2 * GIB }).ratio).toBe(Infinity);
  });

  it('is over the limit when agents are choking on memory, whatever the numbers say', () => {
    // 2026-10-13: 34G of a 38G hard ceiling looked like room; MemoryHigh 34G was throttling every agent.
    const sample = { total: 57 * GIB, available: 10 * GIB, agentUsed: 34 * GIB, agentCeiling: 34 * GIB };
    expect(agentBudget(sample).ratio).toBeGreaterThan(1);
    const roomy = { total: 57 * GIB, available: 30 * GIB, agentUsed: 10 * GIB, agentCeiling: 38 * GIB };
    expect(agentBudget({ ...roomy, agentStalled: 2 }).ratio).toBeLessThan(NUDGE_AT);
    expect(agentBudget({ ...roomy, agentStalled: STALL_STOP_PERCENT }).ratio).toBe(1);
  });

  it('finds what agents ran: below a shell, with what it started; never the worker, the vendor or an MCP server', () => {
    const view = viewProcesses(table);
    expect(view.commands.map((command) => [command.root.pid, command.worker, +(command.bytes / GIB).toFixed(1)])).toEqual([
      [104, 100, 3.7], // vitest and its forks, one command
      [203, 200, 3.0],
      [111, 100, 1.1], // a script's own child, not the script
    ]);
    expect(view.byWorker.get(100)! / GIB).toBeCloseTo(6.54);
    expect(view.byWorker.get(200)! / GIB).toBeCloseTo(3.51);
  });

  it('nudges near the limit and stops the largest command past it, each acted on by its owner', () => {
    const view = viewProcesses(table);
    expect(decideAction({ used: 1, limit: 10, ratio: 0.5 }, view)).toEqual({ kind: 'none' });
    const near = decideAction({ used: 9, limit: 10, ratio: NUDGE_AT + 0.01 }, view);
    expect(near.kind === 'nudge' && [near.worker, near.command?.root.pid]).toEqual([100, 104]);
    const past = decideAction({ used: 11, limit: 10, ratio: 1.1 }, view);
    expect(past.kind === 'stop' && [past.command.worker, past.command.pids.sort()]).toEqual([100, [104, 105, 106]]);
    // Nothing an agent ran: the conversation holding the most is told, nothing is stopped.
    const idle = viewProcesses(table.filter((entry) => [100, 101, 102, 200, 201].includes(entry.pid)));
    expect(decideAction({ used: 11, limit: 10, ratio: 1.1 }, idle)).toEqual({ kind: 'nudge', worker: 100 });
  });

  it('never stops a command too small to free anything: it nudges instead', () => {
    // 2026-10-13: 70 of 102 stops were agents' 8 MB `sleep`s while memory sat outside any command.
    const sleeps = viewProcesses([
      proc(100, 1, 0.3, 'node', 'node /x/dist/index.js session-worker aaaa'),
      proc(101, 100, 0.4, 'claude', '/opt/claude'),
      proc(102, 101, 0.01, 'bash', '/bin/bash -c sleep 10'),
      proc(103, 102, 0.008, 'sleep', 'sleep 10'),
    ]);
    const over = { used: 36 * GIB, limit: 35 * GIB, ratio: 36 / 35 };
    expect(decideAction(over, sleeps)).toMatchObject({ kind: 'nudge', worker: 100 });
    expect(decideAction(over, viewProcesses(table))).toMatchObject({ kind: 'stop' });
  });

  it('tells the agent what happened and what to do instead', () => {
    const view = viewProcesses(table);
    const budget = { used: 30 * GIB, limit: 29 * GIB, ratio: 30 / 29 };
    const stop = stopNote(budget, 2, view.commands[0]!);
    expect(stop).toContain('ClikCode stopped `node /repo/node_modules/.bin/vitest run` (and 2 processes it started) at 3.7 GB');
    expect(stop).toContain('30.0 GB of 29.0 GB, shared by 2 conversations');
    expect(stop).toContain('killed (exit 137 / SIGKILL)');
    expect(stop).toContain('Do not rerun it unchanged');
    const nudge = nudgeNote({ used: 26 * GIB, limit: 29 * GIB, ratio: 26 / 29 }, 2, view.commands[0]);
    expect(nudge).toContain('agents are using 26.0 GB of the 29.0 GB they can have (2 conversations share it)');
    expect(nudge).toContain('is the largest command running, at 3.7 GB');
  });
});
