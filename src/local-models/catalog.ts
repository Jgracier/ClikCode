/** The built-in, quality-tested fallback models: open-licensed GGUF builds that make
 * tool calls reliably and run on mainline llama.cpp, one or more per size
 * tier (about 3, 6, 12-15 and 20-22 GB of weights), then higher-precision
 * builds of the two strongest (29-38 GB) for machines with room to spare.
 *
 * Why the large tier is more bits, not more parameters: as of September
 * 2026 no open-licensed model under ~100 GB beats Ornith 1.5 35B-A3B or
 * Qwen3.8 27B at agentic coding. The bigger MoEs that fit 40-100 GB score
 * lower on their own cards -- gpt-oss-120b (SWE-bench Verified 62.0,
 * Terminal-Bench 2 18.7) and Qwen3.5-122B-A10B (72.0, 49.4), per the
 * Qwen3.5-122B card, against Qwen3.6-35B-A3B's 73.4 / 51.5 -- so on any
 * machine that holds them, a Q6_K/Q8_0 of the 35B-A3B or the 27B is the
 * better use of the memory.
 *
 * Every file is pinned: the Hugging Face commit it is fetched from, its
 * size, and its SHA-256 as Hugging Face's LFS metadata records it
 * (`/api/models/<repo>/tree/<revision>`). Nothing here was typed from
 * memory; a download whose hash differs is refused, so a repo that is
 * force-pushed later cannot swap the weights under a user.
 *
 * Licenses were read from each repo's model card and match the base
 * model's: Apache-2.0 for Qwen, Gemma 4 and gpt-oss; MIT for Ornith.
 *
 * The attention geometry (`kv`) comes from each file's own GGUF header and
 * is what the KV-cache estimate is computed from. Qwen 3.5 and later are
 * hybrids: only every fourth layer keeps a KV cache, the rest carry a fixed
 * recurrent state, which is why their contexts are cheap. */

import { readFileSync } from 'node:fs';
import { discoveredModelsFile } from './paths.js';

export interface CatalogFile {
  repo: string;
  /** Hugging Face commit sha the file is fetched at. */
  revision: string;
  file: string;
  sizeBytes: number;
  sha256: string;
}

/** Attention layers' KV-cache shape, per token. Sliding-window layers keep
 * only `window` tokens, so they cost a fixed amount whatever the context. */
export interface KvGeometry {
  layers: number;
  kvHeads: number;
  keyLength: number;
  valueLength: number;
  sliding?: { layers: number; kvHeads: number; keyLength: number; valueLength: number; window: number };
  /** Recurrent (linear-attention) state per sequence, f32, for hybrids:
   * llama.cpp keeps one live copy plus a checkpoint every 8K tokens. */
  recurrentStateBytes?: number;
}

export interface CatalogModel {
  id: string;
  label: string;
  weights: CatalogFile;
  /** Vision projector; loaded only when a caller asks for images. */
  projector?: CatalogFile;
  architecture: string;
  totalParamsB: number;
  /** Parameters read per token: all of them for a dense model, the routed
   * experts' share for a mixture of experts. Speed follows this. */
  activeParamsB: number;
  quantization: string;
  defaultContext: number;
  maxContext: number;
  license: 'apache-2.0' | 'mit';
  kv: KvGeometry;
  /** Rough rank for agentic coding, 0-100, used only to order models that
   * all meet the speed bar. From published SWE-bench Verified /
   * Terminal-Bench results where the model card gives them, otherwise by
   * generation and size within a family. A higher-precision build of the
   * same model scores +2 (Q6_K) or +3 (Q8_0) over its Q4_K_M: cards
   * publish no per-quant agentic results, but Q4_K_M is the one of the
   * three that measurably drifts from the full-precision model, and a long
   * agent run compounds small drifts. The bump is kept below the gap to
   * the next model, so a quant never outranks a stronger model. */
  quality: number;
  qualityNote: string;
  /** Derived from a remote GGUF header, rather than the built-in quality set. */
  discovered?: boolean;
  /** Weight bytes actually read per generated token, from tensor metadata. */
  activeWeightBytes?: number;
}

/** Recurrent state of one Qwen 3.5-style linear-attention layer: a
 * heads x 128 x 128 f32 matrix plus a small convolution buffer. */
function qwen35Recurrent(linearLayers: number, heads: number): number {
  return linearLayers * (heads * 128 * 128 * 4 + 3 * (heads * 128 + 2 * 16 * 128) * 4);
}

export const LOCAL_MODEL_CATALOG: readonly CatalogModel[] = [
  {
    id: 'qwen3.5-4b',
    label: 'Qwen3.5 4B',
    weights: {
      repo: 'unsloth/Qwen3.5-4B-GGUF', revision: 'e87f176479d0855a907a41277aca2f8ee7a09523',
      file: 'Qwen3.5-4B-Q4_K_M.gguf', sizeBytes: 2_740_937_888,
      sha256: '00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4',
    },
    projector: {
      repo: 'unsloth/Qwen3.5-4B-GGUF', revision: 'e87f176479d0855a907a41277aca2f8ee7a09523',
      file: 'mmproj-F16.gguf', sizeBytes: 672_423_616,
      sha256: 'cd88edcf8d031894960bb0c9c5b9b7e1fea6ebee02b9f7ce925a00d12891f864',
    },
    architecture: 'qwen35', totalParamsB: 4.21, activeParamsB: 4.21, activeWeightBytes: 2_729_969_664, quantization: 'Q4_K_M',
    defaultContext: 65_536, maxContext: 262_144, license: 'apache-2.0',
    kv: { layers: 8, kvHeads: 4, keyLength: 256, valueLength: 256, recurrentStateBytes: qwen35Recurrent(24, 32) },
    quality: 40, qualityNote: 'smallest tier; for machines with little memory',
  },
  {
    id: 'qwen3.5-9b',
    label: 'Qwen3.5 9B',
    weights: {
      repo: 'unsloth/Qwen3.5-9B-GGUF', revision: '3885219b6810b007914f3a7950a8d1b469d598a5',
      file: 'Qwen3.5-9B-Q4_K_M.gguf', sizeBytes: 5_680_522_464,
      sha256: '03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8',
    },
    projector: {
      repo: 'unsloth/Qwen3.5-9B-GGUF', revision: '3885219b6810b007914f3a7950a8d1b469d598a5',
      file: 'mmproj-F16.gguf', sizeBytes: 918_166_080,
      sha256: 'f70dc3509053962b0d0d3ee8a7eacebf5d60aa560cad78254ae8698516ae029f',
    },
    architecture: 'qwen35', totalParamsB: 8.95, activeParamsB: 8.95, activeWeightBytes: 5_097_424_896, quantization: 'Q4_K_M',
    defaultContext: 65_536, maxContext: 262_144, license: 'apache-2.0',
    kv: { layers: 8, kvHeads: 4, keyLength: 256, valueLength: 256, recurrentStateBytes: qwen35Recurrent(24, 32) },
    quality: 55, qualityNote: 'the dense Qwen 3.5 step above 4B',
  },
  {
    id: 'gpt-oss-20b',
    label: 'gpt-oss 20B',
    weights: {
      repo: 'ggml-org/gpt-oss-20b-GGUF', revision: 'ef9b12f2ff56c69cf32153a02784e7a3c88bf524',
      file: 'gpt-oss-20b-MXFP4.gguf', sizeBytes: 12_109_566_624,
      sha256: '27cd6c432c7672cb812a92f611cf3ba7bbc35928262bb1e1253ff4ee6ae35901',
    },
    architecture: 'gpt-oss', totalParamsB: 20.9, activeParamsB: 3.6, activeWeightBytes: 2_574_702_336, quantization: 'MXFP4',
    defaultContext: 65_536, maxContext: 131_072, license: 'apache-2.0',
    kv: {
      layers: 12, kvHeads: 8, keyLength: 64, valueLength: 64,
      sliding: { layers: 12, kvHeads: 8, keyLength: 64, valueLength: 64, window: 128 },
    },
    quality: 62, qualityNote: 'OpenAI reports about 60 on SWE-bench Verified',
  },
  {
    id: 'gemma-4-26b-a4b',
    label: 'Gemma 4 26B-A4B',
    weights: {
      repo: 'ggml-org/gemma-4-26B-A4B-it-GGUF', revision: 'bb4531cda34d1ea09d9814959ed4d5833cf2a4c8',
      file: 'gemma-4-26B-A4B-it-Q4_0.gguf', sizeBytes: 14_618_145_824,
      sha256: 'd208665ab1cd3a69f7a9a4bc59430e8448c8093d9b06334f566ac59d6d504a03',
    },
    projector: {
      repo: 'ggml-org/gemma-4-26B-A4B-it-GGUF', revision: 'bb4531cda34d1ea09d9814959ed4d5833cf2a4c8',
      file: 'mmproj-gemma-4-26B-A4B-it-Q8_0.gguf', sizeBytes: 806_408_320,
      sha256: 'cc4e855736da450bf1e162d8cccfe0ad685727d0c9e04ef7dd8d884f3121039b',
    },
    architecture: 'gemma4', totalParamsB: 25.2, activeParamsB: 3.8, activeWeightBytes: 2_558_837_816, quantization: 'Q4_0',
    defaultContext: 65_536, maxContext: 262_144, license: 'apache-2.0',
    kv: {
      layers: 5, kvHeads: 2, keyLength: 512, valueLength: 512,
      sliding: { layers: 25, kvHeads: 8, keyLength: 256, valueLength: 256, window: 1024 },
    },
    quality: 70, qualityNote: 'native function calling; 3.8B active of 25B',
  },
  {
    id: 'qwen3.6-35b-a3b',
    label: 'Qwen3.6 35B-A3B',
    weights: {
      repo: 'ggml-org/Qwen3.6-35B-A3B-GGUF', revision: 'baec3ebee244827cda0f4557eafa8b28f7545fa6',
      file: 'Qwen3.6-35B-A3B-Q4_K_M.gguf', sizeBytes: 20_419_565_568,
      sha256: '671e47e0ec53c665d048b98c3ecbfd5236b5ca9c3e02ed19fc8f81f7b85140c7',
    },
    projector: {
      repo: 'ggml-org/Qwen3.6-35B-A3B-GGUF', revision: 'baec3ebee244827cda0f4557eafa8b28f7545fa6',
      file: 'mmproj-Qwen3.6-35B-A3B-Q8_0.gguf', sizeBytes: 614_194_304,
      sha256: '904cbf8c8e876220066ab3bf676c7efa40f3da372276fdaf8b01d2fb2a37a51d',
    },
    architecture: 'qwen35moe', totalParamsB: 34.7, activeParamsB: 3, activeWeightBytes: 2_569_349_632, quantization: 'Q4_K_M',
    defaultContext: 65_536, maxContext: 262_144, license: 'apache-2.0',
    kv: { layers: 10, kvHeads: 2, keyLength: 256, valueLength: 256, recurrentStateBytes: qwen35Recurrent(30, 32) },
    quality: 82, qualityNote: 'SWE-bench Verified 73.4',
  },
  {
    // Pinned to the revision whose Q4_K_M was measured on the 8-core Zen 4
    // this was built on (97 tokens/s reading, 20 writing, tool calls work);
    // the repo re-uploaded the file 192 bytes larger afterwards.
    id: 'ornith-1.5-35b-a3b',
    label: 'Ornith 1.5 35B-A3B',
    weights: {
      repo: 'ornith-ai/Ornith-1.5-35B-A3B-GGUF', revision: '63d07eca3c975d65e050192cf7429658bafb0ac9',
      file: 'Ornith-1.5-35B-Q4_K_M.gguf', sizeBytes: 21_713_462_848,
      sha256: 'ca6ea26329c88b78ffd90a85163be2e746c2fafd1024f56db47e499f117f9a7f',
    },
    projector: {
      repo: 'ornith-ai/Ornith-1.5-35B-A3B-GGUF', revision: '63d07eca3c975d65e050192cf7429658bafb0ac9',
      file: 'mmproj-Ornith-1.5-35B-BF16.gguf', sizeBytes: 902_822_016,
      sha256: 'd9ce31026d1cb1f3f8d5152e2e2a014d9d2b302b6c93a7dc07bb0a0487f52837',
    },
    architecture: 'qwen35moe', totalParamsB: 35.5, activeParamsB: 3, activeWeightBytes: 2_016_506_368, quantization: 'Q4_K_M',
    defaultContext: 65_536, maxContext: 262_144, license: 'mit',
    kv: { layers: 10, kvHeads: 2, keyLength: 256, valueLength: 256, recurrentStateBytes: qwen35Recurrent(31, 32) },
    quality: 88, qualityNote: 'SWE-bench Verified 79, Terminal-Bench 2.1 67.8 (its card)',
  },
  {
    id: 'qwen3.8-27b',
    label: 'Qwen3.8 27B',
    weights: {
      repo: 'ggml-org/Qwen3.8-27B-GGUF', revision: '71bc7b627595dc8a91039addd9c791ae548d6747',
      file: 'Qwen3.8-27B-Q4_K_M.gguf', sizeBytes: 18_973_870_528,
      sha256: 'c600de0300ae8a0eb3a6c0b8b5561b8b96f16bd2c863c2a66c42de29d391a747',
    },
    projector: {
      repo: 'ggml-org/Qwen3.8-27B-GGUF', revision: '71bc7b627595dc8a91039addd9c791ae548d6747',
      file: 'mmproj-Qwen3.8-27B-Q8_0.gguf', sizeBytes: 629_247_008,
      sha256: '2e968a6af97ce35d8971890b257b9b7edabf20ad91450501fa53162a19ee33eb',
    },
    // Dense: every token reads all 27B, so on a CPU it is far below the
    // speed bar; it is here for GPUs with the memory for it.
    architecture: 'qwen35', totalParamsB: 26.9, activeParamsB: 26.9, activeWeightBytes: 18_247_714_816, quantization: 'Q4_K_M',
    defaultContext: 65_536, maxContext: 262_144, license: 'apache-2.0',
    kv: { layers: 16, kvHeads: 4, keyLength: 256, valueLength: 256, recurrentStateBytes: qwen35Recurrent(48, 48) },
    quality: 92, qualityNote: 'Terminal-Bench 2.1 73.0 (its card)',
  },
  // ---- higher-precision builds, for machines with memory to spare ----
  // Same models as above, so architecture, parameters, contexts and KV shape
  // are theirs; only the file and the bits per weight differ.
  {
    // Ornith at Q6_K: on a CPU a mixture of experts reads only its routed
    // experts per token, so 7.5 GB more file costs about a quarter of the
    // writing speed (still above the bar on dual-channel DDR5) and fits
    // where 48-64 GB of RAM leaves ~33 GB for models. Pinned to the same
    // revision as the Q4_K_M above: one conversion, measured together.
    id: 'ornith-1.5-35b-a3b-q6',
    label: 'Ornith 1.5 35B-A3B Q6_K',
    weights: {
      repo: 'ornith-ai/Ornith-1.5-35B-A3B-GGUF', revision: '63d07eca3c975d65e050192cf7429658bafb0ac9',
      file: 'Ornith-1.5-35B-Q6_K.gguf', sizeBytes: 29_208_731_200,
      sha256: '1c4e5bb98a74c89a5d93a2488b5748b7b331daf77f6dbb64bd9b2ff864b64eb3',
    },
    projector: {
      repo: 'ornith-ai/Ornith-1.5-35B-A3B-GGUF', revision: '63d07eca3c975d65e050192cf7429658bafb0ac9',
      file: 'mmproj-Ornith-1.5-35B-BF16.gguf', sizeBytes: 902_822_016,
      sha256: 'd9ce31026d1cb1f3f8d5152e2e2a014d9d2b302b6c93a7dc07bb0a0487f52837',
    },
    architecture: 'qwen35moe', totalParamsB: 35.5, activeParamsB: 3, quantization: 'Q6_K',
    defaultContext: 65_536, maxContext: 262_144, license: 'mit',
    kv: { layers: 10, kvHeads: 2, keyLength: 256, valueLength: 256, recurrentStateBytes: qwen35Recurrent(31, 32) },
    quality: 90, qualityNote: 'Ornith 1.5 35B-A3B at Q6_K; near-lossless against Q4_K_M',
  },
  {
    // Ornith at Q8_0: the most faithful build that is still fast on a
    // CPU; for 64 GB+ RAM, 48 GB cards and 64 GB+ Apple unified memory.
    id: 'ornith-1.5-35b-a3b-q8',
    label: 'Ornith 1.5 35B-A3B Q8_0',
    weights: {
      repo: 'ornith-ai/Ornith-1.5-35B-A3B-GGUF', revision: '63d07eca3c975d65e050192cf7429658bafb0ac9',
      file: 'Ornith-1.5-35B-Q8_0.gguf', sizeBytes: 37_802_149_120,
      sha256: '854cf83f80cd37a061ed86df1fa7201162e4e1fb820b91068cc12a11d2746c9e',
    },
    projector: {
      repo: 'ornith-ai/Ornith-1.5-35B-A3B-GGUF', revision: '63d07eca3c975d65e050192cf7429658bafb0ac9',
      file: 'mmproj-Ornith-1.5-35B-BF16.gguf', sizeBytes: 902_822_016,
      sha256: 'd9ce31026d1cb1f3f8d5152e2e2a014d9d2b302b6c93a7dc07bb0a0487f52837',
    },
    architecture: 'qwen35moe', totalParamsB: 35.5, activeParamsB: 3, quantization: 'Q8_0',
    defaultContext: 65_536, maxContext: 262_144, license: 'mit',
    kv: { layers: 10, kvHeads: 2, keyLength: 256, valueLength: 256, recurrentStateBytes: qwen35Recurrent(31, 32) },
    quality: 91, qualityNote: 'Ornith 1.5 35B-A3B at Q8_0',
  },
  {
    // Qwen3.8 27B at Q8_0: the strongest model here, at the precision a
    // 40-48 GB card or a 64 GB+ Mac can hold. Dense, so like its Q4_K_M it
    // is for GPUs; on a CPU it is further under the speed bar still.
    id: 'qwen3.8-27b-q8',
    label: 'Qwen3.8 27B Q8_0',
    weights: {
      repo: 'ggml-org/Qwen3.8-27B-GGUF', revision: '71bc7b627595dc8a91039addd9c791ae548d6747',
      file: 'Qwen3.8-27B-Q8_0.gguf', sizeBytes: 28_595_763_648,
      sha256: 'aab65c67ef0dad127960efef9247f1832bca105faa1c7a052cc039b223cf86a1',
    },
    projector: {
      repo: 'ggml-org/Qwen3.8-27B-GGUF', revision: '71bc7b627595dc8a91039addd9c791ae548d6747',
      file: 'mmproj-Qwen3.8-27B-Q8_0.gguf', sizeBytes: 629_247_008,
      sha256: '2e968a6af97ce35d8971890b257b9b7edabf20ad91450501fa53162a19ee33eb',
    },
    architecture: 'qwen35', totalParamsB: 26.9, activeParamsB: 26.9, quantization: 'Q8_0',
    defaultContext: 65_536, maxContext: 262_144, license: 'apache-2.0',
    kv: { layers: 16, kvHeads: 4, keyLength: 256, valueLength: 256, recurrentStateBytes: qwen35Recurrent(48, 48) },
    quality: 95, qualityNote: 'Qwen3.8 27B at Q8_0',
  },
];

/** Remote candidates are registered after the picker refreshes its cache. */
let remoteModels: readonly CatalogModel[] = [];
export function registerRemoteModels(models: readonly CatalogModel[]): void { remoteModels = models; }
try {
  const saved = JSON.parse(readFileSync(discoveredModelsFile(), 'utf8')) as { models?: CatalogModel[] };
  if (Array.isArray(saved.models)) remoteModels = saved.models.filter((model) =>
    model.discovered && model.id?.startsWith('hf:') && model.weights?.sha256?.match(/^[0-9a-f]{64}$/)
    && model.weights?.revision?.match(/^[0-9a-f]{40}$/) && model.weights.sizeBytes > 0);
} catch { /* A first run has no cache. */ }
export function allLocalModels(): readonly CatalogModel[] {
  const builtIn = new Set(LOCAL_MODEL_CATALOG.map((model) => `${model.weights.repo}/${model.weights.revision}/${model.weights.file}`));
  return [...LOCAL_MODEL_CATALOG, ...remoteModels.filter((model) =>
    !builtIn.has(`${model.weights.repo}/${model.weights.revision}/${model.weights.file}`))];
}
export function catalogModel(id: string): CatalogModel | undefined {
  return allLocalModels().find((model) => model.id === id);
}

/** How a session's local model is named on screen: the catalog label, or
 * nothing when the session has not settled on one (the engine picks on the
 * first turn) -- never a placeholder like "auto" standing in for a model. */
export function localModelLabel(id: string | null | undefined): string | undefined {
  return id ? catalogModel(id)?.label ?? id : undefined;
}

/** A model a user typed, from the built-ins or pinned Hub discoveries. */
export function resolveLocalModelId(typed: string): string {
  const wanted = typed.trim().toLowerCase();
  const model = allLocalModels().find((item) => item.id.toLowerCase() === wanted || item.label.toLowerCase() === wanted);
  if (!model) throw new Error(`"${typed.trim()}" is not a ClikCode Local model. Open /model to see models that fit this machine.`);
  return model.id;
}
