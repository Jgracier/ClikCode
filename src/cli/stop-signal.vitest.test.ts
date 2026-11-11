import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { expect, it } from 'vitest';
import { untilInputEnds } from './stop-signal.js';

it('a stdio server ends when its client closes stdin', async () => {
  const input = new PassThrough();
  const ended = untilInputEnds(createInterface({ input }));
  input.end();
  await expect(ended).resolves.toBeUndefined();
});

it('a stdio server ends when the process is told to stop, with stdin still open', async () => {
  const input = new PassThrough();
  const lines = createInterface({ input });
  const controller = new AbortController();
  const ended = untilInputEnds(lines, controller.signal);
  controller.abort();
  await expect(ended).resolves.toBeUndefined();
  expect(lines.closed).toBe(true);
});
