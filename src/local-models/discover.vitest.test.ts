import { describe, expect, it } from 'vitest';
import { GGMLQuantizationType, type GGUFParseOutput } from '@huggingface/gguf';
import { remoteModelFromHeader, TENSOR_LAYOUT } from './discover';

const repo = {
  id: 'example/model-GGUF', sha: 'a'.repeat(40), cardData: { license: 'apache-2.0' },
};
const file = {
  rfilename: 'model-Q4_K_M.gguf', lfs: { sha256: 'b'.repeat(64), size: 1_000_000_000 },
};
const header = {
  metadata: {
    'general.architecture': 'qwen35moe', 'qwen35moe.block_count': 8,
    'qwen35moe.context_length': 65_536, 'qwen35moe.attention.head_count_kv': 2,
    'qwen35moe.attention.key_length': 128, 'qwen35moe.attention.value_length': 128,
    'qwen35moe.full_attention_interval': 4, 'qwen35moe.ssm.inner_size': 256,
    'qwen35moe.ssm.state_size': 128, 'qwen35moe.ssm.group_count': 2, 'qwen35moe.expert_count': 4,
    'qwen35moe.expert_used_count': 1, 'tokenizer.chat_template': '{% if tools %}tool_call{% endif %}',
  },
  tensorInfos: [
    { name: 'output.weight', shape: [100n], dtype: GGMLQuantizationType.F16 },
    { name: 'token_embd.weight', shape: [100n], dtype: GGMLQuantizationType.F16 },
    { name: 'blk.0.ffn_up_exps.weight', shape: [1024n], dtype: GGMLQuantizationType.Q4_K },
  ],
} as GGUFParseOutput;

describe('remote GGUF candidates', () => {
  it('uses header geometry and active expert tensors while keeping a pinned hash', () => {
    const model = remoteModelFromHeader(repo, file, header)!;
    expect(model.kv.layers).toBe(2);
    expect(model.kv.recurrentStateBytes).toBeGreaterThan(0);
    expect(model.totalParamsB * 1e9).toBe(1224);
    expect(model.activeParamsB * 1e9).toBe(356);
    expect(model.activeWeightBytes).toBe(344);
    expect(model.weights).toMatchObject({ revision: repo.sha, sha256: file.lfs.sha256 });
  });

  it('rejects a header whose attention shape or tool template cannot be established', () => {
    expect(remoteModelFromHeader(repo, file, { ...header, metadata: { ...header.metadata, 'general.architecture': 'unknown' } } as GGUFParseOutput)).toBeUndefined();
    expect(remoteModelFromHeader(repo, file, { ...header, metadata: { ...header.metadata, 'tokenizer.chat_template': 'plain text' } } as GGUFParseOutput)).toBeUndefined();
  });
});

describe('the tensor layout table', () => {
  it('uses the ggml type ids of @huggingface/gguf', () => {
    const G = GGMLQuantizationType;
    expect([...TENSOR_LAYOUT.keys()].sort((a, b) => a - b)).toEqual(
      [G.F32, G.F16, G.Q4_0, G.Q4_1, G.Q5_0, G.Q5_1, G.Q8_0, G.Q8_1, G.Q2_K, G.Q3_K, G.Q4_K, G.Q5_K, G.Q6_K, G.Q8_K, G.BF16, G.MXFP4].sort((a, b) => a - b));
    expect(TENSOR_LAYOUT.get(G.Q4_K)).toEqual([144, 256]);
    expect(TENSOR_LAYOUT.get(G.MXFP4)).toEqual([17, 32]);
    expect(TENSOR_LAYOUT.get(G.BF16)).toEqual([2, 1]);
  });
});
