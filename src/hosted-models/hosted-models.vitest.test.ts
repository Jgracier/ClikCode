import { describe, expect, it } from 'vitest';
import { hostedAdapter, hostedList, hostedSelectionCommand, parseHostedQuery, type HostedAdapter, type HostedRow } from './index.js';

const row = (target: HostedRow['target'], id: string, extra: Partial<HostedRow> = {}): HostedRow => ({ target, id, label: id, detail: '', ...extra });
const adapter = (target: HostedAdapter['target'], rows: HostedRow[] | Error): HostedAdapter => ({
  target,
  list: async (query) => { if (rows instanceof Error) throw rows; return rows.filter((item) => item.label.includes(query)); },
  plan: async (item) => ({ title: item.label, lines: [], confirm: 'go', costly: target === 'clikdeploy' }),
  start: async (item) => ({ route: target === 'clikdeploy' ? 'gateway' : 'clikcode-local', model: item.id }),
});

describe('the Hosted AI list', () => {
  it('puts what fits this computer first, recommended before the rest, then the ClikDeploy GPUs, each in its own order', async () => {
    const { rows } = await hostedList('', [
      adapter('clikdeploy', [row('clikdeploy', 'big-a'), row('clikdeploy', 'big-b')]),
      adapter('this-computer', [row('this-computer', 'slow'), row('this-computer', 'best', { recommended: true })]),
    ]);
    expect(rows.map((item) => item.id)).toEqual(['best', 'slow', 'big-a', 'big-b']);
  });

  it('searches both by name, and by where it runs: "local" or "cloud" choose the target', async () => {
    const adapters = [adapter('this-computer', [row('this-computer', 'qwen-small')]), adapter('clikdeploy', [row('clikdeploy', 'qwen-huge'), row('clikdeploy', 'llama')])];
    expect((await hostedList('qwen', adapters)).rows.map((item) => item.id)).toEqual(['qwen-small', 'qwen-huge']);
    expect((await hostedList('local qwen', adapters)).rows.map((item) => item.id)).toEqual(['qwen-small']);
    expect((await hostedList('GPU', adapters)).rows.map((item) => item.id)).toEqual(['qwen-huge', 'llama']);
    expect(parseHostedQuery('cloud llama')).toEqual({ targets: new Set(['clikdeploy']), text: 'llama' });
  });

  it('still lists this computer when ClikDeploy cannot be reached, and says so', async () => {
    const out = await hostedList('', [adapter('this-computer', [row('this-computer', 'local-one')]), adapter('clikdeploy', new Error('offline'))]);
    expect(out.rows.map((item) => item.id)).toEqual(['local-one']);
    expect(out.unavailable).toEqual([{ target: 'clikdeploy', message: 'offline' }]);
  });

  it('finds an adapter by target', () => {
    expect(hostedAdapter('clikdeploy').target).toBe('clikdeploy');
    expect(() => hostedAdapter('nowhere' as never)).toThrow('unknown hosted target');
  });
});

describe('selecting a started model', () => {
  it('is a /model command for its route', () => {
    expect(hostedSelectionCommand({ route: 'clikcode-local', model: 'qwen', download: true })).toBe('/model --download qwen');
    expect(hostedSelectionCommand({ route: 'gateway', model: 'private-deployment:d1', any: true })).toBe('/model --any private-deployment:d1');
    expect(hostedSelectionCommand({ route: 'clikcode-local', model: 'qwen' })).toBe('/model qwen');
  });
});
