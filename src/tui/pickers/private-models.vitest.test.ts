import { beforeEach, expect, it, vi } from 'vitest';
import { interactiveHostedPicker } from './model.js';
import { aiSessionCommand } from '../slash/handlers.js';

vi.mock('../../session/state/read.js', () => ({ readState: async () => ({ sessions: [{ id: 'gw', route: 'gateway' }] }) }));
vi.mock('../slash/handlers.js', () => ({ aiSessionCommand: vi.fn() }));
// What ClikDeploy answers, and whether the user said to always start a GPU, are the test's to set.
const cloud = vi.hoisted(() => ({ refuse: false, always: true, quoted: [] as string[], setAlways: undefined as unknown }));
vi.mock('../../gateway/own-models.js', () => ({ alwaysStartOwnModels: () => cloud.always, setAlwaysStartOwnModels: () => undefined }));
const local = vi.hoisted(() => ({ choices: [] as Array<{ id: string; label: string; repo?: string; detail: string; brief?: string; fits: boolean; recommended: boolean; downloadBytes: number }> }));
vi.mock('../../local-models/index.js', () => ({ localModelChoices: async () => local.choices }));
const route = vi.hoisted(() => ({ selectProviderConversation: vi.fn(async () => 'moved') }));
vi.mock('./conversation.js', () => ({ selectProviderConversation: route.selectProviderConversation }));
vi.mock('../../gateway/private-models.js', () => ({
  searchDeployableModels: async () => [{ sourceId: 'huggingface', modelId: 'owner/model', displayName: 'model', gated: false }],
  quotePrivateModel: async (modelId: string) => {
    cloud.quoted.push(modelId);
    if (cloud.refuse) throw new Error('ClikDeploy Gateway is not connected; run `clikcode gateway login` first');
    return { sku: { displayName: '1 GPU · 17 GB' }, pricePerHour: 0.068, throughput: { decodeTokensPerSec: 52 } };
  },
  quoteSummary: () => ({ title: 'model on ClikDeploy', body: 'GPU: GPU' }),
  deployPrivateModel: async () => ({ id: 'dep-1', modelId: 'owner/model', status: 'LOADING', gatewayModelId: 'private-deployment:dep-1' }),
}));

beforeEach(() => { cloud.refuse = false; cloud.always = true; cloud.quoted.length = 0; local.choices = []; vi.mocked(aiSessionCommand).mockClear(); route.selectProviderConversation.mockClear(); });

it('selects the newly created private deployment without a model-list publication race', async () => {
  const select = vi.fn(async (_title, rows) => rows[0].value);
  await interactiveHostedPicker({ select } as never, 'gw');
  expect(aiSessionCommand).toHaveBeenCalledWith('gw', '/model --any private-deployment:dep-1');
});

it('asks once for a download of a model for this computer -- the size in the question, no panel of numbers -- and no price', async () => {
  local.choices = [{ id: 'qwen', label: 'Qwen', detail: 'GPU · first reply 3s · 30 tok/s reading · 32K context', brief: '12.0 GB download · ~30 tok/s', fits: true, recommended: true, downloadBytes: 12e9 }];
  const asked: string[] = [];
  const panels: string[] = [];
  const select = vi.fn(async (title: string, rows: Array<{ value: unknown }>) => { asked.push(title); return rows[0]!.value; });
  await interactiveHostedPicker({ select, panel: (title: string) => { panels.push(title); } } as never, 'gw');
  expect(asked).toEqual(['Hosted AI', 'Download Qwen (12.0 GB)?']);
  expect(panels).toEqual([]);
  // The chat is not moved first: the command moves it once the model is on this machine, and until then it is as it was, so a download
  // that takes minutes (or fails) never leaves it on a route with no model.
  expect(route.selectProviderConversation).not.toHaveBeenCalled();
  expect(aiSessionCommand).toHaveBeenCalledWith('gw', '/model --download qwen');
});

it('asks nothing for a model that is already on this computer: choosing it is the decision', async () => {
  local.choices = [{ id: 'gemma', label: 'Gemma 4 12B', detail: 'long', brief: 'downloaded · ~8 tok/s', fits: true, recommended: false, downloadBytes: 0 }];
  const listed: Array<{ label: string; detail?: string; group?: string }> = [];
  const asked: string[] = [];
  const select = vi.fn(async (title: string, rows: Array<{ value: unknown; label: string; detail?: string; group?: string }>) => {
    asked.push(title);
    if (!listed.length) listed.push(...rows);
    return rows[0]!.value;
  });
  await interactiveHostedPicker({ select, panel: () => undefined } as never, 'gw');
  expect(asked).toEqual(['Hosted AI']);
  // The row says what it takes and how fast it writes; where it runs is the group it is under.
  expect(listed[0]).toMatchObject({ label: 'Gemma 4 12B', group: 'Fits this computer' });
  expect(listed[0]!.detail).toBe('· downloaded · ~8 tok/s');
  expect(aiSessionCommand).toHaveBeenLastCalledWith('gw', '/model --download gemma');
});


// ---- Where to run it: here or on ClikDeploy when both are possible, only the estimate when it needs a GPU.

const FITS = { id: 'qwen', label: 'Qwen3.5 4B', repo: 'unsloth/Qwen3.5-4B-GGUF', detail: 'long', fits: true, recommended: true };
type Row = { value: unknown; label: string; detail?: string; group?: string };

/** A picker that answers the list with its first row and each later question with `answers[title]` (or its first option). */
function asking(answers: Record<string, (rows: Row[]) => unknown> = {}) {
  const asked: Array<{ title: string; rows: Row[] }> = [];
  const select = vi.fn(async (title: string, rows: Row[]) => {
    asked.push({ title, rows });
    return (answers[title] ?? ((options: Row[]) => options[0]!.value))(rows);
  });
  return { asked, picker: { select, panel: () => undefined } as never };
}

it('asks where to run a model that fits this computer and that ClikDeploy can price: here, or there, each with what it takes', async () => {
  local.choices = [{ ...FITS, brief: '6.7 GB download · ~10 tok/s', downloadBytes: 6.7e9 }];
  const { asked, picker } = asking();
  await interactiveHostedPicker(picker, 'gw');
  expect(asked.map((entry) => entry.title)).toEqual(['Hosted AI', 'Qwen3.5 4B']);
  expect(asked[1]!.rows.map((row) => [row.label, row.detail])).toEqual([
    ['Run on this computer', '· 6.7 GB download · free after, works offline'],
    ['Run on ClikDeploy', '· $0.068/hour · 1 GPU · 17 GB · ~52 tok/s'],
  ]);
  // The estimate is for the repo the local weights come from.
  expect(cloud.quoted).toEqual(['unsloth/Qwen3.5-4B-GGUF']);
  // Enter takes the first: here. Choosing is the consent, so there is no second question about the download.
  expect(aiSessionCommand).toHaveBeenCalledWith('gw', '/model --download qwen');
});

it('puts a model on ClikDeploy when that is the option chosen, at the price shown, with no second question', async () => {
  local.choices = [{ ...FITS, brief: 'downloaded · ~10 tok/s', downloadBytes: 0 }];
  cloud.always = false;
  const { asked, picker } = asking({ 'Qwen3.5 4B': (rows) => rows[1]!.value });
  await interactiveHostedPicker(picker, 'gw');
  // Even a model already on this computer has the choice, since ClikDeploy can run it too.
  expect(asked.map((entry) => entry.title)).toEqual(['Hosted AI', 'Qwen3.5 4B']);
  expect(aiSessionCommand).toHaveBeenCalledWith('gw', '/model --any private-deployment:dep-1');
});

it('shows only the ClikDeploy estimate for a model that needs a GPU, and asks once', async () => {
  cloud.always = false;
  const { asked, picker } = asking();
  await interactiveHostedPicker(picker, 'gw');
  expect(asked.map((entry) => entry.title)).toEqual(['Hosted AI', 'Start owner/model on ClikDeploy?']);
  expect(asked[1]!.rows.map((row) => [row.label, row.detail])).toEqual([
    ['Start', '· $0.068/hour · 1 GPU · 17 GB · ~52 tok/s'],
    ['Always start hosted AI models', '· remember this on this machine'],
  ]);
  expect(aiSessionCommand).toHaveBeenCalledWith('gw', '/model --any private-deployment:dep-1');
});

it('runs a model that fits this computer here, with no choice, when ClikDeploy cannot price it (signed out, offline, gated)', async () => {
  local.choices = [{ ...FITS, brief: '6.7 GB download · ~10 tok/s', downloadBytes: 6.7e9 }];
  cloud.refuse = true;
  const { asked, picker } = asking();
  await interactiveHostedPicker(picker, 'gw');
  // What there is to decide is the download, so that is what is asked -- not a choice between two places.
  expect(asked.map((entry) => entry.title)).toEqual(['Hosted AI', 'Download Qwen3.5 4B (6.7 GB)?']);
  expect(aiSessionCommand).toHaveBeenCalledWith('gw', '/model --download qwen');
});

it('goes back to the list when the question is left with Esc, and starts nothing', async () => {
  local.choices = [{ ...FITS, brief: 'downloaded · ~10 tok/s', downloadBytes: 0 }];
  const asked: string[] = [];
  let lists = 0;
  // The first list answer picks the row; the list shown again, and the question, are left.
  const select = vi.fn(async (title: string, rows: Row[]) => {
    asked.push(title);
    return title === 'Hosted AI' && lists++ === 0 ? rows[0]!.value : undefined;
  });
  await interactiveHostedPicker({ select, panel: () => undefined } as never, 'gw');
  expect(asked).toEqual(['Hosted AI', 'Qwen3.5 4B', 'Hosted AI']);
  expect(aiSessionCommand).not.toHaveBeenCalled();
});
