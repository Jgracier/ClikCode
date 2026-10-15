import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createPiRpcTurn, piRpcPrompt, piRpcSteer } from './pi-rpc.js';

describe('pi --mode rpc turn', () => {
  it('takes a steer when pi answers its id with success, and closes stdin only once settled', async () => {
    const close = vi.fn();
    const turn = createPiRpcTurn({ close });
    const taken = turn.await('s1');
    turn.note({ type: 'response', command: 'steer', id: 's1', success: true });
    await expect(taken).resolves.toBeUndefined();
    turn.note({ type: 'agent_end' });
    expect(close).not.toHaveBeenCalled();
    turn.note({ type: 'agent_settled' });
    expect(close).toHaveBeenCalledOnce();
    await expect(turn.await('s2')).rejects.toThrow('finishing');
  });

  it('rejects a refused steer, and one still waiting when the turn settles or pi exits (the message is then queued)', async () => {
    const turn = createPiRpcTurn({ close: () => undefined });
    const refused = turn.await('a');
    turn.note({ type: 'response', command: 'steer', id: 'a', success: false, error: 'not streaming' });
    await expect(refused).rejects.toThrow('not streaming');
    const gone = turn.await('b');
    turn.ended();
    await expect(gone).rejects.toThrow('pi exited');
  });

  it('closes after agent_end when this pi never says agent_settled, unless the agent starts again', () => {
    vi.useFakeTimers();
    try {
      const close = vi.fn();
      const turn = createPiRpcTurn({ close, fallbackMs: 1000 });
      turn.note({ type: 'agent_end' });
      turn.note({ type: 'agent_start' }); // a retry or queued continuation
      vi.advanceTimersByTime(2000);
      expect(close).not.toHaveBeenCalled();
      turn.note({ type: 'agent_end' });
      vi.advanceTimersByTime(1000);
      expect(close).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it('writes the commands pi documents, images inline', async () => {
    expect(JSON.parse(piRpcSteer('x', 'hi'))).toEqual({ id: 'x', type: 'steer', message: 'hi' });
    const dir = mkdtempSync(join(tmpdir(), 'pi-rpc-'));
    const png = join(dir, 'a.png');
    writeFileSync(png, 'png');
    const sent = JSON.parse(await piRpcPrompt('look', [png, join(dir, 'notes.txt')]));
    expect(sent).toMatchObject({ type: 'prompt', message: 'look', images: [{ type: 'image', mimeType: 'image/png', data: Buffer.from('png').toString('base64') }] });
  });
});
