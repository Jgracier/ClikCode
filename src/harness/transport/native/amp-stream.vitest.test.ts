import { expect, it, vi } from 'vitest';
import { createAmpStreamTurn, ampUserMessage } from './amp-stream.js';
import { LiveTurnInputBroker, type SteerPort } from '../../../turn/live-input.js';
import { fakeLedger } from '../../../turn/test-support/live-ledger.js';

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

it('waits out a tool call, then takes a steer and acknowledges it only when Amp echoes the message', async () => {
  const write = vi.fn((_text: string) => true);
  const turn = createAmpStreamTurn({ prompt: 'go', write, close: () => undefined });
  const { ledger, queue, steered } = fakeLedger();
  const broker = new LiveTurnInputBroker();
  broker.bindLedger(ledger);
  const port: SteerPort = { offer: (text) => turn.steer(text) };
  turn.onWindow = () => port.onWindow?.();
  broker.setSteerPort(port);
  turn.note(user('go'));
  turn.note(assistant([tool('call')], 'tool_use'));
  const outcome = await broker.submit('also this', 'one', { steer: true });
  expect(outcome.disposition).toBe('queued');
  expect(queue.map((item) => item.id)).toEqual(['one']);
  expect(write).not.toHaveBeenCalled();
  turn.note(result('call')); await tick();
  expect(JSON.parse(write.mock.calls[0]![0] as string)).toMatchObject({ steer: true, message: { content: [{ type: 'text', text: 'also this' }] } });
  // Written, not yet acknowledged: still waiting.
  expect(steered).toEqual([]);
  turn.note(user('also this')); await tick(); await broker.settled();
  expect(steered.map((item) => item.id)).toEqual(['one']);
  expect(queue).toEqual([]);
  turn.note(assistant([]));
});

it('does not send a waiting message after the user takes it back', async () => {
  const write = vi.fn(() => true);
  const turn = createAmpStreamTurn({ prompt: 'go', write, close: () => undefined });
  const { ledger } = fakeLedger();
  const broker = new LiveTurnInputBroker();
  broker.bindLedger(ledger);
  const port: SteerPort = { offer: (text) => turn.steer(text) };
  turn.onWindow = () => port.onWindow?.();
  broker.setSteerPort(port);
  turn.note(user('go')); turn.note(assistant([tool('call')], 'tool_use'));
  await broker.submit('taken back', 'one', { steer: true });
  expect(await broker.takeBack('one')).toBe('removed');
  turn.note(result('call')); await tick(); await broker.settled();
  expect(write).not.toHaveBeenCalled();
  turn.ended();
});

it('says no, and writes nothing, while a tool is running', async () => {
  const write = vi.fn(() => true);
  const turn = createAmpStreamTurn({ prompt: 'go', write, close: () => undefined });
  turn.note(user('go')); turn.note(assistant([tool('call')], 'tool_use'));
  expect(await turn.steer('not now')).toBe(false);
  expect(write).not.toHaveBeenCalled();
});

it('keeps identical messages distinct: each echo acknowledges one', async () => {
  const write = vi.fn((_text: string) => true);
  const turn = createAmpStreamTurn({ prompt: 'same', write, close: () => undefined });
  turn.note(user('same'));
  const first = turn.steer('same');
  const second = turn.steer('same');
  await tick();
  expect(write).toHaveBeenCalledTimes(2);
  turn.note(user('same'));
  await expect(first).resolves.toBe(true);
  turn.note(user('same'));
  await expect(second).resolves.toBe(true);
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

it('does not let a child result close the parent, and leaves a message whose write failed in the queue', async () => {
  const close = vi.fn();
  const turn = createAmpStreamTurn({ prompt: 'go', write: () => { throw new Error('pipe closed'); }, close });
  turn.note(user('go'));
  turn.note({ type: 'result', parent_tool_use_id: 'child', result: 'child done' });
  expect(close).not.toHaveBeenCalled();
  const { ledger, queue } = fakeLedger();
  const broker = new LiveTurnInputBroker();
  broker.bindLedger(ledger);
  broker.setSteerPort({ offer: (text) => turn.steer(text) });
  expect((await broker.submit('keep this message', 'retained', { steer: true })).disposition).toBe('queued');
  expect(queue).toEqual([expect.objectContaining({ id: 'retained', text: 'keep this message' })]);
  expect(close).toHaveBeenCalledOnce();
});
