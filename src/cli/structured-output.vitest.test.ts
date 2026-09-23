import { afterEach, describe, expect, it, vi } from 'vitest';
import { emitJson } from './structured-output.js';

describe('structured-output', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes json to stdout', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    emitJson({ ok: true });
    expect(write).toHaveBeenCalledWith(`${JSON.stringify({ ok: true }, null, 2)}\n`);
  });
});
