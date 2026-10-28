/** Fine-tune a model on this computer and use it again here, the way a cloud fine-tune is made and used on ClikDeploy.
 *
 * The trainer runs in a container (Docker) on this machine's CPU: PyTorch + PEFT LoRA in fp32, then the merged weights are converted to
 * GGUF with llama.cpp's own converter at the tag of the runtime ClikCode runs (so the file is one that runtime reads), and registered
 * as the local model `tuned:<name>` (tuned.ts). Nothing leaves the machine except the downloads (the base model from Hugging Face, the
 * trainer's Python packages, the converter script); the dataset stays here.
 *
 * It is the same trainer as ClikDeploy's CPU fine-tune (platform-domains training/cpu-trainer.ts) and a COPY of its script: ClikDeploy's
 * is the source, and `LOCAL_TRAINER_PY` here must match it (the shared-fit-lib sync is the way to make that automatic; until then a
 * change to one is a change to both).
 *
 * Small models only, and slow: a CPU trains a 0.5B model at about 2 tokens a second. The base is a Hugging Face repo (safetensors), not
 * a GGUF. */

import { spawn } from 'node:child_process';
import { quiet } from '../runtime/lifecycle-log.js';
import { availableParallelism } from 'node:os';
import { copyFile, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { LLAMA_CPP_TAG } from './runtime.js';
import { fineTuneDir } from './paths.js';
import { registerTunedModel, type RegisterTunedInput } from './tuned.js';
import type { CatalogModel } from './catalog.js';

/** A full Debian Python image: it has git, curl and a compiler for the packages, pinned to the OS release. */
export const LOCAL_TRAINER_IMAGE = 'python:3.12-bookworm';

/** The trainer's Python source (a copy of ClikDeploy's cpu-trainer.ts CPU_TRAINER_PY). */
export const LOCAL_TRAINER_PY = String.raw`"""CPU LoRA fine-tune: the trainer a CPU task runs (training/cpu-trainer.ts).

Reads FT_CONFIG (base64 JSON), the dataset at DATASET_PATH, trains a LoRA adapter on the CPU, merges it into the base weights and
saves them half-precision under OUT_DIR/merged. Its log is the trainer log contract (parseTrainingProgress): a {'loss': L, 'epoch': E}
line per step, a N/M [ step counter with a percent bar, and nothing printed as Traceback unless it failed.
"""
import base64, csv, json, math, os, sys, time

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer
from peft import LoraConfig, get_peft_model

cfg = json.loads(base64.b64decode(os.environ["FT_CONFIG"]).decode("utf-8"))
hp = cfg["hyperparams"]
base = cfg["baseModelId"]
fmt = cfg.get("datasetFormat", "JSONL_TEXT")
dataset_path = os.environ.get("DATASET_PATH", "/tmp/dataset.jsonl")
out_dir = os.environ.get("OUT_DIR", "/out/run")
seq_len = int(hp.get("sequenceLen", 1024))
epochs = int(hp.get("epochs", 1))
lr = float(hp.get("learningRate", 2e-4))
rank = int(hp.get("loraRank", 16))
alpha = int(hp.get("loraAlpha", rank * 2))
token = os.environ.get("HF_TOKEN") or None


def usable_cpus():
    """The CPUs this process may use: its affinity, capped by a container's CPU quota (os.cpu_count() sees the whole host)."""
    n = len(os.sched_getaffinity(0)) if hasattr(os, "sched_getaffinity") else (os.cpu_count() or 1)
    try:
        quota, period = open("/sys/fs/cgroup/cpu.max").read().split()
        if quota != "max":
            n = min(n, max(1, int(int(quota) / int(period))))
    except (OSError, ValueError):
        pass
    return max(1, n)


torch.set_num_threads(usable_cpus())
torch.manual_seed(0)

print(f"[ft] cpu-trainer: {base}, LoRA rank {rank}, {epochs} epoch(s), {torch.get_num_threads()} threads", flush=True)
tok = AutoTokenizer.from_pretrained(base, token=token)
if tok.pad_token is None:
    tok.pad_token = tok.eos_token


def rows():
    with open(dataset_path, newline="", encoding="utf-8") as fh:
        if fmt == "CSV":
            yield from csv.DictReader(fh)
        else:
            for line in fh:
                line = line.strip()
                if line:
                    yield json.loads(line)


def text_of(row):
    if isinstance(row.get("messages"), list):
        if getattr(tok, "chat_template", None):
            return tok.apply_chat_template(row["messages"], tokenize=False)
        return "\n".join(f"{m.get('role', 'user')}: {m.get('content', '')}" for m in row["messages"])
    if "prompt" in row and "completion" in row:
        return f"{row['prompt']}{row['completion']}"
    return str(row.get("text") or next(iter(row.values()), ""))


examples = []
for row in rows():
    ids = tok(text_of(row), truncation=True, max_length=seq_len, return_tensors="pt")["input_ids"][0]
    if len(ids) > 1:
        examples.append(ids)
if not examples:
    print("[ft] the dataset has no usable rows", file=sys.stderr, flush=True)
    sys.exit(2)

model = AutoModelForCausalLM.from_pretrained(base, torch_dtype=torch.float32, token=token)
model = get_peft_model(model, LoraConfig(r=rank, lora_alpha=alpha, lora_dropout=0.05, target_modules="all-linear", task_type="CAUSAL_LM"))
model.train()
opt = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=lr)

total = len(examples) * epochs
step = 0
started = time.time()
for epoch in range(epochs):
    order = torch.randperm(len(examples)).tolist()
    for index in order:
        ids = examples[index].unsqueeze(0)
        loss = model(input_ids=ids, labels=ids).loss
        loss.backward()
        opt.step()
        opt.zero_grad()
        step += 1
        done = step / total
        elapsed = time.time() - started
        eta = elapsed / step * (total - step)
        bar = "#" * int(done * 10)
        print(f"{int(done * 100):3d}%|{bar:<10}| {step}/{total} [{int(elapsed // 60):02d}:{int(elapsed % 60):02d}<{int(eta // 60):02d}:{int(eta % 60):02d}, {elapsed / step:.1f}s/it]", flush=True)
        print("{'loss': %.4f, 'learning_rate': %g, 'epoch': %.2f}" % (loss.item(), lr, step / len(examples)), flush=True)

print("[ft] Merging the adapter into the base weights", flush=True)
model = model.merge_and_unload().to(torch.float16)
merged = os.path.join(out_dir, "merged")
os.makedirs(merged, exist_ok=True)
model.save_pretrained(merged, safe_serialization=True)
tok.save_pretrained(merged)
print(f"[ft] saved {merged}", flush=True)
`;

export interface LocalFineTuneInput {
  /** The training data: JSONL (chat `messages`, `prompt`/`completion`, or `text`) or CSV. */
  dataset: string;
  /** The base model's Hugging Face repo (safetensors), e.g. Qwen/Qwen2.5-0.5B-Instruct. */
  base: string;
  /** The name the tuned model is chosen by. */
  name: string;
  epochs?: number;
  loraRank?: number;
  license?: RegisterTunedInput['license'];
}

export interface LocalFineTuneDeps {
  /** Runs `docker <args>`, calling `onLine` for each output line; resolves its exit code. */
  docker?: (args: string[], onLine: (line: string) => void) => Promise<number>;
  register?: (input: RegisterTunedInput) => Promise<CatalogModel>;
  progress?: (line: string) => void;
  /** Where scratch goes (default: under the local-models home). */
  workRoot?: string;
  now?: () => number;
}

const HF_REPO = /^[\w.-]+\/[\w.-]+$/;

/** The training config the trainer reads (FT_CONFIG). Pure. */
export function trainerConfig(input: Pick<LocalFineTuneInput, 'base' | 'epochs' | 'loraRank'>, datasetPath: string): { baseModelId: string; datasetFormat: 'CSV' | 'JSONL_TEXT'; hyperparams: Record<string, number> } {
  const rank = input.loraRank ?? 8;
  return {
    baseModelId: input.base,
    datasetFormat: datasetPath.toLowerCase().endsWith('.csv') ? 'CSV' : 'JSONL_TEXT',
    hyperparams: { epochs: input.epochs ?? 2, loraRank: rank, loraAlpha: rank * 2, learningRate: 0.0002, sequenceLen: 512 },
  };
}

/** What runs in the container: the libraries, the trainer, the GGUF converter at the runtime's tag, the file's owner put back. Pure. */
export function containerScript(tag: string = LLAMA_CPP_TAG): string {
  return [
    'set -e',
    'export HF_HOME=/cache/hf PIP_CACHE_DIR=/cache/pip',
    'mkdir -p /out/run',
    'echo "[ft] installing the trainer libraries"',
    'pip install -q torch --index-url https://download.pytorch.org/whl/cpu',
    // The whole tag, not one script: the converter imports a package beside it (found live: "No module named 'conversion'"), and gguf-py
    // from the same tag is the writer that converter was made for.
    `git clone -q --depth 1 --branch ${tag} https://github.com/ggml-org/llama.cpp /tmp/llama.cpp`,
    'pip install -q transformers peft accelerate numpy sentencepiece protobuf /tmp/llama.cpp/gguf-py',
    'DATASET_PATH=/in/dataset OUT_DIR=/out/run python -u /trainer/cpu_trainer.py',
    'echo "[ft] converting to GGUF"',
    // Without the speculative-decoding (MTP) layer: the trainer loads the text model only, so the merged weights have none, and a file that
    // declares one it lacks does not load (found live: "tensor 'blk.24.attn_norm.weight' not found"). Not every architecture takes the flag.
    'CONVERT="python /tmp/llama.cpp/convert_hf_to_gguf.py /out/run/merged --outfile /out/model.gguf --outtype q8_0"',
    '$CONVERT --no-mtp || $CONVERT',
    'rm -rf /out/run',
    'chown -R "$HOST_UID:$HOST_GID" /out',
    'echo CLIK_TRAINING_COMPLETE',
  ].join('\n');
}

/** The `docker run` for it. Pure. */
export function dockerRunArgs(input: { name: string; workDir: string; cacheDir: string; cpus: number; config: unknown; uid: number; gid: number; hfToken?: string }): string[] {
  return [
    'run', '--rm', '--name', input.name, '--cpus', String(Math.max(1, input.cpus)),
    '-v', `${join(input.workDir, 'in')}:/in:ro`, '-v', `${join(input.workDir, 'out')}:/out`,
    '-v', `${join(input.workDir, 'trainer')}:/trainer:ro`, '-v', `${input.cacheDir}:/cache`,
    '-e', `FT_CONFIG=${Buffer.from(JSON.stringify(input.config), 'utf8').toString('base64')}`,
    '-e', `HOST_UID=${input.uid}`, '-e', `HOST_GID=${input.gid}`,
    ...(input.hfToken ? ['-e', `HF_TOKEN=${input.hfToken}`] : []),
    LOCAL_TRAINER_IMAGE, 'bash', '-c', containerScript(),
  ];
}

function runDocker(args: string[], onLine: (line: string) => void): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let carry = '';
    const feed = (chunk: Buffer): void => {
      const lines = (carry + chunk.toString('utf8')).split(/\r?\n|\r/);
      carry = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) onLine(line);
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.once('error', (error: NodeJS.ErrnoException) => reject(error.code === 'ENOENT' ? new Error('Docker is needed to fine-tune on this computer and was not found. Install Docker, or fine-tune in the cloud with `gateway finetune`.') : error));
    child.once('close', (code) => { if (carry.trim()) onLine(carry); resolve(code ?? 1); });
  });
}

/** The lines worth showing: the stage markers and the trainer's step counter, not the library output. */
function worthShowing(line: string): boolean {
  return /^\[ft\]/.test(line) || /\d+\/\d+ \[/.test(line) || /CLIK_TRAINING_COMPLETE|Traceback|Error/.test(line);
}

export async function fineTuneLocalModel(input: LocalFineTuneInput, deps: LocalFineTuneDeps = {}): Promise<{ model: CatalogModel; seconds: number }> {
  if (!HF_REPO.test(input.base)) throw new Error('--base must be a Hugging Face model repo, e.g. Qwen/Qwen2.5-0.5B-Instruct (the original weights, not a GGUF).');
  if (!(await stat(input.dataset).catch(quiet('local-models/finetune-local')))?.isFile()) throw new Error(`No dataset file at ${input.dataset}.`);
  if (input.epochs !== undefined && (!Number.isInteger(input.epochs) || input.epochs < 1 || input.epochs > 10)) throw new Error('--epochs must be a whole number from 1 to 10');
  const progress = deps.progress ?? ((line: string) => { process.stderr.write(`${line}\n`); });
  const docker = deps.docker ?? runDocker;
  const register = deps.register ?? ((registration: RegisterTunedInput) => registerTunedModel(registration));
  const now = deps.now ?? Date.now;
  const started = now();

  const root = deps.workRoot ?? fineTuneDir();
  const workDir = join(root, `run-${input.name}-${started}`);
  const cacheDir = join(root, 'cache');
  await Promise.all(['in', 'out', 'trainer'].map((dir) => mkdir(join(workDir, dir), { recursive: true })));
  await mkdir(join(cacheDir, 'hf'), { recursive: true });
  await mkdir(join(cacheDir, 'pip'), { recursive: true });
  try {
    await copyFile(input.dataset, join(workDir, 'in', 'dataset'));
    await writeFile(join(workDir, 'trainer', 'cpu_trainer.py'), LOCAL_TRAINER_PY);
    progress(`fine-tuning ${input.base} on this computer (CPU): ${basename(input.dataset)}`);
    const args = dockerRunArgs({
      name: `clikcode-finetune-${input.name}`, workDir, cacheDir, cpus: availableParallelism(), config: trainerConfig(input, input.dataset),
      uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0, ...(process.env.HF_TOKEN ? { hfToken: process.env.HF_TOKEN } : {}),
    });
    const lines: string[] = [];
    const code = await docker(args, (line) => { lines.push(line); if (lines.length > 40) lines.shift(); if (worthShowing(line)) progress(line.trim()); });
    if (code !== 0) throw new Error(`The fine-tune failed (docker exit ${code}). The last output:\n${lines.slice(-8).join('\n')}`);
    const gguf = join(workDir, 'out', 'model.gguf');
    if (!(await stat(gguf).catch(quiet('local-models/finetune-local')))?.isFile()) throw new Error('The fine-tune finished without a GGUF to register.');
    progress('registering the model');
    const model = await register({ name: input.name, ggufPath: gguf, ...(input.license ? { license: input.license } : {}) });
    return { model, seconds: Math.round((now() - started) / 1000) };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(quiet('local-models/finetune-local'));
  }
}
