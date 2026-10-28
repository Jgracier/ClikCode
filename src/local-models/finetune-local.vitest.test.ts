import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_TRAINER_IMAGE, LOCAL_TRAINER_PY, containerScript, dockerRunArgs, fineTuneLocalModel, trainerConfig } from './finetune-local.js';
import { LLAMA_CPP_TAG } from './runtime.js';
import type { CatalogModel } from './catalog.js';

let root: string;
let dataset: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ftl-'));
  dataset = join(root, 'data.jsonl');
  await writeFile(dataset, '{"messages":[]}\n');
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const FAKE_MODEL = { id: 'tuned:bot', label: 'bot (tuned)', weights: { sizeBytes: 5 } } as unknown as CatalogModel;
const mount = (args: string[], target: string): string => { const i = args.findIndex((a) => a.endsWith(`:${target}`) || a.endsWith(`:${target}:ro`)); return args[i]!.split(':')[0]!; };

describe('what runs in the container', () => {
  it('installs the libraries, converts with the converter at the runtime\'s own tag, and hands the files back, stopping at the first failure', () => {
    const script = containerScript();
    const lines = script.split('\n');
    expect(lines[0]).toBe('set -e');
    const at = (text: string) => lines.findIndex((line) => line.includes(text));
    expect(at('pip install -q torch --index-url https://download.pytorch.org/whl/cpu')).toBeGreaterThan(0);
    // The converter is run from a clone of its own tag (it imports a package beside it), with that tag's gguf-py.
    expect(script).toContain(`git clone -q --depth 1 --branch ${LLAMA_CPP_TAG} https://github.com/ggml-org/llama.cpp /tmp/llama.cpp`);
    expect(script).toContain('/tmp/llama.cpp/gguf-py');
    expect(at('cpu_trainer.py')).toBeLessThan(at('/tmp/llama.cpp/convert_hf_to_gguf.py /out/run/merged'));
    expect(script).toContain('--outtype q8_0');
    // The MTP layer is left out when the architecture allows it (the merged text model has none), else the plain conversion runs.
    expect(lines).toContain('$CONVERT --no-mtp || $CONVERT');
    expect(at('chown -R')).toBeLessThan(at('CLIK_TRAINING_COMPLETE'));
    expect(lines.at(-1)).toBe('echo CLIK_TRAINING_COMPLETE');
  });

  it('is the trainer ClikDeploy runs: same log contract, honours a CPU quota, no characters that break a template string', () => {
    expect(LOCAL_TRAINER_PY).toContain("{'loss': %.4f, 'learning_rate': %g, 'epoch': %.2f}");
    expect(LOCAL_TRAINER_PY).toContain('[ft] cpu-trainer');
    expect(LOCAL_TRAINER_PY).toContain('/sys/fs/cgroup/cpu.max');
    expect(LOCAL_TRAINER_PY).not.toMatch(/`|\$\{/);
  });

  it('is run with the data read-only, the CPUs it may use, the caches kept between runs, and the token only when there is one', () => {
    const config = trainerConfig({ base: 'Qwen/Qwen3.5-0.8B' }, 'data.jsonl');
    const args = dockerRunArgs({ name: 'n', workDir: '/w', cacheDir: '/c', cpus: 12, config, uid: 1000, gid: 1001 });
    expect(args.slice(0, 6)).toEqual(['run', '--rm', '--name', 'n', '--cpus', '12']);
    expect(args).toEqual(expect.arrayContaining(['/w/in:/in:ro', '/w/out:/out', '/c:/cache', 'HOST_UID=1000', 'HOST_GID=1001']));
    expect(args.some((arg) => arg.startsWith('HF_TOKEN='))).toBe(false);
    expect(JSON.parse(Buffer.from(args.find((arg) => arg.startsWith('FT_CONFIG='))!.slice(10), 'base64').toString())).toEqual(config);
    expect(args.slice(-4, -2)).toEqual([LOCAL_TRAINER_IMAGE, 'bash']);
    expect(dockerRunArgs({ name: 'n', workDir: '/w', cacheDir: '/c', cpus: 0, config, uid: 1, gid: 1, hfToken: 'hf_x' })).toEqual(expect.arrayContaining(['HF_TOKEN=hf_x', '1']));
  });

  it('reads a CSV as CSV and anything else as lines of JSON, with CPU-sized defaults', () => {
    expect(trainerConfig({ base: 'a/b' }, 'x.csv')).toEqual({ baseModelId: 'a/b', datasetFormat: 'CSV', hyperparams: { epochs: 2, loraRank: 8, loraAlpha: 16, learningRate: 0.0002, sequenceLen: 512 } });
    expect(trainerConfig({ base: 'a/b', epochs: 3, loraRank: 16 }, 'x.JSONL')).toMatchObject({ datasetFormat: 'JSONL_TEXT', hyperparams: { epochs: 3, loraRank: 16, loraAlpha: 32 } });
  });
});

describe('fine-tuning on this computer', () => {
  it('runs the container, registers the GGUF it made, shows only the lines that matter, and leaves no scratch behind', async () => {
    const shown: string[] = [];
    const register = vi.fn(async () => FAKE_MODEL);
    const docker = vi.fn(async (args: string[], onLine: (line: string) => void) => {
      onLine('Collecting torch'); onLine('[ft] cpu-trainer: Qwen/Qwen3.5-0.8B'); onLine('  5%|          | 1/20 [00:36<11:34, 36.6s/it]'); onLine('{\'loss\': 3.5, \'epoch\': 0.05}'); onLine('CLIK_TRAINING_COMPLETE');
      await writeFile(join(mount(args, '/out'), 'model.gguf'), 'weights');
      expect(await readFile(join(mount(args, '/trainer'), 'cpu_trainer.py'), 'utf8')).toBe(LOCAL_TRAINER_PY);
      expect((await readFile(join(mount(args, '/in'), 'dataset'), 'utf8'))).toContain('messages');
      return 0;
    });
    let clock = 1_000;
    const result = await fineTuneLocalModel({ dataset, base: 'Qwen/Qwen3.5-0.8B', name: 'bot', epochs: 1 }, { docker, register, progress: (line) => shown.push(line), workRoot: root, now: () => (clock += 90_000) });
    expect(result).toEqual({ model: FAKE_MODEL, seconds: 90 });
    expect(register).toHaveBeenCalledWith({ name: 'bot', ggufPath: expect.stringMatching(/out\/model\.gguf$/) });
    expect(shown).toEqual(expect.arrayContaining(['[ft] cpu-trainer: Qwen/Qwen3.5-0.8B', '5%|          | 1/20 [00:36<11:34, 36.6s/it]', 'CLIK_TRAINING_COMPLETE', 'registering the model']));
    expect(shown).not.toContain('Collecting torch');
    expect((await readdir(root)).sort()).toEqual(['cache', 'data.jsonl']);
  });

  it('fails with what the container last said, registers nothing, and still cleans up', async () => {
    const register = vi.fn();
    const docker = async (_args: string[], onLine: (line: string) => void) => { onLine('ERROR: No matching distribution found for torch'); return 1; };
    await expect(fineTuneLocalModel({ dataset, base: 'a/b', name: 'bot' }, { docker, register, progress: () => {}, workRoot: root }))
      .rejects.toThrow(/docker exit 1[\s\S]*No matching distribution/);
    expect(register).not.toHaveBeenCalled();
    expect((await readdir(root)).sort()).toEqual(['cache', 'data.jsonl']);
  });

  it('refuses a run that ends with no GGUF, a base that is not a Hugging Face repo, a missing dataset and a bad epoch count, before any container starts', async () => {
    const register = vi.fn();
    await expect(fineTuneLocalModel({ dataset, base: 'a/b', name: 'bot' }, { docker: async () => 0, register, progress: () => {}, workRoot: root })).rejects.toThrow(/without a GGUF/);
    const never = vi.fn();
    const deps = { docker: never, register, progress: () => {}, workRoot: root };
    await expect(fineTuneLocalModel({ dataset, base: 'unsloth.gguf', name: 'bot' }, deps)).rejects.toThrow(/Hugging Face model repo/);
    await expect(fineTuneLocalModel({ dataset: join(root, 'no.jsonl'), base: 'a/b', name: 'bot' }, deps)).rejects.toThrow(/No dataset file/);
    await expect(fineTuneLocalModel({ dataset, base: 'a/b', name: 'bot', epochs: 11 }, deps)).rejects.toThrow(/--epochs/);
    expect(never).not.toHaveBeenCalled();
    expect((await stat(root)).isDirectory()).toBe(true);
  });
});
