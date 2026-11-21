import { expect, it, vi } from 'vitest';
import { connectorShutdown } from './connectors.js';

it('repeated supervisor termination drains active work instead of forcing an exit', async () => {
  const notify = vi.fn(), force = vi.fn();
  const shutdown = connectorShutdown(notify, force);
  let finish!: () => void;
  const active = new Promise<void>(resolve => { finish = resolve; });
  expect(shutdown.requested()).toBe(false);
  shutdown.signal('SIGTERM');
  shutdown.signal('SIGTERM');
  expect(shutdown.requested()).toBe(true);
  expect(notify).toHaveBeenCalledTimes(1);
  expect(force).not.toHaveBeenCalled();
  finish();
  await active;
});

it('a second interactive interrupt can still force a stop', () => {
  const force = vi.fn();
  const shutdown = connectorShutdown(() => undefined, force);
  shutdown.signal('SIGINT');
  expect(force).not.toHaveBeenCalled();
  shutdown.signal('SIGINT');
  expect(force).toHaveBeenCalledTimes(1);
});
