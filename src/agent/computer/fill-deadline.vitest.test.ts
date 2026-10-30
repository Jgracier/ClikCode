import { describe, expect, it } from 'vitest';
import { FillTimeout, withFillDeadline } from './fill-deadline.js';

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

describe('withFillDeadline', () => {
  it('returns the work when it finishes in time', async () => {
    expect(await withFillDeadline('Email', async () => 'ok', 200)).toBe('ok');
  });

  it('gives up with the label of the field it was on', async () => {
    const run = withFillDeadline('first', async clock => { clock.field = 'Contraseña'; await sleep(400); return 'late'; }, 50);
    await expect(run).rejects.toBeInstanceOf(FillTimeout);
    await expect(withFillDeadline('Contraseña', () => sleep(400), 50)).rejects.toThrow('fill did not finish: Contraseña');
  });

  it('does not count the wait for the person against the deadline', async () => {
    const result = await withFillDeadline('Email', async clock => { await clock.paused(() => sleep(150)); return 'answered'; }, 60);
    expect(result).toBe('answered');
  });

  it('still times out on page work after the person answered', async () => {
    await expect(withFillDeadline('Phone', async clock => { await clock.paused(() => sleep(20)); await sleep(400); }, 60)).rejects.toThrow('fill did not finish: Phone');
  });

  it('passes the work\'s own error through', async () => {
    await expect(withFillDeadline('x', async () => { throw new Error('boom'); }, 100)).rejects.toThrow('boom');
  });
});
