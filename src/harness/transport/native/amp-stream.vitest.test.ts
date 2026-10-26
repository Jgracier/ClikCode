import { expect, it, vi } from 'vitest';
import { createAmpStreamTurn, ampUserMessage } from './amp-stream.js';
import { LiveTurnInputBroker } from '../../../turn/live-input.js';

const user = (text: string) => JSON.parse(ampUserMessage(text));
const assistant = (content: object[], stop_reason = 'end_turn') => ({ type: 'assistant', message: { content, stop_reason } });
const tool = (id: string, name = 'shell_command', input = {}) => ({ type: 'tool_use', id, name, input });
const result = (id: string) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id }] } });
const tick = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

it('keeps stdin open for the main reply, then closes without waiting for the result that requires EOF', () => {
  const close = vi.fn();
  const turn = createAmpStreamTurn({ prompt: 'go', write: () => true, close });
  turn.note(user('go'));
  turn.note({ ...assistant([], 'end_turn'), parent_tool_use_id: 'child' });
  expect(close).not.toHaveBeenCalled();
  turn.note(assistant([{ type: 'text', text: 'done' }]));
  expect(close).toHaveBeenCalledOnce();
  turn.ended();
  expect(close).toHaveBeenCalledOnce();
});

it('holds a steer through a tool call and acknowledges it only when Amp echoes the message', async () => {
  const write = vi.fn((_text: string) => true);
  const queued = vi.fn(async () => undefined);
  const landed = vi.fn();
  const turn = createAmpStreamTurn({ prompt: 'go', write, close: () => undefined });
  const broker = new LiveTurnInputBroker();
  broker.bindQueue(queued); broker.setLateSteerHandler(landed);
  broker.setSteerHandler((text, _submission, hold) => turn.steer(text, hold));
  turn.note(user('go'));
  turn.note(assistant([tool('call')], 'tool_use'));
  const outcome = await broker.submit('also this', 'one');
  expect(outcome.disposition).toBe('queued');
  expect(write).not.toHaveBeenCalled();
  turn.note(result('call')); await tick();
  expect(JSON.parse(write.mock.calls[0]![0] as string)).toMatchObject({ steer: true, message: { content: [{ type: 'text', text: 'also this' }] } });
  expect(landed).not.toHaveBeenCalled();
  turn.note(user('also this'));
  expect(await outcome.landed).toBe(true);
  expect(landed).toHaveBeenCalledOnce();
  turn.note(assistant([]));
});

it('does not send a held message after the user takes it back', async () => {
  const write = vi.fn(() => true);
  const turn = createAmpStreamTurn({ prompt: 'go', write, close: () => undefined });
  const broker = new LiveTurnInputBroker();
  broker.bindQueue(async () => undefined);
  broker.setSteerHandler((text, _submission, hold) => turn.steer(text, hold));
  turn.note(user('go')); turn.note(assistant([tool('call')], 'tool_use'));
  const outcome = await broker.submit('taken back', 'one');
  expect(broker.withdraw('one')).toBe(true);
  turn.note(result('call')); await tick();
  expect(await outcome.landed).toBe(false);
  expect(write).not.toHaveBeenCalled();
  turn.ended();
});

it('keeps identical submissions distinct while acknowledgements remove earlier entries', async () => {
  const write = vi.fn((_text: string) => true);
  const turn = createAmpStreamTurn({ prompt: 'same', write, close: () => undefined });
  turn.note(user('same'));
  const first = turn.steer('same');
  await tick();
  let ready!: () => void;
  const second = turn.steer('same', () => new Promise<void>((resolve) => { ready = resolve; }));
  const third = turn.steer('third', () => Promise.resolve());
  turn.note(user('same'));
  await first;
  ready(); await tick();
  expect(write).toHaveBeenCalledTimes(3);
  turn.note(user('same')); turn.note(user('third'));
  await expect(Promise.all([second, third])).resolves.toEqual([undefined, undefined]);
  turn.note(assistant([]));
});

it('waits for background agents and their follow-up, and rejects an unacknowledged steer on exit', async () => {
  const close = vi.fn();
  const turn = createAmpStreamTurn({ prompt: 'go', write: () => true, close });
  turn.note(user('go'));
  turn.note(assistant([tool('child', 'Task', { mode: 'async' })], 'tool_use'));
  turn.note(result('child')); turn.note(assistant([]));
  expect(close).not.toHaveBeenCalled();
  turn.note({ type: 'system', subtype: 'subagent_finished', tool_use_id: 'child', status: 'completed' });
  expect(close).not.toHaveBeenCalled();
  turn.note({ ...user('child result'), subagent_tool_use_id: 'child' });
  turn.note(assistant([]));
  expect(close).toHaveBeenCalledOnce();
  const running = createAmpStreamTurn({ prompt: 'go', write: () => true, close: () => undefined });
  const pending = running.steer('not echoed');
  await tick(); running.ended();
  await expect(pending).rejects.toThrow('before accepting');
});

it('waits for each completed agent follow-up, ignoring duplicate or unrelated completion frames', () => {
  const close = vi.fn();
  const turn = createAmpStreamTurn({ prompt: 'go', write: () => true, close });
  turn.note(user('go'));
  turn.note(assistant([tool('a', 'Task', { mode: 'async' }), tool('b', 'Task', { mode: 'async' })], 'tool_use'));
  turn.note(result('a')); turn.note(result('b')); turn.note(assistant([]));
  for (const id of ['a', 'b']) turn.note({ type: 'system', subtype: 'subagent_finished', tool_use_id: id, status: 'completed' });
  turn.note({ ...user('first child'), subagent_tool_use_id: 'a' });
  turn.note(assistant([]));
  expect(close).not.toHaveBeenCalled();
  turn.note({ type: 'system', subtype: 'subagent_finished', tool_use_id: 'a', status: 'completed' });
  turn.note({ type: 'system', subtype: 'subagent_finished', tool_use_id: 'unrelated', status: 'completed' });
  turn.note({ ...user('second child'), subagent_tool_use_id: 'b' });
  turn.note(assistant([]));
  expect(close).toHaveBeenCalledOnce();
});

it('does not let a child result close the parent, and returns a failed stdin write to the queue', async () => {
  const close = vi.fn();
  const turn = createAmpStreamTurn({ prompt: 'go', write: () => { throw new Error('pipe closed'); }, close });
  turn.note(user('go'));
  turn.note({ type: 'result', parent_tool_use_id: 'child', result: 'child done' });
  expect(close).not.toHaveBeenCalled();
  const broker = new LiveTurnInputBroker();
  const queued = vi.fn(async () => undefined);
  broker.bindQueue(queued);
  broker.setSteerHandler((text, _submission, hold) => turn.steer(text, hold));
  expect((await broker.submit('keep this message', 'retained')).disposition).toBe('queued');
  expect(queued).toHaveBeenCalledWith(expect.objectContaining({ id: 'retained', text: 'keep this message' }));
  expect(close).toHaveBeenCalledOnce();
});
