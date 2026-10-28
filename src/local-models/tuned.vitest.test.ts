import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GGMLQuantizationType, type GGUFParseOutput } from '@huggingface/gguf';
import { allLocalModels, catalogModel, resolveLocalModelId } from './catalog.js';
import { sha256File } from './download.js';
import { missingBytes, modelFilePath } from './models.js';
import { tunedModelsFile } from './paths.js';
import { forgetTunedModel, listTunedModels, registerTunedModel, tunedModelId } from './tuned.js';

const header = {
  metadata: {
    'general.architecture': 'qwen35', 'qwen35.block_count': 8, 'qwen35.context_length': 262_144, 'qwen35.attention.head_count_kv': 2,
    'qwen35.attention.key_length': 128, 'qwen35.attention.value_length': 128, 'qwen35.full_attention_interval': 4, 'qwen35.ssm.inner_size': 256,
    'qwen35.ssm.state_size': 128, 'qwen35.ssm.group_count': 2, 'tokenizer.chat_template': '{% if tools %}tool_call{% endif %}',
  },
  tensorInfos: [
    { name: 'output.weight', shape: [1000n], dtype: GGMLQuantizationType.Q8_0 },
    { name: 'blk.0.attn_norm.weight', shape: [64n], dtype: GGMLQuantizationType.F32 },
  ],
} as GGUFParseOutput;

let home: string;
let source: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'tuned-'));
  vi.stubEnv('CLIKCODE_LOCAL_MODELS_HOME', home);
  source = join(home, 'made.gguf');
  await writeFile(source, 'GGUF-bytes-of-a-fine-tune');
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); });

const register = (name = 'support-bot', over: Parameters<typeof registerTunedModel>[1] = { readHeader: async () => header }) => registerTunedModel({ name, ggufPath: source }, over);

describe('registering a model fine-tuned on this computer', () => {
  it('pins it by what it is, reads its memory shape from its own header, and is found like any other model', async () => {
    const model = await register();
    const sha = await sha256File(source);
    expect(model).toMatchObject({ id: 'tuned:support-bot', label: 'support-bot (tuned)', architecture: 'qwen35', quality: 30, maxContext: 262_144 });
    expect(model.weights).toEqual({ repo: 'clikcode-tuned/support-bot', revision: sha.slice(0, 40), file: 'support-bot.gguf', sizeBytes: 'GGUF-bytes-of-a-fine-tune'.length, sha256: sha });
    expect(model.discovered).toBeUndefined();
    expect(model.kv.layers).toBe(2);
    expect(catalogModel('tuned:support-bot')).toEqual(model);
    expect(allLocalModels().some((item) => item.id === 'tuned:support-bot')).toBe(true);
    expect(resolveLocalModelId('tuned:support-bot')).toBe('tuned:support-bot');
    expect(resolveLocalModelId('Support-Bot (tuned)')).toBe('tuned:support-bot');
  });

  it('puts the file where the store looks, so it is found already downloaded and never fetched', async () => {
    const model = await register();
    expect(await readFile(modelFilePath(model.weights), 'utf8')).toBe('GGUF-bytes-of-a-fine-tune');
    expect(await missingBytes([model.weights])).toBe(0);
  });

  it('replaces a model of the same name, keeps others, and can forget one', async () => {
    await register('one');
    await writeFile(source, 'a second, different fine-tune');
    await register('two');
    await writeFile(source, 'a third');
    const again = await register('one');
    expect((await listTunedModels()).map((item) => item.id).sort()).toEqual(['tuned:one', 'tuned:two']);
    expect((await listTunedModels()).find((item) => item.id === 'tuned:one')!.weights.sha256).toBe(again.weights.sha256);
    expect(await forgetTunedModel('one')).toBe(true);
    expect(await forgetTunedModel('one')).toBe(false);
    expect(allLocalModels().some((item) => item.id === tunedModelId('one'))).toBe(false);
    expect(allLocalModels().some((item) => item.id === tunedModelId('two'))).toBe(true);
  });

  it('refuses a name that is not one, a missing file, and a GGUF it cannot fit safely, saying why', async () => {
    await expect(registerTunedModel({ name: 'Bad Name!', ggufPath: source })).rejects.toThrow(/not a model name/);
    await expect(registerTunedModel({ name: 'ok', ggufPath: join(home, 'missing.gguf') })).rejects.toThrow(/No GGUF/);
    const unknown = { ...header, metadata: { ...header.metadata, 'general.architecture': 'qwen2' } } as GGUFParseOutput;
    await expect(register('ok', { readHeader: async () => unknown })).rejects.toThrow(/cannot be fitted.*architecture, chat template.*or license/);
    expect(await listTunedModels()).toEqual([]);
  });

  it('ignores a record that is not a tuned model of this store: a hand-edited or damaged entry is never run', async () => {
    const model = await register();
    const bad = [
      { ...model, id: 'tuned:bad-sha', weights: { ...model.weights, sha256: 'xyz' } },
      { ...model, id: 'not-tuned', weights: model.weights },
      { ...model, id: 'tuned:other-repo', weights: { ...model.weights, repo: 'unsloth/Qwen3.5-4B-GGUF' } },
      { ...model, id: 'tuned:empty', weights: { ...model.weights, sizeBytes: 0 } },
    ];
    await writeFile(tunedModelsFile(), JSON.stringify({ models: [model, ...bad] }));
    expect(allLocalModels().filter((item) => item.id.startsWith('tuned:') || item.id === 'not-tuned').map((item) => item.id)).toEqual(['tuned:support-bot']);
  });

  it('leaves no half-written record behind', async () => {
    await register();
    expect((await stat(tunedModelsFile())).isFile()).toBe(true);
    expect(JSON.parse(await readFile(tunedModelsFile(), 'utf8')).models).toHaveLength(1);
  });
});
