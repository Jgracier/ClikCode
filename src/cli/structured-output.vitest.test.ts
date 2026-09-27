import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindGlobalFlags } from './flags.js';
import { emitResult } from './structured-output.js';

describe('a command result', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    bindGlobalFlags({});
  });

  it('is one compact JSON record per line in JSON mode', () => {
    bindGlobalFlags({ json: true });
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    emitResult({ ok: true, items: [1, 2] });
    emitResult({ second: 'record' });
    expect(write.mock.calls.map(([text]) => text)).toEqual(['{"ok":true,"items":[1,2]}\n', '{"second":"record"}\n']);
  });

  it('is the same fields, readably, in human mode', () => {
    bindGlobalFlags({ human: true });
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    emitResult({ accounts: [{ label: 'work', status: 'ready' }] });
    expect(write).toHaveBeenCalledWith('accounts:\n  - label: work\n    status: ready\n');
  });
});
