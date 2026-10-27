import { describe, expect, it, vi } from 'vitest';
import { thisComputer } from './this-computer.js';
import { hostedAdapter, hostedList, hostedPlan, hostedSelectionCommand, parseHostedQuery, type HostedAdapter, type HostedPlan, type HostedRow } from './index.js';

// The engine is mocked: what is under test is what the list and the question say, not this machine's ranking.
const choices = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }));
vi.mock('../local-models/index.js', () => ({ localModelChoices: async () => choices.rows }));

const row = (target: HostedRow['target'], id: string, extra: Partial<HostedRow> = {}): HostedRow => ({ target, id, label: id, detail: '', ...extra });
const adapter = (target: HostedAdapter['target'], rows: HostedRow[] | Error, plan?: (item: HostedRow) => Promise<HostedPlan>): HostedAdapter => ({
  target,
  list: async (query) => { if (rows instanceof Error) throw rows; return rows.filter((item) => item.label.includes(query)); },
  plan: plan ?? (async (item) => ({ title: item.label, lines: [], confirm: 'go', costly: target === 'clikdeploy', summary: `${target}:${item.id}` })),
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

describe('a model for this computer, as the list and the question say it', () => {
  it('lists each model with the short line (what it takes, how fast it writes), not the long one', async () => {
    choices.rows = [{
      id: 'gemma', label: 'Gemma 4 12B', fits: true, recommended: false, downloadBytes: 0,
      brief: 'downloaded · ~8 tok/s · tool use unverified',
      detail: 'VULKAN · first reply ~53–131s after loading · short-context estimate; deep GPU speed unverified: 116 tok/s reading, 8 writing · 32K context · Hugging Face unsloth/gemma-4-12b-it-GGUF · tool use unverified · downloaded',
    }];
    const [only] = await thisComputer.list('');
    expect(only).toMatchObject({ target: 'this-computer', id: 'gemma', detail: 'downloaded · ~8 tok/s · tool use unverified' });
    expect(only!.detail).not.toMatch(/VULKAN|first reply|context|Hugging Face/);
  });

  it('asks nothing for a model that is already on this computer: choosing it is the decision', async () => {
    const plan = await thisComputer.plan({ target: 'this-computer', id: 'gemma', label: 'Gemma 4 12B', detail: '', downloadBytes: 0 });
    expect(plan).toMatchObject({ consent: false, costly: false, lines: [], summary: 'downloaded · free, works offline' });
  });

  it('asks once for a download, with the size in the question and one line under it', async () => {
    const plan = await thisComputer.plan({ target: 'this-computer', id: 'gemma', label: 'Gemma 4 12B', detail: '', downloadBytes: 6_700_000_000 });
    expect(plan).toMatchObject({ consent: true, costly: false, confirm: 'Download', summary: '6.7 GB download · free after, works offline' });
    expect(plan.title).toBe('Download Gemma 4 12B (6.7 GB)?');
    expect(plan.lines).toHaveLength(1);
    expect(plan.lines[0]).toMatch(/free and offline/);
  });
});


describe('one row per model, and the plan that carries the other place to run it', () => {
  const fits = row('this-computer', 'qwen', { label: 'Qwen3.5 4B', repo: 'unsloth/Qwen3.5-4B-GGUF' });

  it('lists a model that fits this computer once, though ClikDeploy\'s search lists the same repo too', async () => {
    const { rows } = await hostedList('', [
      adapter('this-computer', [fits]),
      adapter('clikdeploy', [row('clikdeploy', 'unsloth/Qwen3.5-4B-GGUF'), row('clikdeploy', 'Qwen/Qwen3.5-4B')]),
    ]);
    expect(rows.map((item) => item.id)).toEqual(['qwen', 'Qwen/Qwen3.5-4B']);
  });

  it('prices a model that fits this computer on ClikDeploy from the repo its weights come from, and offers it beside running here', async () => {
    const priced: string[] = [];
    const cloud = adapter('clikdeploy', [], async (item) => { priced.push(item.id); return { title: item.label, lines: [], confirm: 'go', costly: true, summary: '$0.068/hour' }; });
    const plan = await hostedPlan(fits, [adapter('this-computer', []), cloud]);
    expect(priced).toEqual(['unsloth/Qwen3.5-4B-GGUF']);
    expect(plan.summary).toBe('this-computer:qwen');
    expect(plan.alternative).toMatchObject({ row: { target: 'clikdeploy', id: 'unsloth/Qwen3.5-4B-GGUF', label: 'Qwen3.5 4B' }, plan: { summary: '$0.068/hour', costly: true } });
  });

  it('runs it here with no alternative when ClikDeploy cannot price it -- signed out, offline, gated -- rather than failing', async () => {
    const cloud = adapter('clikdeploy', [], async () => { throw new Error('ClikDeploy Gateway is not connected'); });
    const plan = await hostedPlan(fits, [adapter('this-computer', []), cloud]);
    expect(plan.alternative).toBeUndefined();
    expect(plan.summary).toBe('this-computer:qwen');
  });

  it('gives up on a price that does not come in time, and says nothing of it', async () => {
    vi.useFakeTimers();
    try {
      const cloud = adapter('clikdeploy', [], (_item) => new Promise<HostedPlan>(() => undefined));
      let signal: AbortSignal | undefined;
      const watching: HostedAdapter = { ...cloud, plan: (item, aborted) => { signal = aborted; return cloud.plan(item); } };
      const pending = hostedPlan(fits, [adapter('this-computer', []), watching]);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1_500);
      expect(signal?.aborted).toBe(true);
      void pending;
    } finally { vi.useRealTimers(); }
  });

  it('has only its own plan for a model that needs a GPU, or one with no repo to price', async () => {
    const asked: string[] = [];
    const cloud = adapter('clikdeploy', [], async (item) => { asked.push(item.id); return { title: item.label, lines: [], confirm: 'go', costly: true, summary: '$1/hour' }; });
    const gpu = row('clikdeploy', 'owner/huge');
    expect((await hostedPlan(gpu, [adapter('this-computer', []), cloud])).alternative).toBeUndefined();
    expect((await hostedPlan(row('this-computer', 'no-repo'), [adapter('this-computer', []), cloud])).alternative).toBeUndefined();
    // Once for the model that needs the GPU, and not at all for the one with nothing to price.
    expect(asked).toEqual(['owner/huge']);
  });
});
