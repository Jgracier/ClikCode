import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { disposeSessionState, formatShellNotifications, sessionState, takeShellNotifications } from '../session-state.js';
import { bashOutputTool, killBashTool } from './bash.js';
import { monitorTool } from './monitor.js';
import type { ToolContext } from '../tool-contract.js';

const until = async (check: () => boolean, ms = 8000): Promise<void> => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 25));
  expect(check()).toBe(true);
};

describe.skipIf(process.platform === 'win32')('the monitor tool', () => {
  let dir: string;
  let ctx: ToolContext;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'clikcode-monitor-'));
    ctx = {
      cwd: dir, addDirs: [], sessionId: `mon-${Math.random()}`, turnId: 't', stateDir: dir, homeDir: dir,
      checkpoints: {} as ToolContext['checkpoints'], session: sessionState(dir, `mon-${Math.random()}`),
    } as ToolContext;
  });
  afterEach(async () => {
    disposeSessionState(dir, ctx.session.sessionId, 'test over');
    await rm(dir, { recursive: true, force: true });
  });

  const outputs = (): string[] => ctx.session.notifications.filter((note) => note.kind === 'output').map((note) => note.tail);

  it('is gated like bash: it runs a command', () => {
    expect(monitorTool.class).toBe('exec');
  });

  it('delivers each stdout line as it appears, while the command keeps running', async () => {
    const started = await monitorTool.run({ command: 'echo first; sleep 0.5; echo second; sleep 30', description: 'two events' }, ctx);
    expect(started.output).toMatch(/^Monitor started \(bash_1, expires in 300s/);
    await until(() => outputs().includes('first'));
    expect(outputs()).not.toContain('second');
    await until(() => outputs().includes('second'));
    expect(ctx.session.shells.get('bash_1')!.status).toBe('running');
    expect(formatShellNotifications(takeShellNotifications(ctx.session))).toContain('[background shell bash_1 output] two events\nfirst');
    await killBashTool.run({ id: 'bash_1' }, ctx);
  });

  it('batches a burst into one message and drops nothing within the batch cap', async () => {
    await monitorTool.run({ command: 'seq 1 5; sleep 30', description: 'burst' }, ctx);
    await until(() => outputs().length > 0);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(outputs()).toEqual(['1\n2\n3\n4\n5']);
    await killBashTool.run({ id: 'bash_1' }, ctx);
  });

  it('counts what a batch cannot carry', async () => {
    await monitorTool.run({ command: 'seq 1 100; sleep 30', description: 'flood' }, ctx);
    await until(() => outputs().length > 0);
    expect(outputs()[0]).toMatch(/… and 60 more line\(s\)$/);
    await killBashTool.run({ id: 'bash_1' }, ctx);
  });

  it('keeps stderr out of the event stream but in bash_output', async () => {
    await monitorTool.run({ command: 'echo oops >&2; echo event; sleep 30', description: 'streams' }, ctx);
    await until(() => outputs().includes('event'));
    expect(outputs().join()).not.toContain('oops');
    expect((await bashOutputTool.run({ id: 'bash_1' }, ctx)).output).toContain('oops');
    await killBashTool.run({ id: 'bash_1' }, ctx);
  });

  it('the last lines arrive before the exit notice, and an unterminated final line is kept', async () => {
    await monitorTool.run({ command: 'echo a; printf b', description: 'ends' }, ctx);
    await until(() => ctx.session.notifications.some((note) => note.kind !== 'output'));
    const kinds = ctx.session.notifications.map((note) => `${note.kind ?? 'exit'}:${note.tail}`);
    expect(kinds[0]).toBe('output:a\nb');
    expect(kinds[1]).toMatch(/^exit:/);
  });

  it('is stopped at its deadline, and says so', async () => {
    await monitorTool.run({ command: 'echo tick; sleep 30', description: 'short watch', timeout_ms: 1000 }, ctx);
    await until(() => ctx.session.notifications.some((note) => note.reason !== undefined));
    expect(ctx.session.notifications.find((note) => note.reason)!.reason).toMatch(/monitor "short watch" reached its 1s deadline after 1 line\(s\)/);
  });

  it('is stopped once it has delivered too many lines', async () => {
    await monitorTool.run({ command: 'yes line', description: 'unfiltered' }, ctx);
    await until(() => ctx.session.notifications.some((note) => note.reason !== undefined));
    expect(ctx.session.notifications.find((note) => note.reason)!.reason).toMatch(/delivered 500 lines and was stopped/);
    expect(outputs().join('\n').split('\n').filter((line) => line === 'line').length).toBeLessThanOrEqual(500);
  });

  it('persistent has no deadline', async () => {
    const started = await monitorTool.run({ command: 'sleep 30', description: 'forever', persistent: true }, ctx);
    expect(started.output).not.toMatch(/expires/);
    await killBashTool.run({ id: 'bash_1' }, ctx);
  });

  it('never runs a hard-denied command', async () => {
    const result = await monitorTool.run({ command: 'rm -rf /', description: 'no' }, ctx);
    expect(result.isError).toBe(true);
    expect(ctx.session.shells.size).toBe(0);
  });
});
